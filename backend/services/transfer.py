"""Transfert vers le telephone : sessions courtes sur le reseau local.

Le code QR affiche par le bureau ne transporte **pas** la playlist : il porte une
cle (identifiant de session + jeton). Le telephone demande ensuite le manifeste,
puis les fichiers un par un.

Pourquoi ce detour plutot qu'une liste dans le code : un QR ne tient que ~2,9 Ko,
alors qu'une URL audio signee pese deja 1 a 2 Ko. Le code reste donc court (~50
caracteres), donc facile a scanner de loin — et il n'y a **rien a extraire cote
telephone** : le bureau sert ce qu'il a (cache RAM) ou ce qu'il va chercher une
fois.

Securite : seule la machine locale peut *creer* une session (le navigateur du
bureau), et le jeton n'est valable que quelques minutes. Le code est donc une cle
d'acces temporaire au reseau local, pas un droit permanent.
"""
import json
import os
import secrets
import socket
import threading
import time
import urllib.request

from core.config import (  # noqa: F401  (PORT vient de l'environnement, comme ailleurs)
    BASE,
)
from services import audiocache, covers, preparation, state
from services.audio import _resolve_audio_url
from services.db_access import _meta
from services.playlists import _find

# Debit annonce du flux audio YouTube, en bits par seconde : le telephone s'en
# sert pour estimer un poids avant d'avoir la taille exacte. Aucune requete n'est
# faite pour « deviner » un poids : la taille reelle arrive avec la preparation.
DEBIT_ESTIME = 16000
# Types servis au telephone, par contenant.
TYPES_AUDIO = {"m4a": "audio/mp4", "webm": "audio/webm", "opus": "audio/ogg"}
# Adresse de l'ordinateur vue depuis l'emulateur Android.
HOTE_EMULATEUR = "10.0.2.2"

# Une session vit le temps de scanner, de lire le manifeste et de transferer une
# playlist entiere : large, mais borne.
SESSION_TTL = 20 * 60
# Le transfert ne doit pas genouiller la lecture en cours (regle numero un du
# projet) : un seul envoi a la fois, et l'octet venu du reseau n'est jamais relu.
PROXY_TIMEOUT = 20.0
CHUNK = 512 * 1024

_PORT = int(__import__("os").environ.get("NEUROBEATS_PORT", "8000"))

_lock = threading.RLock()
# session -> {token, playlist_id, name, created, tracks: [...], touch: float}
_sessions: dict = {}


def _log(msg: str):
    print(f"  [transfert] {msg}", flush=True)


def _local_ip() -> str:
    """Adresse IPv4 que le telephone peut joindre (celle du reseau, pas 127.0.0.1).

    On ouvre un socket UDP vers une adresse publique : aucune donnee n'est
    envoyee, mais le noyau choisit l'interface de sortie, ce qui donne l'adresse
    locale reellement routable. Repli sur localhost si la machine est hors ligne.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


def _touch(entry: dict):
    """Rafraichit l'horloge de la session : un transfert long ne meurt pas en route."""
    with _lock:
        entry["touch"] = time.time()


def _purge():
    """Retire les sessions inactives (appele a chaque usage, pas de thread).

    C'est la **derniere activite** qui fait foi (`touch`), pas la creation : un
    transfert qui dure plus longtemps que SESSION_TTL doit survivre tant que le
    telephone continue de demander des fichiers. Sans cela, un titre prepare apres
    le delai initial rendait un 404 « session expiree ». En pleine copie.
    """
    now = time.time()
    with _lock:
        for session in [s for s, e in _sessions.items() if now - e["touch"] > SESSION_TTL]:
            _sessions.pop(session, None)


def _relai_disponible(video_id: str) -> bool:
    """Une source de relais est-elle reellement serviable ?

    La preparation a echoue mais le cache du moteur (resolution yt-dlp deja
    faite) porte encore un URL direct : c'est la seule facon de servir l'original
    sans inventer une URL morte qui figerait le titre en attente chez le telephone.
    """
    cached = state.STREAM_CACHE.get(video_id) or {}
    return bool(cached.get("url"))


