"""Preparation d'un titre pour le transfert vers le telephone.

Le telephone ne sait pas etiqueter un fichier audio : c'est donc le bureau qui
prepare chaque titre avant de le servir, en copie **sans reencodage** :

  1. on recupere le flux AAC (format 140) de YouTube ;
  2. on le remuxe en .m4a en y ecrivant titre, artiste, album et annee ;
  3. on y joint la pochette deja generee par services.covers — la meme que celle
     que le telephone affichera — en piece jointe, si bien que les autres lecteurs
     du telephone la voient aussi.

Si YouTube ne propose pas d'AAC pour ce titre, on garde l'original opus/webm tel
quel, sans pochette integree : jamais de reencodage, donc jamais de perte.

Cache disque : {BASE}/prepared/, une entree par titre (audio + sidecar JSON qui
porte la taille et la provenance). TTL et budget comme les pochettes, et un
interrupteur NEUROBEATS_PREPARED=0 pour tout desactiver.
"""
import json
import os
import shutil
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from core.config import BASE, FFMPEG, YDL_AUDIO_OPTS
from services import covers

# Dossier surchargeable : les tests le redirigent avant l'import du module, comme
# ils le font deja pour les pochettes.
DIR = os.environ.get("NEUROBEATS_PREPARED_DIR", f"{BASE}/prepared")
ACTIF = os.environ.get("NEUROBEATS_PREPARED", "1") != "0"
TTL_SECS = int(os.environ.get("NEUROBEATS_PREPARED_TTL_DAYS", "90")) * 24 * 3600
BUDGET_MO = int(os.environ.get("NEUROBEATS_PREPARED_MB", "512"))
MAX_MO = 256  # garde-fou : un titre prepare depasse rarement 20 Mo
TRAVAUX = int(os.environ.get("NEUROBEATS_PREPARED_WORKERS", "2"))  # basse priorite
SOCKET_TIMEOUT = float(os.environ.get("NEUROBEATS_PREPARED_SOCKET_TIMEOUT", "15"))
RETRIES = int(os.environ.get("NEUROBEATS_PREPARED_RETRIES", "2"))
ECHECS_MAX = 3  # echecs consecutifs apres quoi on cesse de relancer la preparation

AAC = "aac"
M4A = "m4a"
OPUS = "opus"
EXTENSIONS = {M4A: ".m4a", OPUS: ".webm"}

_lock = threading.RLock()
_pool = None
_pool_lock = threading.Lock()
_en_cours: dict = {}          # video_id -> horodatage de debut
_echecs: dict = {}            # video_id -> (horodatage, raison, essence echecs)
ECHEC_TTL = 24 * 3600
# Apres ECHECS_MAX echecs rapproches, on espace les re-tentatives : une source
# morte ne monopolise pas le worker, mais une source provisoirement injoignable
# (cas SWISH) garde une chance de revenir sans action de l'utilisateur. Court
# devant la vie d'une session (20 min) pour qu'une garde mobile la rattrape.
ECHEC_RETENTATIVE = 5 * 60


def _log(message: str):
    print(f"[preparation] {message}", flush=True)


def _chemin(video_id: str, extension: str) -> str:
    return os.path.join(DIR, f"{video_id}{extension}")


def _sidecar(video_id: str) -> str:
    return os.path.join(DIR, f"{video_id}.json")


