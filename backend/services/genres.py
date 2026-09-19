"""Genres musicaux : mapping cure, auto-tagging Ollama, filtrage dur."""
import re
import threading
from concurrent.futures import ThreadPoolExecutor

import ollama

from core.config import MODEL
from services.db_access import _db_ready
from services.state import _tprint

# Mapping cure (chaines d'ARTISTES uniquement). Ne mapper QUE des artistes : les chaines
# generiques (lyrics/paroles/compil, multi-artistes) vont dans GENERIC_CHANNELS -> "autre",
# sinon elles captent les bonus Markov/stats sur toutes les requetes.
CHANNEL_GENRE_MAP = {
    "GAZO OFFICIEL": "rap fr",
    "Lomepal": "rap fr",
    "VALD": "rap fr",
    "MMZ": "rap fr",
    "Lil Nas X": "pop us",
    "LIL UZI VERT": "rap us",
}
GENERIC_CHANNELS = {
    "Paroles Françaises", "Info Star", "COLORS", "Finding Sounds", "Royal Music",
    "LYRICS", "Lyrics", "Paroles", "Clique TV", "Mouv",
}

GENRE_LABELS = ["rap fr", "pop us", "rap us", "dance", "lofi", "autre"]
# Requetes YouTube pertinentes par genre (le label brut est ambigu : 'pop us' matche des jeux)
GENRE_SEARCH_TERMS = {
    "rap fr": ["rap français", "rap fr 2024", "nouveauté rap français"],
    "pop us": ["pop hits english", "english pop songs", "top pop songs"],
    "rap us": ["rap us hits", "american rap songs"],
    "dance": ["dance hits", "edm music mix"],
    "lofi": ["lofi beats", "lofi chill music"],
}
# Titres non musicaux / compilations a exclure quand on cible un genre
_JUNK_TITLE_RE = re.compile(
    r"gameplay|walkthrough|all levels|android|ios\b|asmr|slicing|satisfying|tutorial|"
    r"compilation|non-?stop|1 hour|10 hours|playlist|spotify|top \d+ |greatest hits|"
    r"best of|hits \d{4}|\d{4} (pop|hits|songs|music)",
    re.IGNORECASE,
)
_GENRE_CACHE: dict = {}  # (titre|chaine) lowercase -> genre (TTL session)
_genre_cache_lock = threading.Lock()
_genre_infer_exec = ThreadPoolExecutor(max_workers=4, thread_name_prefix="genre")


def _genre_of(channel):
    if not channel or channel in GENERIC_CHANNELS:
        return "autre"  # chaine generique : aucun bonus genre
    return CHANNEL_GENRE_MAP.get(channel, "autre")


def _genre_key(title, channel):
    return f"{(title or '').strip().lower()}|{(channel or '').strip().lower()}"


def _parse_genre_label(raw):
    """Mappe une reponse libre Ollama vers un label de GENRE_LABELS (sinon 'autre')."""
    r = (raw or "").strip().lower()
    # match le plus long d'abord (evite 'rap' ambigue)
    for label in sorted(GENRE_LABELS, key=len, reverse=True):
        if label in r:
            return label
    if "hip" in r or "rap" in r or "drill" in r:
        return "rap fr"
    if "pop" in r:
        return "pop us"
    if "lofi" in r or "lo-fi" in r or "chill" in r:
        return "lofi"
    if "dance" in r or "electro" in r or "edm" in r:
        return "dance"
    return "autre"


def infer_genre_ollama(title, channel):
    """Genre via Ollama (liste fermee), cache RAM+BD.
    Priorite : mapping curе (chaines d'artistes connues, fiable) -> cache -> Ollama -> fallback.
    Les chaines generiques sont taggees dynamiquement (pas de mapping)."""
    key = _genre_key(title, channel)
    with _genre_cache_lock:
        if key in _GENRE_CACHE:
            return _GENRE_CACHE[key]
    # Mapping curе : fiable pour les chaines d'artistes connues (rapide, pas d'appel Ollama)
    curated = CHANNEL_GENRE_MAP.get(channel)
    if curated:
        with _genre_cache_lock:
            _GENRE_CACHE[key] = curated
        if _db_ready():
            try:
                from core import db as _db
                _db.db_genre_put(key, curated)
            except Exception:
                pass
        _tprint(f"[genre-infer] {title[:35]!r} / {channel[:18]!r} → {curated} (map)")
        return curated
    if _db_ready():
        from core import db as _db
        cached = _db.db_genre_get(key)
        if cached:
            with _genre_cache_lock:
                _GENRE_CACHE[key] = cached
            return cached
    prompt = (
        "Quel est le genre musical de cette chanson ? "
        f"{title} par {channel}. "
        f"Reponds UNIQUEMENT par un genre parmi: {', '.join(GENRE_LABELS)}. Un seul mot."
    )
    try:
        resp = ollama.chat(model=MODEL, messages=[{"role": "user", "content": prompt}],
                           options={"temperature": 0})
        genre = _parse_genre_label(resp["message"]["content"])
        _tprint(f"[genre-infer] {title[:35]!r} / {channel[:18]!r} → {genre}")
    except Exception as exc:
        genre = "autre"
        _tprint(f"[genre-infer-fallback] Ollama indisponible ({type(exc).__name__}), "
                f"{title[:28]!r} → {genre}")
    with _genre_cache_lock:
        _GENRE_CACHE[key] = genre
    if _db_ready():
        try:
            from core import db as _db
            _db.db_genre_put(key, genre)
        except Exception:
            pass
    return genre


def infer_genres_batch(items):
    """{video_id: genre} pour une liste de dicts {video_id,title,channel}, en parallele (cache RAM/BD)."""
    out = {}
    todo = []
    if _db_ready():
        from core import db as _db
        keys = {r["video_id"]: _genre_key(r.get("title"), r.get("channel")) for r in items}
        dbhits = _db.db_genre_get_many(list(keys.values()))
        for r in items:
            k = keys[r["video_id"]]
            if k in dbhits:
                out[r["video_id"]] = dbhits[k]
                with _genre_cache_lock:
                    _GENRE_CACHE[k] = dbhits[k]
    for r in items:
        if r["video_id"] in out:
            continue
        k = _genre_key(r.get("title"), r.get("channel"))
        with _genre_cache_lock:
            if k in _GENRE_CACHE:
                out[r["video_id"]] = _GENRE_CACHE[k]
                continue
        todo.append(r)
    if todo:
        futs = {_genre_infer_exec.submit(infer_genre_ollama, r.get("title", ""), r.get("channel", "")): r
                for r in todo}
        for fut, r in futs.items():
            try:
                out[r["video_id"]] = fut.result(timeout=30)
            except Exception:
                out[r["video_id"]] = CHANNEL_GENRE_MAP.get(r.get("channel", ""), "autre")
    return out


def _is_known_genre(label: str):
    """Retourne le genre normalise si label est un genre connu, sinon None."""
    g = (label or "").strip().lower()
    known = {v.lower() for v in CHANNEL_GENRE_MAP.values()} | set(GENRE_LABELS)
    return g if g in known else None
