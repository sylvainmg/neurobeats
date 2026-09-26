"""Paroles de titres : sources gratuites (LRCLIB puis Genius), cache SQLite.

Deux paliers, dans l'ordre :

  1. **LRCLIB** (lrclib.net, API libre sans cle ni compte) : paroles
     *synchronisees* (format LRC horodate) quand elles existent, sinon le texte
     brut. C'est la source qui permet le karaoke. Flag `instrumental` gere. Le
     karaoke prime : meme quand la signature exacte ne livre que du texte brut,
     une recherche trouve une version horodatee de meme confiance, c'est elle
     qui est retenue.
  2. **Genius** (site) : paroles *non synchronisees*, via l'API interne
     `genius.com/api/search/multi` (sans auth) + extraction des blocs
     `data-lyrics-container` de la page du morceau. L'UI deroule alors les
     paroles avec une estimation des temps (defilement auto approxime).

Aucune source n'est dotee d'une cle, et aucune nouvelle dependance : urllib +
regex, comme `services/websearch.py` et `services/coverart.py`. Google n'est
*pas* scrappe (SERP anti-bot, paroles rendues en JS) ; LRCLIB+Genius suffisent,
et un echec global affiche le repli « aucune parole ».

Les horodatages LRC sont ancres sur la piste audio « propre » du titre : un
clip qui commence par un prologue (scene, teasing) decale donc tout d'un coup.
Ce n'est pas un defaut du rapprochement — choisir une version sans prologue
rend la synchro parfaite (le karaoke reste aligne sur 0:00 de la piste).

Le cache SQLite (`core.db.lyrics`) evite de re-solliciter les sources :
- positif : LYRICS_TTL_DAYS (une paroles trouvee ne change quasi jamais) ;
- negatif : LYRICS_MISS_TTL_DAYS, court, car une absence est souvent
  temporaire (LRCLIB s'enrichit, titre encore mal ecrit).
Une panne reseau ne pollue JAMAIS le cache (on ne sait pas si le titre existe).
"""
import json
import logging
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from html import unescape

from core import db as engine_db
from core.config import (
    LYRICS_ENABLED, LYRICS_MATCH_MIN, LYRICS_MISS_TTL_DAYS, LYRICS_TIMEOUT,
    LYRICS_TTL_DAYS,
)
from services import coverart
from services.db_access import _meta

logger = logging.getLogger(__name__)

LRCLIB_BASE = "https://lrclib.net"
GENIUS_SEARCH = "https://genius.com/api/search/multi"
# L'API refuse per_page > 5 avec un 422 et un corps d'erreur : la recherche
# Genius echouait entierement sur un 10. Cinq resultats suffisent : le score
# de correspondance (titre + artiste) ne retient de toute facon qu'un seul hit.
GENIUS_PER_PAGE = 5

_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) NeuroBeats/1.0"

# Horizon d'une semaine pour la coherence des sources : une duree de 0 (mpv
# charge encore) ne doit ni faire echouer une signature exacte ni discrediter
# un candidat de recherche (la grille de score de coverart leurrerait).
_DURATION_MS = 7 * 24 * 3600

# Bonus de classement pour un enregistrement LRCLIB horodate. Modeste : il
# tranche entre candidats proches (le karaoke prime), jamais au-dessus d'un
# match parfait (borne `min(1.0, ...)`) et ne rattrape pas un meilleur match.
_SYNCED_BONUS = 0.06

_LRC_TIME = re.compile(r"\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]")
# LRC « enhanced » (<mm:ss.xx> word-level) : inutile ici, on en retire le texte.
_ENHANCED_TAG = re.compile(r"</?\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>")
# [offset:±ms] : decalage global (spec LRC). Un offset positif fait apparaitre
# les paroles PLUS TOT : le player doit donc SOUSTRAIRE la valeur. Rare dans les
# envois LRCLIB, mais un record qui le porte serait sinon decale en permanence.
_LRC_OFFSET = re.compile(r"^\[offset:([+-]?\d+)\]$", re.IGNORECASE)
_BR = re.compile(r"<br\s*/?>", re.I)
_TAG = re.compile(r"<[^>]+>")
_LYRICS_MARKER = 'data-lyrics-container="true"'
_EXCLUDE_MARKER = "data-exclude-from-selection"


