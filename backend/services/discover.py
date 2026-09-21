"""Decouvrir : sections de recommandation construites en arriere-plan.

Le moteur de reco est lent (ytsearch + embeddings : 20-60 s). Rien n'est donc
attendu cote requete : le serveur construit en tache de fond et publie **section
par section** des qu'une section est prete ; le client affiche des squelettes.

- sections locales (redecouvre, artistes) : pretes en quelques millisecondes ;
- `mix` : lourd (get_recommendation), construit une fois puis cache (TTL) ;
- tuiles de genre : construites **a la demande**, une a la fois, puis cachees.

Un seul thread de construction a la fois : on ne martele jamais Ollama/CPU.
"""
import json
import threading
import time
from collections import Counter

from services import covers
from services.db_access import hist_read, recent_genre
from services.editorial import FALLBACK_INTRO, FALLBACK_TITLE, llm_copy
from services.genres import GENERIC_CHANNELS, GENRE_LABELS, _JUNK_TITLE_RE
from services.recommendation import get_recommendation
from services.state import _tprint

DISCOVER_TTL = 900  # 15 min : une selection de decouverte ne bouge pas vite
GENRE_TTL = 900

# Libelles affichables pour les tuiles de genre.
GENRE_DISPLAY = {
    "rap fr": "Rap FR",
    "pop us": "Pop US",
    "rap us": "Rap US",
    "dance": "Dance",
    "lofi": "Lofi",
}

_LOCK = threading.Lock()
_CACHE: dict = {}
_BUILDING = False
_GENRE_CACHE: dict = {}  # genre -> {tracks, generated_at, building}


# ------------------------------------------------------------------ sections locales

def _rediscover(limit: int = 12) -> list:
    """Titres de l'historique delaisses : les plus anciens d'abord.

    Local (aucun reseau) : pret immediatement. On ecarte le non-musical
    (compilations, gameplay...) avec le meme filtre que le moteur de reco.
    """
    history = hist_read(300)
    if not history:
        return []
    recent_ids = {h.get("video_id") for h in history[-20:]}
    seen, out = set(), []
    for row in history:  # hist_read est chronologique : les plus anciens d'abord
        vid = row.get("video_id")
        if not vid or vid in recent_ids or vid in seen:
            continue
        if _JUNK_TITLE_RE.search(row.get("title", "") or ""):
            continue
        seen.add(vid)
        out.append({
            "video_id": vid,
            "title": row.get("title", ""),
            "channel": row.get("channel", ""),
            "genre": row.get("genre", ""),
            "last_played": row.get("timestamp", ""),
        })
        if len(out) >= limit:
            break
    return out


def _artists(limit: int = 5, per: int = 3) -> list:
    """Artistes les plus ecoutes, avec quelques titres recents chacun (local)."""
    history = hist_read(300)
    if not history:
        return []
    counts = Counter(
        h.get("channel") for h in history
        if h.get("channel") and h.get("channel") not in GENERIC_CHANNELS
    )
    groups = []
    for channel, plays in counts.most_common(limit):
        tracks, seen = [], set()
        for row in reversed(history):  # du plus recent au plus ancien
            if row.get("channel") != channel:
                continue
            vid = row.get("video_id")
            if not vid or vid in seen:
                continue
            seen.add(vid)
            tracks.append({"video_id": vid, "title": row.get("title", ""),
                           "channel": channel})
            if len(tracks) >= per:
                break
        if tracks:
            groups.append({"channel": channel, "plays": plays, "tracks": tracks})
    return groups


# ------------------------------------------------------------------------- le mix

def _gather_mix(genre: str, want: int = 8) -> list:
    """Recolte `want` titres pour le mix : filtre genre dur puis elargi, deduplique."""
    picked, seen = [], set()

    def absorb(query: str, hard: bool):
        try:
            data = json.loads(get_recommendation(query, force_genre_filter=hard))
        except Exception as exc:
            _tprint(f"[discover] reco echec ({query!r}, hard={hard}) : {exc}")
            return
        if not isinstance(data, dict):
            return
        for track in data.get("recommendations", []) or []:
            vid = track.get("video_id")
            if not vid or vid in seen:
                continue
            seen.add(vid)
            picked.append(track)

    # Plusieurs passes : une seule rend 3 titres ; on enchaine jusqu'au quota.
    absorb(genre, bool(genre))
    while len(picked) < want:
        before = len(picked)
        absorb(genre, bool(genre))
        if len(picked) == before:  # plus rien de neuf : on elargit
            absorb(genre, False)
            if len(picked) == before:
                break
    return picked[:want]