def _lire_sidecar(video_id: str) -> dict:
    try:
        with open(_sidecar(video_id), "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {}


def _ecrire_sidecar(video_id: str, donnees: dict):
    try:
        os.makedirs(DIR, exist_ok=True)
        with open(_sidecar(video_id), "w", encoding="utf-8") as handle:
            json.dump(donnees, handle, ensure_ascii=False)
    except OSError as exc:
        _log(f"sidecar non ecrit pour {video_id} : {exc}")


def etat(video_id: str) -> str:
    """« pret », « preparation », « erreur » ou « absent ». Sans effet de bord."""
    if not video_id:
        return "absent"
    donnees = _lire_sidecar(video_id)
    if donnees.get("chemin") and os.path.exists(donnees["chemin"]):
        return "pret"
    with _lock:
        if video_id in _en_cours:
            return "preparation"
        echec = _echecs.get(video_id)
    if echec and time.time() - echec[0] < ECHEC_TTL:
        return "erreur"
    return "absent"


def taille(video_id: str):
    """Taille du fichier prepare, ou None s'il ne l'est pas encore."""
    donnees = _lire_sidecar(video_id)
    if donnees.get("chemin") and os.path.exists(donnees["chemin"]):
        return donnees.get("taille")
    return None


def duree(video_id: str):
    """Duree (secondes) du titre prepare, ou None s'il n'est pas pret."""
    donnees = _lire_sidecar(video_id)
    if donnees.get("chemin") and os.path.exists(donnees["chemin"]):
        return donnees.get("duree")
    return None


def format_de(video_id: str) -> str:
    """Format servi : « m4a » (etiquete) ou « webm » (original conserve)."""
    donnees = _lire_sidecar(video_id)
    if donnees.get("chemin") and os.path.exists(donnees["chemin"]):
        return donnees.get("format") or M4A
    return ""


def chemin(video_id: str):
    """Fichier a servir (audio prepare), ou None."""
    donnees = _lire_sidecar(video_id)
    chemin_prepare = donnees.get("chemin")
    if chemin_prepare and os.path.exists(chemin_prepare):
        try:
            os.utime(chemin_prepare)  # date de modification = derniere lecture (LRU)
        except OSError:
            pass
        return chemin_prepare
    return None


def raison_echec(video_id: str) -> str:
    with _lock:
        echec = _echecs.get(video_id)
    return echec[1] if echec else ""


def demander(video_id: str, meta: dict | None = None, forcer: bool = False) -> str:
    """Demande la preparation d'un titre (idempotent, non bloquant).

    Re-lance automatiquement apres un echec, mais plafonne a ECHECS_MAX echecs
    rapproches : une source morte ne doit pas monopoliser un worker en boucle
    (le telephone voit alors « erreur » et arrete de poller). Une fois le cap
    atteint, les re-tentatives s'espa cent a ECHEC_RETENTATIVE : une source
    provisoirement injoignable revient d'elle-meme, sans attendre ECHEC_TTL.

    Args:
        video_id: Identifiant du titre a preparer.
        meta: Metadonnees (titre, chaine, album) pour l'etiquetage.
        forcer: Si True (relance explicite « Réessayer »), passe outre le
            plafond ECHECS_MAX sans attendre ECHEC_RETENTATIVE et remet le
            compteur a zero : un echec transitoire ne doit pas priver
            l'utilisateur de relancer le titre.

    Returns:
        Etat courant : « pret », « preparation », « erreur » ou « absent »
        (absent quand la preparation est desactivee).
    """
    if not ACTIF or not video_id:
        return "absent"
    courant = etat(video_id)
    if courant in ("pret", "preparation"):
        return courant
    with _lock:
        if video_id in _en_cours:
            return "preparation"
        echec = _echecs.get(video_id) or ()
        if echec and time.time() - echec[0] >= ECHEC_TTL:
            echec = ()  # fenetre expiree : on re-authorise une tentative
        compte = echec[2] if len(echec) > 2 else 0
        cap_atteint = echec and compte >= ECHECS_MAX
        if cap_atteint and not forcer and time.time() - echec[0] < ECHEC_RETENTATIVE:
            return "erreur"
        # Cap atteint et delai respecte, ou relance explicite : on repart de
        # zero, sinon le compte porterait la tentative suivante au cap d'emblee.
        if cap_atteint or forcer:
            echec = (time.time(), "", 0)
            compte = 0
        _en_cours[video_id] = time.time()
        # Le compte survit a la re-tentative : il borne les echecs rapproches.
        _echecs[video_id] = (echec[0] if echec else time.time(),
                             echec[1] if echec else "", compte)
    _executeur().submit(_preparer, video_id, dict(meta or {}), compte)
    return "preparation"


def attente(video_id: str, timeout: float) -> str:
    """Etat du titre, en attendant au plus `timeout` la fin de la preparation."""
    fin = time.time() + max(0.0, timeout)
    while True:
        courant = etat(video_id)
        if courant != "preparation" or time.time() >= fin:
            return courant
        time.sleep(0.05)


def _executeur() -> ThreadPoolExecutor:
    global _pool
    with _pool_lock:
        if _pool is None:
            _pool = ThreadPoolExecutor(max_workers=TRAVAUX,
                                       thread_name_prefix="preparation")
        return _pool


def _preparer(video_id: str, meta: dict, essai: int = 0):
    """Telecharge puis met en forme. Repere chaque echec consecutive."""
    try:
        with _lock:
            _en_cours[video_id] = time.time()
        os.makedirs(DIR, exist_ok=True)
        resultat = _telecharger_et_mettre_en_forme(video_id, meta)
        if not resultat.get("ok"):
            raison = resultat.get("erreur") or "echec inconnu"
            with _lock:
                _echecs[video_id] = (time.time(), raison, essai + 1)
            _log(f"{video_id} : {raison}")
            return
        # La duree est optionnelle : une lecture ou un manifeste n'en meurent jamais.
        resultat["duree"] = _duree_fichier(resultat.get("chemin") or "")
        _ecrire_sidecar(video_id, resultat)
        with _lock:
            _echecs.pop(video_id, None)
        _log(f"{video_id} pret ({resultat['format']}, "
             f"{resultat['taille'] // 1024} Ko)")
        _evincer()
    except Exception as exc:  # jamais d'exception qui remonte d'un worker
        with _lock:
            _echecs[video_id] = (time.time(), f"{type(exc).__name__}: {exc}",
                                 essai + 1)
        _log(f"{video_id} : {type(exc).__name__}: {exc}")
    finally:
        with _lock:
            _en_cours.pop(video_id, None)


def _telecharger_et_mettre_en_forme(video_id: str, meta: dict) -> dict:
    """Telecharge la source puis la remuxe : la partie qui touche au reseau."""
    temporaire = os.path.join(DIR, f"{video_id}.source")
    try:
        source = _telecharger(video_id, temporaire)
        if not source:
            return {"ok": False, "erreur": "source introuvable chez YouTube"}
        pochette = _pochette(video_id)
        return remuxer(source, video_id, meta, pochette)
    finally:
        # yt-dlp ajoute sa propre extension a l'outtmpl : on nettoie tout ce qui
        # porte ce prefixe, sinon les sources s'accumulent dans le cache.
        try:
            for nom in os.listdir(DIR):
                if nom.startswith(os.path.basename(temporaire)):
                    try:
                        os.remove(os.path.join(DIR, nom))
                    except OSError:
                        pass
        except OSError:
            pass


def _telecharger(video_id: str, destination: str):
    """Recupere l'audio de YouTube. AAC si possible, opus sinon."""
    from yt_dlp import YoutubeDL

    options = {
        **YDL_AUDIO_OPTS,
        "format": "140/bestaudio[ext=m4a]/bestaudio",
        "outtmpl": destination,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "overwrites": True,
        "socket_timeout": SOCKET_TIMEOUT,
        "retries": RETRIES,
    }
    with YoutubeDL(options) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}",
                                download=True) or {}
    telecharges = info.get("requested_downloads") or []
    if telecharges and telecharges[0].get("filepath"):
        return telecharges[0]["filepath"]
    if info.get("filepath"):
        return info["filepath"]
    return None