def _tracks_of(playlist: dict) -> list:
    """Titres du manifeste, avec ce que le telephone doit savoir avant d'agir.

    Chaque titre est **demande en preparation** : le bureau le recupere une fois,
    l'etiquette (titre, artiste, pochette) puis le sert depuis son disque. Le
    telephone voit donc l'etat reel — pret, en preparation, en erreur — et peut
    annoncer l'attente au lieu de la subir.

    Si la preparation est desactivee, on retombe sur le relais du flux d'origine :
    le titre part tout de suite, mais sans etiquettes.
    """
    out = []
    for song in playlist.get("songs") or []:
        video_id = (song or {}).get("video_id") or ""
        if not video_id:
            continue
        meta = state.LAST_SEARCH.get(video_id) or _meta(video_id) or {}
        cached = state.STREAM_CACHE.get(video_id) or {}
        # La duree alimente le budget d'attente du telephone : sans elle, un
        # titre encore inconnu du bureau pese 0 et se fait abandonner au bout de
        # 90 s, avant meme qu'un worker ne le prenne. On la cherche donc partout
        # ou elle est connue, la playlist en comprise.
        duration = (preparation.duree(video_id) or cached.get("duration")
                    or meta.get("duration") or song.get("duration"))
        titre = song.get("title") or meta.get("title") or ""
        chaine = song.get("channel") or meta.get("channel") or ""
        if preparation.ACTIF:
            etat = preparation.demander(video_id, {
                "titre": titre, "chaine": chaine,
                "album": playlist.get("name", ""), "annee": "",
            })
            fichier = preparation.chemin(video_id)
            if etat == "erreur":
                if _relai_disponible(video_id):
                    # Preparation ratee mais source du moteur encore valide : on
                    # sert l'original plutot que rien.
                    etat, format_audio = "pret", "webm"
                else:
                    format_audio = "m4a"  # inutilise : l'etat erreur domine
            elif fichier:
                etat = "pret"
                format_audio = preparation.format_de(video_id) or "webm"
            else:
                format_audio = "m4a"
        else:
            etat, format_audio = "pret", "webm"
        out.append({
            "video_id": video_id,
            "titre": titre,
            "chaine": chaine,
            "duree": duration,
            "etat": etat,
            "taille": preparation.taille(video_id),
            "format": format_audio,
            "pret": bool(preparation.chemin(video_id)),
        })
    return out


def create(playlist_id: str, mode: str = "") -> str:
    """Ouvre une session de transfert pour une playlist et rend le code a afficher.

    `mode="emulateur"` remplace l'adresse locale par celle que l'emulateur Android
    voit (`10.0.2.2`) : la verification de bout en bout reste alors possible sans
    telephone.

    Returns:
        JSON {session, url, expire, playlist, titres, prets, a_preparer} ou
        {error}.
    """
    _purge()
    playlist = _find(playlist_id or "")
    if playlist is None:
        return json.dumps({"error": f"Playlist '{playlist_id}' introuvable."},
                          ensure_ascii=False)
    tracks = _tracks_of(playlist)
    if not tracks:
        return json.dumps({"error": f"La playlist '{playlist.get('name', '')}' est vide."},
                          ensure_ascii=False)

    session = secrets.token_urlsafe(5).replace("-", "").replace("_", "")[:8]
    token = secrets.token_urlsafe(24)
    created = time.time()
    with _lock:
        _sessions[session] = {
            "token": token,
            "playlist_id": playlist.get("id", ""),
            "name": playlist.get("name", ""),
            "created": created,
            "touch": created,
            "tracks": tracks,
        }
    prets = sum(1 for t in tracks if t["etat"] == "pret")
    hote = HOTE_EMULATEUR if mode == "emulateur" else _local_ip()
    url = f"http://{hote}:{_PORT}/t/{session}?k={token}"
    _log(f"session {session} pour « {playlist.get('name', '')} » : "
         f"{len(tracks)} titre(s), dont {prets} deja en memoire")
    return json.dumps({
        "session": session,
        "url": url,
        "expire_dans": SESSION_TTL,
        "playlist": playlist.get("name", ""),
        "titres": len(tracks),
        "prets": prets,
        "a_preparer": len(tracks) - prets,
    }, ensure_ascii=False)


def _authorized(session: str, token: str) -> dict | None:
    """Session correspondant au jeton, ou None (inconnue, expiree, mauvais jeton).

    Une session valide est **touchee** ici : toute interrogation ou tout
    telechargement la garde en vie (voir `_purge`).
    """
    _purge()
    entry = _sessions.get(session)
    if entry is None or not token:
        return None
    # Comparaison a temps constant : le jeton circule dans une URL.
    if not secrets.compare_digest(entry["token"], token):
        return None
    _touch(entry)
    return entry


def manifest(session: str, token: str) -> str:
    """Ce que le telephone doit telecharger, tel qu'il le lira.

    Les URLs sont construites ici (et non devinees par le telephone) : le client
    n'a qu'a suivre ce que le bureau lui donne.
    """
    entry = _authorized(session, token)
    if entry is None:
        return json.dumps({"error": "Session inconnue ou expiree."}, ensure_ascii=False)
    base = f"/t/{session}/a"
    pochettes = f"/t/{session}/c"
    return json.dumps({
        "version": 1,
        "playlist": entry["name"],
        "playlist_id": entry["playlist_id"],
        "expire_dans": int(SESSION_TTL - (time.time() - entry["touch"])),
        "debit_estime": DEBIT_ESTIME,
        "pistes": [_piste_en_directe(track, base, pochettes, token)
                   for track in entry["tracks"]],
    }, ensure_ascii=False)