# --------------------------------------------------------------- cache SQLite

def _expired(entry: dict) -> bool:
    """Vrai si l'entree de cache a depasse son TTL (positif ou negatif)."""
    try:
        created = datetime.fromisoformat((entry or {}).get("created_at", ""))
    except (TypeError, ValueError):
        return True
    ttl = LYRICS_MISS_TTL_DAYS if entry.get("status") == "miss" else LYRICS_TTL_DAYS
    return datetime.now() - created > timedelta(days=ttl)


def _payload_from(entry: dict) -> dict:
    """Reconstitue la reponse API depuis une ligne du cache."""
    out = {
        "found": entry.get("status") == "hit",
        "synced": bool(entry.get("synced")),
        "source": entry.get("source") or None,
        "instrumental": bool(entry.get("instrumental")),
        "title": entry.get("title") or "",
        "artist": entry.get("artist") or "",
        "lines": [],
        "message": entry.get("error") or None,
    }
    if out["found"] and entry.get("payload"):
        try:
            out["lines"] = json.loads(entry["payload"])
        except json.JSONDecodeError:
            out["lines"] = []
    return out


def _not_found(message: str = "", retryable: bool = False) -> dict:
    """Reponse negative : aucune source ne possede les paroles (ou panne reseau).

    La cle est `message`, pas `error` : `run_tool` (enveloppe API partagee)
    transforme toute cle `error` du payload en erreur HTTP, alors qu'un « rien
    trouve » reste une reponse 200 normale que l'UI traite elle-meme.
    """
    return {"found": False, "synced": False, "source": None,
            "instrumental": False, "title": "", "artist": "",
            "lines": [], "message": message or None, "retryable": retryable}


# ------------------------------------------------------------- couche reseau