def _pochette(video_id: str):
    """Octets de la pochette du bureau, ou None (jamais bloquant)."""
    try:
        return covers.wait_read(video_id, 1.0)
    except Exception:
        return None


def _codec_audio(source: str):
    """Codec audio du fichier source, ou None si illisible."""
    ffprobe = _ffprobe_binaire()
    if not ffprobe or not os.path.exists(source):
        return None
    try:
        sortie = subprocess.run(
            [ffprobe, "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=codec_name", "-of", "default=nw=1:nk=1", source],
            capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    return (sortie.stdout or "").strip() or None


def _ffprobe_binaire() -> str:
    """Chemin de ffprobe (colle a celui de ffmpeg), ou vide si indisponible."""
    if not FFMPEG:
        return ""
    ffprobe = os.path.join(os.path.dirname(FFMPEG), "ffprobe")
    if not os.path.exists(ffprobe):
        ffprobe = shutil.which("ffprobe") or ""
    return ffprobe


def _duree_fichier(chemin_fichier: str):
    """Duree (secondes arrondies) du fichier, ou None si illisible.

    Effacement pessimiste : un echec ici ne doit jamais faire echouer la
    preparation (la duree sert au manifeste, pas a la lecture).
    """
    ffprobe = _ffprobe_binaire()
    if not ffprobe or not os.path.exists(chemin_fichier):
        return None
    try:
        sortie = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", chemin_fichier],
            capture_output=True, text=True, timeout=20)
        texte = (sortie.stdout or "").strip()
        return round(float(texte)) if texte else None
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def remuxer(source: str, video_id: str, meta: dict, pochette: bytes | None = None) -> dict:
    """Met un fichier source en forme pour le telephone (coeur testable, sans reseau).

    Ecrit le titre, l'artiste, l'album et l'annee, et joint la pochette quand elle
    est fournie. Les octets audio sont copies tels quels : aucune perte.

    Args:
        source: fichier audio telecharge.
        video_id: identifiant, qui nomme la sortie.
        meta: {titre, chaine, album, annee} — les manquants sont omis.
        pochette: octets de l'image a joindre, ou None.

    Returns:
        {ok, chemin, format, taille, tags, pochette} ou {ok: False, erreur}.
    """
    if not os.path.exists(source):
        return {"ok": False, "erreur": f"source absente : {source}"}
    codec = _codec_audio(source)
    if codec is None:
        return {"ok": False, "erreur": "source illisible (ffprobe)"}

    titre = str(meta.get("titre") or "")
    chaine = str(meta.get("chaine") or "")
    album = str(meta.get("album") or titre)
    annee = str(meta.get("annee") or "")

    # Pas d'AAC : on sert l'original tel quel. Le telephone affichera sa pochette
    # depuis sa propre base ; on ne reencode jamais pour gagner une vignette.
    if codec != AAC or not FFMPEG:
        # On garde l'extension reellement produite par le telechargement (webm,
        # opus, ogg...) plutot que d'en deviner une.
        extension = os.path.splitext(source)[1].lower() or EXTENSIONS[OPUS]
        sortie = _chemin(video_id, extension)
        shutil.copyfile(source, sortie)
        return _resultat(sortie, OPUS, titre, chaine, album, annee, pochette=False,
                         note=f"flux {codec} conserve tel quel")

    extension = EXTENSIONS[M4A]
    sortie = _chemin(video_id, extension)
    temporaire_image = None
    args = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", source]
    if pochette:
        temporaire_image = os.path.join(DIR, f"{video_id}.pochette.jpg")
        with open(temporaire_image, "wb") as handle:
            handle.write(pochette)
        args += ["-i", temporaire_image]
    args += ["-map", "0:a"]
    if pochette:
        args += ["-map", "1:v", "-c:v", "mjpeg", "-disposition:v", "attached_pic"]
    args += ["-c:a", "copy", "-movflags", "+faststart"]
    for cle, valeur in (("title", titre), ("artist", chaine),
                        ("album", album), ("date", annee)):
        if valeur:
            args += ["-metadata", f"{cle}={valeur}"]
    args.append(sortie)
    try:
        sortie_ffmpeg = subprocess.run(args, capture_output=True, text=True, timeout=600)
    finally:
        if temporaire_image and os.path.exists(temporaire_image):
            try:
                os.remove(temporaire_image)
            except OSError:
                pass
    if sortie_ffmpeg.returncode != 0 or not os.path.exists(sortie):
        detail = (sortie_ffmpeg.stderr or "").strip().splitlines()
        return {"ok": False, "erreur": f"ffmpeg : {detail[-1][:160] if detail else 'echec'}"}
    return _resultat(sortie, M4A, titre, chaine, album, annee, pochette=bool(pochette))