def _mix_section(want: int = 8) -> dict:
    """Section « mix personnel » : selection + habillage LLM."""
    genre = recent_genre()
    tracks = _gather_mix(genre, want)
    if tracks:
        headline, intro = llm_copy(
            tracks, genre,
            instructions="Oriente la formulation vers la decouverte de nouveautes.",
        )
    else:
        headline, intro = FALLBACK_TITLE, FALLBACK_INTRO
    return {
        "ready": bool(tracks),
        "headline": headline,
        "intro": intro,
        "genre": genre,
        "tracks": [
            {"video_id": t.get("video_id", ""), "title": t.get("title", ""),
             "channel": t.get("channel", ""), "genre": t.get("genre", "")}
            for t in tracks
        ],
    }


# ---------------------------------------------------------------------- build/cache

def _warm_covers(*groups) -> None:
    """Prepare les pochettes HQ des titres montres (tache de fond, non bloquant).

    Lance pendant la construction, pas a l'affichage : le client repolle jusqu'a
    `ready`, les images sont donc le plus souvent deja la quand la page apparait.
    """
    for group in groups:
        for track in group or []:
            video_id = (track or {}).get("video_id")
            if video_id:
                covers.ensure_async(video_id, track.get("title", ""),
                                    track.get("channel", ""))


def _build():
    """Construit les sections et publie au fur et a mesure (un seul thread)."""
    global _CACHE, _BUILDING
    try:
        # 1) sections locales : instantanees, publiees tout de suite.
        rediscover = _rediscover()
        artists = _artists()
        sections = {
            "rediscover": {"ready": True, "tracks": rediscover},
            "artists": {"ready": True, "items": artists},
            "mix": {"ready": False, "headline": "", "intro": "", "genre": "", "tracks": []},
        }
        with _LOCK:
            _CACHE.update(sections)
            _CACHE["generated_at"] = int(time.time())
        _tprint("[discover] sections locales pretes")
        _warm_covers(rediscover, [t for group in artists for t in group.get("tracks", [])])
        # 2) le mix (lourd) : publie des qu'il est pret.
        mix = _mix_section()
        with _LOCK:
            _CACHE["mix"] = mix
            _CACHE["generated_at"] = int(time.time())
        _tprint(f"[discover] mix pret : {len(mix['tracks'])} titres")
        _warm_covers(mix["tracks"])
    except Exception as exc:
        _tprint(f"[discover] construction echec : {exc}")
    finally:
        with _LOCK:
            _BUILDING = False
            _CACHE["building"] = False


def _genre_cached(genre: str) -> dict | None:
    """Tuile de genre si elle est encore fraiche, sinon None."""
    entry = _GENRE_CACHE.get(genre)
    if not entry:
        return None
    if time.time() - entry.get("generated_at", 0) >= GENRE_TTL:
        return None
    return entry


def _build_genre(genre: str):
    """Construit une tuile de genre (une seule a la fois) puis la met en cache."""
    try:
        tracks = _gather_genre(genre, 4)
        with _LOCK:
            _GENRE_CACHE[genre] = {"tracks": tracks, "generated_at": int(time.time()),
                                   "building": False}
        _tprint(f"[discover] tuile {genre!r} prete : {len(tracks)} titres")
        _warm_covers(tracks)
    except Exception as exc:
        _tprint(f"[discover] tuile {genre!r} echec : {exc}")
        with _LOCK:
            _GENRE_CACHE[genre] = {"tracks": [], "generated_at": int(time.time()),
                                   "building": False}