def _request(url: str, timeout: float = LYRICS_TIMEOUT):
    """GET brut -> (code_http, corps) ; (0, None) si reseau/timeout.

    Le code 0 distingue une panne (a ne PAS cacher) d'un 404 (miss legitime).
    """
    req = urllib.request.Request(url, headers={
        "User-Agent": _USER_AGENT, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, None
    except Exception:
        return 0, None


def _get_json(url: str):
    """GET JSON -> (data, code) ; code 0 = reseau, 200 = parse ok."""
    code, body = _request(url)
    if code != 200 or not body:
        return None, code
    try:
        return json.loads(body), 200
    except json.JSONDecodeError:
        return None, 0


# ---------------------------------------------------------- parseurs de texte

def _parse_lrc(text: str) -> list:
    """Convertit un bloc LRC en lignes horodatees, triees par temps.

    Un couple [mm:ss.xx] devant le texte = un instant de debut. Un refrain peut
    porter DEUX instants (deux entree de meme texte, c'est le comportement
    karaoke attendu). Les balises metadonnees ([ar:], [ti:], ...) et le LRC
    enhanced (<mm:ss.xx>) sont ignores, sauf [offset:±ms] qui decale tous les
    horodatages (spec LRC : + => paroles plus tot => on soustrait).
    """
    lines = []
    offset_s = 0.0
    for raw in (text or "").splitlines():
        raw = raw.strip()
        if not raw:
            continue
        offset = _LRC_OFFSET.match(raw)
        if offset:
            offset_s = -int(offset.group(1)) / 1000.0
            continue
        tags = list(_LRC_TIME.finditer(raw))
        if not tags:
            continue  # balise metadonnee ou texte sans horodatage
        body = _LRC_TIME.sub("", raw)
        body = _ENHANCED_TAG.sub("", body).strip()
        if not body:
            continue
        for tag in tags:
            minutes = int(tag.group(1))
            seconds = int(tag.group(2))
            frac = tag.group(3) or "0"
            frac = int(frac) / (10 ** len(frac))
            t = minutes * 60 + seconds + frac + offset_s
            lines.append({"time": round(max(0.0, t), 3), "text": body})
    lines.sort(key=lambda line: line["time"])
    return lines


def _clean_plain(text: str) -> list:
    """Decoupe un texte brut en lignes propres (espaces resseres, vides retires)."""
    out = []
    for raw in (text or "").splitlines():
        line = re.sub(r"\s+", " ", raw).strip()
        if line:
            out.append(line)
    return out


def _drop_excluded(inner: str) -> str:
    """Retire le sous-arbre data-exclude-from-selection d'un bloc de paroles.

    Genius entete ses paroles d'un rappel « Contribuer »/credit. Il vit dans un
    <div> dedie : on l'elimine en comptant la profondeur <div>/</div>, comme
    pour l'extraction principale.
    """
    result = []
    pos = 0
    marker_at = inner.find(_EXCLUDE_MARKER)
    while marker_at != -1:
        open_at = inner.rfind("<div", 0, marker_at)
        if open_at == -1:
            break
        depth, j, end = 0, open_at, open_at
        while j < len(inner):
            if inner.startswith("</div", j):
                depth -= 1
                if depth == 0:
                    close = inner.find(">", j)
                    end = close + 1 if close != -1 else j + 5
                    break
                j += 5
            elif inner.startswith("<div", j):
                depth += 1
                j += 4
            else:
                j += 1
        result.append(inner[pos:open_at])
        pos = end
        marker_at = inner.find(_EXCLUDE_MARKER, end)
    result.append(inner[pos:])
    return "".join(result)


def _extract_lyrics(html: str) -> str:
    """Texte des paroles Genius : contenu des blocs data-lyrics-container.

    Sans BeautifulSoup (convention du projet) : on repere chaque <div> porteur
    de la marque, on recupere son sous-arbre en comptant la profondeur, puis
    <br> devient saut de ligne, les balises tombent et les entites sont decodees
    via la stdlib (`html.unescape`).
    """
    blocks, blk_depth, inner_start = [], None, None
    i, n = 0, len(html)
    while i < n:
        if html.startswith("</div", i):
            if blk_depth is not None:
                if blk_depth == 0:
                    # Fermeture du conteneur marque : le bloc est complet.
                    blocks.append(html[inner_start:i])
                    inner_start, blk_depth = None, None
                else:
                    blk_depth -= 1
            i += 5
            continue
        if html.startswith("<div", i):
            tag_end = html.find(">", i)
            if tag_end == -1:
                break
            opening = html[i:tag_end + 1]
            if _LYRICS_MARKER in opening and inner_start is None:
                # Debut d'un bloc (la marque vit parfois sur un <div> imbrique,
                # ex. <div class="SongPage">) : on attend la fermeture de CE
                # conteneur-là, `blk_depth` mesurant son contenu.
                inner_start = tag_end + 1
                blk_depth = 0
            elif inner_start is not None:
                blk_depth += 1
            i = tag_end + 1
            continue
        i += 1
    if not blocks:
        return ""
    text = "\n".join(_drop_excluded(block) for block in blocks)
    text = _BR.sub("\n", text)
    text = _TAG.sub("", text)
    return unescape(text)


# ------------------------------------------------------------------- sources

def _lrclib_record(item: dict):
    """Un enregistrement LRCLIB -> payload paroles, ou None si inexploitable.

    Le synced prime : c'est lui qui permet le karaoke. A defaut, le texte brut
    est retourne en lignes sans temps (`time: null`). `instrumental` est une
    vraie reponse : le titre n'a pas de paroles par nature.
    """
    if item.get("instrumental") and not (item.get("syncedLyrics") or item.get("plainLyrics")):
        return {"synced": False, "lines": [], "instrumental": True,
                "title": item.get("trackName") or "",
                "artist": item.get("artistName") or ""}
    synced = _parse_lrc(item.get("syncedLyrics") or "")
    if synced:
        return {"synced": True, "lines": synced, "instrumental": False,
                "title": item.get("trackName") or "",
                "artist": item.get("artistName") or ""}
    plain = [{"time": None, "text": line}
             for line in _clean_plain(item.get("plainLyrics") or "")]
    if plain:
        return {"synced": False, "lines": plain, "instrumental": False,
                "title": item.get("trackName") or "",
                "artist": item.get("artistName") or ""}
    return None


def _lrclib(artist: str, title: str, duration) -> dict:
    """Recherche LRCLIB : signature exacte puis recherche validee.

    Le titre exact part nettoye (parenthèses du clip, « Lyrics », « vevo »...)
    car la signature /api/get compare les libelles bruts : « CARTIER (Clip
    Officiel) » ne matcherait jamais, « CARTIER » oui.

    Le karaoke prime aussi sur la signature exacte : si elle ne livre qu'un
    enregistrement NON horodate (plain), on tente quand meme la recherche — un
    candidat synchronise d'au moins aussi bon score est prefere. Le plain exact
    sert de seuil et de repli : jamais une version moins fiable qu'un match
    parfait.

    Returns:
        {"status": "found", "payload": {...}} | {"status": "miss"} |
        {"status": "network_error", "error": ...}
    """
    dur = ""
    if isinstance(duration, (int, float)) and duration > 0:
        dur = str(int(round(float(duration))))
    clean_artist = coverart._search_term(artist) or artist.strip()
    clean_title = coverart._search_term(title) or title.strip()
    url = (f"{LRCLIB_BASE}/api/get?track_name={urllib.parse.quote(clean_title)}"
           f"&artist_name={urllib.parse.quote(clean_artist)}&album_name=&duration={dur}")
    data, code = _get_json(url)
    if code == 0:
        return {"status": "network_error", "error": "LRCLIB injoignable"}
    exact_fallback = None
    exact_score = 0.0
    if code == 200 and isinstance(data, dict):
        found = _lrclib_record(data)
        # Horodate ou instrumental : reponse definitive, pas besoin de chercher.
        if found and (found.get("synced") or found.get("instrumental")):
            found["source"] = "lrclib"
            found["artist"] = found["artist"] or artist
            return {"status": "found", "payload": found}
        if found:
            # Plain : reserve en repli (le match exact etant le plus fiable),
            # mais on tente la recherche au cas ou une version horodatee
            # existe — c'est le defaut « CARTIER» vs « CARTIER (Clip Officiel) »
            # inverse : la signature a de la sync ailleurs dans la recherche.
            exact_fallback = found
            exact_score = coverart._score(artist, title, duration, {
                "title": data.get("trackName") or "",
                "artist": data.get("artistName") or "",
                "duration": data.get("duration"),
            })

    query = urllib.parse.quote(coverart._search_term(f"{artist} {title}"))
    data, code = _get_json(f"{LRCLIB_BASE}/api/search?q={query}")
    if code != 200:
        # « Aucun résultat » est un 200 avec liste vide ; tout autre code est
        # une panne/refus (429, 5xx...), à ne pas cacher.
        return {"status": "network_error", "error": "LRCLIB injoignable"}
    if isinstance(data, dict):
        items = data.get("content") or data.get("results") or []
    elif isinstance(data, list):
        items = data
    else:
        items = []
    best, best_scored = None, 0.0
    for item in items:
        if not isinstance(item, dict):
            continue
        raw = coverart._score(artist, title, duration, {
            "title": item.get("trackName") or "",
            "artist": item.get("artistName") or "",
            "duration": item.get("duration"),
        })
        # Le synced prime quand les candidats sont proches : le karaoke est
        # l'usage attendu, afficher du texte brut quand la sync existait est le
        # defaut que l'on corrige. Bonus borne (jamais au-dessus du match parfait).
        scored = min(1.0, raw + _SYNCED_BONUS) if item.get("syncedLyrics") else raw
        if scored >= LYRICS_MATCH_MIN and scored > best_scored:
            best, best_scored = item, scored
    if best:
        found = _lrclib_record(best)
        if found:
            found["source"] = "lrclib"
            found["artist"] = found["artist"] or artist
            if found.get("synced") and (not exact_fallback or best_scored >= exact_score):
                # Le synced de recherche bat le plain exact des lors qu'il ne
                # matche pas moins bien : le plain sert de seuil de confiance.
                return {"status": "found", "payload": found}
    if exact_fallback:
        exact_fallback["source"] = "lrclib"
        exact_fallback["artist"] = exact_fallback.get("artist") or artist
        return {"status": "found", "payload": exact_fallback}
    if best:
        # Aucun synced retenu (ou plain de recherche) : on prend ce qui a passe
        # le seuil, le plain exact ayant deja eu sa chance ci-dessus.
        found = _lrclib_record(best)
        if found:
            found["source"] = "lrclib"
            found["artist"] = found["artist"] or artist
            return {"status": "found", "payload": found}
    return {"status": "miss"}


def _norm_match(want: str, got: str) -> float:
    """Ressemblance 0-1 de deux libelles (normalises, contenance privilegiee)."""
    want = coverart._normalize(want or "")
    got = coverart._normalize(got or "")
    if not want or not got:
        return 0.0
    score = coverart._ratio(want, got)
    if want in got or got in want:
        score = max(score, 0.9)
    return score


def _genius(artist: str, title: str, channel: str) -> dict:
    """Paroles Genius (texte brut) pour ce titre, ou miss/panne reseau.

    L'API interne /api/search/multi ne demande pas d'auth ; on garde le hit
    « song » valide (titre 55% + artiste 45% via full_title/primary_artist) puis
    on extrait les blocs data-lyrics-container de sa page.
    """
    query = urllib.parse.quote(coverart._search_term(f"{artist} {title}"))
    data, code = _get_json(f"{GENIUS_SEARCH}?per_page={GENIUS_PER_PAGE}&q={query}")
    if code == 0:
        return {"status": "network_error", "error": "Genius injoignable"}
    if code != 200:
        # 403/429/5xx : Genius bloque l'IP ou est indisponible. Ce n'est PAS un
        # « pas de paroles » : ne pas cacher, l'usager pourra réessayer.
        return {"status": "network_error", "error": f"Genius refuse (HTTP {code})"}
    best, best_score = None, 0.0
    for section in (data or {}).get("response", {}).get("sections") or []:
        if section.get("type") != "song":
            continue
        for hit in section.get("hits") or []:
            result = hit.get("result") or {}
            page_url = result.get("url") or ""
            if not page_url:
                continue
            full = result.get("full_title") or ""
            primary = (result.get("primary_artist") or {}).get("name") or ""
            score = 0.55 * _norm_match(title, full) + 0.45 * _norm_match(artist, primary)
            if score >= LYRICS_MATCH_MIN and score > best_score:
                best, best_score = page_url, score
    if not best:
        return {"status": "miss"}
    code, html = _request(best)
    if code == 0:
        return {"status": "network_error", "error": "Genius injoignable"}
    if code == 404:
        # Page disparue : miss honnête (rare). Tout autre refus (403, 429,
        # 5xx) reste une panne : ne pas cacher.
        return {"status": "miss"}
    if code != 200 or not html:
        return {"status": "network_error", "error": f"Genius refuse (HTTP {code})"}
    lines = [{"time": None, "text": line}
             for line in _clean_plain(_extract_lyrics(html))]
    if not lines:
        return {"status": "miss"}
    return {"status": "found", "payload": {
        "synced": False, "lines": lines, "instrumental": False,
        "title": title, "artist": artist, "source": "genius"}}


# ------------------------------------------------------------------ pipeline

def get_lyrics(video_id: str, title: str = "", channel: str = "",
               duration=None) -> str:
    """Paroles d'un titre : synchronisees si disponibles, sinon texte brut.

    Args:
        video_id: identifiant YouTube du titre.
        title: libelle YouTube ; repli client si le serveur ne le connait pas
            encore (file prechargee, dernier historique vide).
        channel: chaine YouTube, artiste presume si le libelle n'a aucun
            separateur « Artiste - Titre ».
        duration: duree en secondes, arbitre du rapprochement LRCLIB.

    Returns:
        JSON {found, synced, source, instrumental, title, artist, lines, message}.
        `found:false` sans `message` = aucune source ne possede les paroles ;
        avec `message` + `retryable` = panne reseau, rien n'est cache (l'UI
        propose « Reessayer ») ; le message annonce honnetement qu'aucune
        parole n'a ete trouvee pour le titre.

    Notes:
        - Cache SQLite positif/negatif (voir TTL en tete de module) : une source
          n'est sollicitee qu'une fois par titre. Exception : un resultat
          (trouve ou miss) obtenu SANS duree connue n'est pas cache — la duree
          arrive dans la seconde qui suivra et peut changer le match LRCLIB
          (le synced apparait des que la signature est arbitree).
        - Artistes candidats : partie gauche du libelle PUIS la chaine YouTube si
          elle differe (couvre « Titre seul » sur une chaine d'artiste).
        - Une source en panne est abandonnee pour les candidats suivants : la
          panne est globale, pas liee au titre. La cause technique part en log
          (`[lyrics]`), l'UI recoit un message oriente utilisateur.
    """
    if not LYRICS_ENABLED:
        return json.dumps(_not_found(), ensure_ascii=False)

    cached = engine_db.db_lyrics_get(video_id)
    if cached and not _expired(cached):
        engine_db.db_lyrics_touch(video_id)
        return json.dumps(_payload_from(cached), ensure_ascii=False)

    meta = _meta(video_id) or {}
    title = (title or meta.get("title") or "").strip()
    channel = (channel or meta.get("channel") or "").strip()
    if not title:
        engine_db.db_lyrics_put(video_id, status="miss", source="", synced=0,
                                instrumental=0, title="", artist="", payload="",
                                error="")
        return json.dumps(_not_found(), ensure_ascii=False)

    artist, track = coverart._split_artist(title, channel)
    if not track:
        track = title
    artists = [a for a in (artist,) if a and a != track]
    if channel and coverart._normalize(channel) not in (
            coverart._normalize(artist), coverart._normalize(track)):
        artists.append(channel)

    # La durée arbitre le rapprochement LRCLIB. Inconnue (mpv charge encore),
    # aucun résultat n'est mis en cache : un « trouvé » obtenu à l'aveugle peut
    # être corrigé par son arrivée (le synced apparaît quand la signature est
    # arbitrée), et un miss empêcherait de retenter pendant le TTL négatif.
    known_duration = bool(isinstance(duration, (int, float)) and duration > 0)

    failed_sources, last_error = set(), ""
    for candidate_artist in artists or [""]:
        for name, call in (
                ("lrclib", lambda: _lrclib(candidate_artist, track, duration)),
                ("genius", lambda: _genius(candidate_artist, track, channel))):
            if name in failed_sources:
                continue
            attempt = call()
            status = attempt.get("status")
            if status == "found":
                found = attempt["payload"]
                title_saved = found.get("title") or track
                artist_saved = found.get("artist") or candidate_artist
                if known_duration:
                    engine_db.db_lyrics_put(
                        video_id, status="hit", source=found.get("source", ""),
                        synced=1 if found.get("synced") else 0,
                        instrumental=1 if found.get("instrumental") else 0,
                        title=title_saved, artist=artist_saved,
                        payload=json.dumps(found["lines"], ensure_ascii=False),
                        error="")
                return json.dumps({
                    "found": True,
                    "synced": bool(found.get("synced")),
                    "source": found.get("source") or None,
                    "instrumental": bool(found.get("instrumental")),
                    "title": title_saved,
                    "artist": artist_saved,
                    "lines": found["lines"],
                    "message": None,
                }, ensure_ascii=False)
            if status == "network_error":
                failed_sources.add(name)
                last_error = attempt.get("error") or ""

    if failed_sources:
        # Panne reseau globale (aucune source n'a repondu) : ne pas cacher,
        # l'utilisateur pourra reessayer a chaud. L'UI annonce simplement
        # qu'aucune parole n'a ete trouvee ; la cause technique reste en logs.
        logger.warning("[lyrics] %s: %s", video_id,
                       last_error or "sources injoignables")
        return json.dumps(_not_found(
            message="Aucune parole trouvée pour ce titre.",
            retryable=True), ensure_ascii=False)

    if known_duration:
        engine_db.db_lyrics_put(video_id, status="miss", source="", synced=0,
                                instrumental=0, title=artist or title,
                                artist=channel or artist, payload="", error="")
    return json.dumps(_not_found(), ensure_ascii=False)