def _resultat(sortie: str, format_audio: str, titre: str, chaine: str, album: str,
              annee: str, pochette: bool, note: str = "") -> dict:
    return {
        "ok": True,
        "chemin": sortie,
        "format": format_audio,
        "taille": os.path.getsize(sortie),
        "titre": titre,
        "chaine": chaine,
        "album": album,
        "annee": annee,
        "pochette": pochette,
        "prepare_le": time.time(),
        "note": note,
    }


def taille_totale() -> int:
    """Octets occupes par les titres prepares."""
    total = 0
    try:
        for nom in os.listdir(DIR):
            chemin_fichier = os.path.join(DIR, nom)
            if os.path.isfile(chemin_fichier) and not nom.endswith(".json"):
                total += os.path.getsize(chemin_fichier)
    except OSError:
        return 0
    return total


def stats() -> dict:
    return {
        "actif": ACTIF,
        "dossier": DIR,
        "en_cours": len(_en_cours),
        "echecs": len(_echecs),
        "octets": taille_totale(),
        "budget_octets": BUDGET_MO * 1024 * 1024,
    }


def clear() -> int:
    """Vide le cache de preparation. Retourne le nombre d'entrees retirees."""
    retires = 0
    try:
        for nom in os.listdir(DIR):
            chemin_fichier = os.path.join(DIR, nom)
            try:
                os.remove(chemin_fichier)
                retires += 1
            except OSError:
                pass
    except OSError:
        return 0
    with _lock:
        _echecs.clear()
    return retires


def oublier(video_id: str) -> bool:
    """Retire un titre prepare (fichier + sidecar)."""
    donnees = _lire_sidecar(video_id)
    retire = False
    for cible in (donnees.get("chemin"), _sidecar(video_id)):
        if cible and os.path.exists(cible):
            try:
                os.remove(cible)
                retire = True
            except OSError:
                pass
    return retire


def _evincer():
    """Evince les plus anciens prepares jusqu'a rentrer dans le budget."""
    budget = BUDGET_MO * 1024 * 1024
    try:
        entrees = []
        for nom in os.listdir(DIR):
            chemin_fichier = os.path.join(DIR, nom)
            if os.path.isfile(chemin_fichier) and not nom.endswith(".json"):
                entrees.append((os.path.getmtime(chemin_fichier), chemin_fichier))
    except OSError:
        return
    total = sum(os.path.getsize(c) for _, c in entrees)
    for _, chemin_fichier in sorted(entrees):
        if total <= budget:
            break
        taille_fichier = os.path.getsize(chemin_fichier)
        video_id = os.path.basename(chemin_fichier).split(".")[0]
        if oublier(video_id):
            total -= taille_fichier