def _gather_genre(genre: str, want: int) -> list:
    """Titres 100 % `genre` (filtrage dur), dedupliques.

    Borne a 2 passes : chaque passe coute 20-60 s, on ne veut pas faire attendre
    une tuile indefiniment (quitte a rendre moins de `want` titres).
    """
    picked, seen = [], set()
    rounds = 0
    while len(picked) < want and rounds < 2:
        rounds += 1
        try:
            data = json.loads(get_recommendation(genre, force_genre_filter=True))
        except Exception as exc:
            _tprint(f"[discover] tuile {genre!r} reco echec : {exc}")
            break
        added = False
        for track in (data.get("recommendations", []) if isinstance(data, dict) else []) or []:
            vid = track.get("video_id")
            if not vid or vid in seen:
                continue
            seen.add(vid)
            picked.append({"video_id": vid, "title": track.get("title", ""),
                           "channel": track.get("channel", ""), "genre": genre})
            added = True
            if len(picked) >= want:
                break
        if not added:
            break
    return picked[:want]


def _genre_tiles() -> list:
    """Tuiles de genre (metadonnees + etat de preparation)."""
    tiles = []
    for genre in GENRE_LABELS:
        if genre == "autre":
            continue
        cached = _genre_cached(genre)
        tiles.append({
            "genre": genre,
            "label": GENRE_DISPLAY.get(genre, genre.title()),
            "ready": bool(cached and cached.get("tracks")),
            "building": bool(cached and cached.get("building")),
        })
    return tiles


def _ensure_fresh(force: bool = False):
    """Lance une construction en fond si le cache est vide ou perime."""
    global _BUILDING
    with _LOCK:
        age = time.time() - _CACHE.get("generated_at", 0) if _CACHE else None
        fresh = age is not None and age < DISCOVER_TTL
        if _BUILDING or (fresh and not force):
            return
        _BUILDING = True
        _CACHE["building"] = True
    threading.Thread(target=_build, daemon=True, name="discover").start()


def get_discover() -> str:
    """Payload complet ; ne bloque jamais (le client repasse tant que ce n'est pas pret)."""
    _ensure_fresh()
    with _LOCK:
        payload = dict(_CACHE) if _CACHE else {"generated_at": 0}
        payload.setdefault("mix", {"ready": False, "headline": "", "intro": "",
                                   "genre": "", "tracks": []})
        payload.setdefault("rediscover", {"ready": False, "tracks": []})
        payload.setdefault("artists", {"ready": False, "items": []})
        payload["genres"] = {"ready": True, "items": _genre_tiles()}
        payload["building"] = _BUILDING
        payload["ready"] = bool(payload["mix"].get("ready"))
    return json.dumps(payload, ensure_ascii=False)


def get_genre_section(genre: str, force: bool = False) -> str:
    """Tuile d'un genre : cache si chaud, sinon construction en fond (repond tout de suite).

    `force=True` ignore le cache : sert au bouton « Reessayer » quand le vivier du
    genre etait momentanement vide.
    """
    want = (genre or "").strip().lower()
    if want not in GENRE_DISPLAY:
        return json.dumps({"error": f"Genre inconnu '{genre}' (rap fr, pop us, rap us, dance, lofi)."},
                          ensure_ascii=False)
    cached = None if force else _genre_cached(want)
    if cached is None:
        with _LOCK:
            entry = _GENRE_CACHE.get(want)
            already = bool(entry and entry.get("building"))
            if not already:
                _GENRE_CACHE[want] = {"tracks": entry.get("tracks", []) if entry else [],
                                      "generated_at": entry.get("generated_at", 0) if entry else 0,
                                      "building": True}
        if not already:
            threading.Thread(target=_build_genre, args=(want,), daemon=True,
                             name=f"discover-{want}").start()
        cached = _GENRE_CACHE.get(want) or {}
    return json.dumps({
        "genre": want,
        "label": GENRE_DISPLAY[want],
        "ready": bool(cached.get("tracks")),
        "building": bool(cached.get("building")),
        "tracks": cached.get("tracks", []),
    }, ensure_ascii=False)


def refresh_discover() -> str:
    """Purge le cache (mix + tuiles) et relance la construction en fond."""
    global _CACHE, _GENRE_CACHE
    with _LOCK:
        _CACHE = {}
        _GENRE_CACHE = {}
    _ensure_fresh(force=True)
    return json.dumps({"status": "refreshing"}, ensure_ascii=False)