def _piste_en_directe(track: dict, base: str, pochettes: str, token: str) -> dict:
    """La vue fraiche d'un titre a l'instant du manifeste.

    Le telephone re-poll le manifeste jusqu'au « pret » : recalculer l'etat a
    chaque appel (au lieu de la valeur figee a l'ouverture du ticket) permet de
    dire quand le disque du bureau est enfin prete. Sans ce calcul, un titre
    prepare apres l'ouverture du ticket restait « en preparation » pour toujours.
    """
    video_id = track["video_id"]
    etat = preparation.etat(video_id)
    format_audio = track.get("format", "m4a")
    if etat == "absent":
        # On ne fait pas semblant : on (re)declenche la preparation si elle n'a
        # jamais abouti, sinon on annonce l'attente au telephone.
        etat = preparation.demander(video_id, {
            "titre": track.get("titre", ""),
            "chaine": track.get("chaine", ""),
            "album": track.get("album", ""),
            "annee": track.get("annee", ""),
        })
    if etat == "erreur":
        if _relai_disponible(video_id):
            # Preparation ratee mais source du moteur encore valide : on sert
            # l'original plutot que rien (sinon on annonce l'echec).
            etat, format_audio = "pret", "webm"
    elif etat == "pret":
        format_audio = preparation.format_de(video_id) or format_audio
    return {
        **track,
        "etat": etat,
        "duree": preparation.duree(video_id) or track.get("duree"),
        "taille": preparation.taille(video_id) or track.get("taille"),
        "format": format_audio,
        "pret": bool(preparation.chemin(video_id)),
        "url": f"{base}/{video_id}?k={token}",
        "pochette": f"{pochettes}/{video_id}?k={token}",
    }


def audio_url(session: str, token: str, video_id: str) -> str | None:
    """Source audio a relayer, ou None si la session ou le titre ne colle pas.

    Reutilise le cache de flux du moteur (resolution yt-dlp deja faite) : un titre
    deja joue se transfert sans rien redemander a YouTube.
    """
    source, _ = source_audio(session, token, video_id) or (None, None)
    return source


def connue(session: str, token: str, video_id: str) -> bool:
    """Le titre appartient-il a une session encore valide ?

    Distingue le vrai 404 (session inconnue/expiree, titre etranger) du simple
    contre-temps : le premier est definitif, le second se retente ailleurs.
    """
    entry = _authorized(session, token)
    if entry is None:
        return False
    return any(t["video_id"] == video_id for t in entry["tracks"])


def relancer_preparation(session: str, token: str, video_id: str):
    """(Re)demande la preparation du titre, sans bloquer l'appelant.

    Appele quand un titre de la session n'a encore aucune source : on ne repond
    pas un echec, on remet l'ouvrage sur le metier et on invite le telephone a
    revenir (Retry-After).
    """
    entry = _authorized(session, token)
    if entry is None:
        return
    track = next((t for t in entry["tracks"] if t["video_id"] == video_id), None)
    if track is None:
        return
    if preparation.chemin(video_id) is None:
        # Relance explicite du telephone : on force, sinon le plafond ECHECS_MAX
        # ferait de « Réessayer » un no-op silencieux pendant 24 h (ECHEC_TTL).
        preparation.demander(video_id, {
            "titre": track.get("titre", ""),
            "chaine": track.get("chaine", ""),
            "album": entry.get("name", ""),
            "annee": "",
        }, forcer=True)


def source_audio(session: str, token: str, video_id: str):
    """(source, type) a servir au telephone, ou None.

    Un titre prepare est servi **depuis le disque du bureau** : il porte alors ses
    etiquettes et sa pochette, et le transfert ne depend plus de YouTube. Les
    autres sont relayes depuis le flux d'origine, comme avant.
    """
    entry = _authorized(session, token)
    if entry is None:
        return None
    if not any(t["video_id"] == video_id for t in entry["tracks"]):
        return None
    prepare = preparation.chemin(video_id)
    if prepare:
        format_audio = preparation.format_de(video_id) or "webm"
        return f"file://{prepare}", TYPES_AUDIO.get(format_audio, "audio/mp4")
    cached = state.STREAM_CACHE.get(video_id)
    if isinstance(cached, dict) and cached.get("url"):
        return cached["url"], TYPES_AUDIO["webm"]
    url = _resolve_audio_url(video_id)
    return (url, TYPES_AUDIO["webm"]) if url else None


def pochette(session: str, token: str, video_id: str):
    """Octets de la pochette du titre, ou None.

    C'est exactement la pochette que le bureau affiche : le telephone n'en
    recalcule aucune, et la meme image se retrouve dans le fichier prepare.
    """
    entry = _authorized(session, token)
    if entry is None:
        return None
    track = next((t for t in entry["tracks"] if t["video_id"] == video_id), None)
    if track is None:
        return None
    if not covers.has(video_id):
        covers.ensure_async(video_id, track.get("titre", ""), track.get("chaine", ""),
                            track.get("duree"))
    return covers.wait_read(video_id, 2.0)


def _request(url: str, range_header: str = ""):
    """Ouvre le flux amont avec la plage demandee, ou None."""
    headers = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) NeuroBeats/1.0"}
    if range_header:
        headers["Range"] = range_header
    try:
        return urllib.request.urlopen(
            urllib.request.Request(url, headers=headers), timeout=PROXY_TIMEOUT)
    except Exception as exc:
        _log(f"flux amont refuse : {type(exc).__name__}: {exc}")
        return None


def _total_size(url: str) -> int | None:
    """Taille totale du titre.

    Une requete d'un seul octet suffit a la faire annoncer (`bytes 0-0/4111714`) :
    le telephone connait donc la taille avant de commencer, et peut reprendre.
    """
    response = _request(url, "bytes=0-0")
    if response is None:
        return None
    try:
        annonce = response.headers.get("Content-Range") or ""
        if "/" in annonce:
            return int(annonce.rsplit("/", 1)[-1])
        length = response.headers.get("Content-Length")
        return int(length) if length else None
    except (TypeError, ValueError):
        return None
    finally:
        response.close()


def _parse_range(value: str, total: int) -> tuple[int, int]:
    """Plage [debut, fin] demandee par le telephone ; tout le titre si absente."""
    last = max(total - 1, 0)
    if not value.startswith("bytes="):
        return 0, last
    start, _, end = value[6:].split(",")[0].strip().partition("-")
    try:
        lo = max(0, int(start)) if start else 0
        hi = min(int(end), last) if end else last
        return (lo, hi) if lo <= hi else (0, last)
    except ValueError:
        return 0, last


def _relay(url: str, lo: int, hi: int):
    """Genere [lo, hi] par requetes bornees successives.

    C'est la parade du cache audio, et elle est indispensable ici : un GET continu
    vers googlevideo est bride (~35 Ko/s mesure, soit une playlist en un quart
    d'heure), alors que des plages bornees repartent a plein debit.
    """
    offset = lo
    while offset <= hi:
        end = min(offset + CHUNK - 1, hi)
        response = _request(url, f"bytes={offset}-{end}")
        if response is None:
            return
        try:
            while True:
                piece = response.read(CHUNK)
                if not piece:
                    break
                yield piece
        finally:
            response.close()
        offset = end + 1


def serve(source: str, range_header: str, content_type: str):
    """(statut, en-tetes, corps) a renvoyer au telephone.

    Deux cas, une seule reponse : un titre prepare est lu sur le disque du bureau,
    les autres sont traduits en requetes bornees vers YouTube. Dans les deux cas le
    telephone recoit la meme chose — taille totale annoncee, plage exacte, reprise
    possible.
    """
    if source.startswith("file://"):
        return _serve_fichier(source[7:], range_header, content_type)
    total = _total_size(source)
    if not total:
        return 502, {}, iter(())
    lo, hi = _parse_range(range_header, total)
    partial = bool(range_header) and (lo > 0 or hi < total - 1)
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Type": content_type,
        "Content-Length": str(hi - lo + 1),
    }
    if partial:
        headers["Content-Range"] = f"bytes {lo}-{hi}/{total}"
    return (206 if partial else 200), headers, _relay(source, lo, hi)


def _serve_fichier(chemin: str, range_header: str, content_type: str):
    """Sert un fichier prepare, plage par plage."""
    try:
        total = os.path.getsize(chemin)
    except OSError:
        return 502, {}, iter(())
    lo, hi = _parse_range(range_header, total)
    partial = bool(range_header) and (lo > 0 or hi < total - 1)
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Type": content_type,
        "Content-Length": str(hi - lo + 1),
    }
    if partial:
        headers["Content-Range"] = f"bytes {lo}-{hi}/{total}"

    def lire():
        with open(chemin, "rb") as fichier:
            fichier.seek(lo)
            reste = hi - lo + 1
            while reste > 0:
                bloc = fichier.read(min(CHUNK, reste))
                if not bloc:
                    return
                reste -= len(bloc)
                yield bloc

    return (206 if partial else 200), headers, lire()
