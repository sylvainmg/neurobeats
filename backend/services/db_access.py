"""Acces persistance (SQLite via core.db, fallback JSON) : historique et profil."""
import json
import os
from collections import Counter
from datetime import datetime

from core.config import BASE
from services import state
from services.state import _tprint, _remember, load_json, save_json


def _db_ready() -> bool:
    try:
        from core import db as _db
        if not os.path.exists(_db.DB_PATH):
            return False
        _db.db_ensure_schema()  # ajoute les tables manquantes (embeddings, genres)
        return True
    except Exception:
        return False


def _migrate_json_to_db():
    """Import auto au 1er run : JSON -> SQLite puis rename .bak (idempotent)."""
    from core import db as _db
    if os.path.exists(_db.DB_PATH):
        return
    if not (os.path.exists(f"{BASE}/music_history.json")
            or os.path.exists(f"{BASE}/user_profile.json")):
        _db.db_init()
        return
    counts = _db.db_import_json()
    _tprint(f"migration SQLite : {counts['history']} ecoutes importees")
    for name in ("music_history.json", "user_profile.json"):
        src, dst = f"{BASE}/{name}", f"{BASE}/{name}.bak"
        try:
            if os.path.exists(src) and not os.path.exists(dst):
                os.rename(src, dst)
        except OSError as exc:
            _tprint(f"rename {name} -> .bak echec : {exc}")


def hist_read(n=200):
    """Historique recent (SQLite si dispo, sinon JSON). Ordre chronologique."""
    if _db_ready():
        from core import db as _db
        rows = _db.db_get_history(n)
        rows.reverse()  # db renvoie DESC : on remet chronologique comme le JSON
        return rows
    return load_json(f"{BASE}/music_history.json", [])[-n:]


def hist_append(video_id, title="", channel="", duration=None, genre=None):
    """Loggue une ecoute (+stats genre/channel/heure). Retourne timestamp.
    genre infere (Ollama) si fourni, sinon mapping chaine."""
    from services.genres import _genre_of
    genre = genre or _genre_of(channel)
    if _db_ready():
        from core import db as _db
        return _db.db_log_play(video_id, title, channel, duration, genre)
    history = load_json(f"{BASE}/music_history.json", [])
    entry = {"video_id": video_id, "title": title, "channel": channel,
             "timestamp": datetime.now().isoformat(), "genre": genre}
    if duration is not None:
        entry["duration"] = duration
    history.append(entry)
    save_json(f"{BASE}/music_history.json", history)
    return entry["timestamp"]


def profile_read(default=None):
    """Lit le profil utilisateur (SQLite si dispo, sinon JSON)."""
    default = default if default is not None else {"preferences": {}, "genres_favoris": [], "playlists": []}
    if _db_ready():
        from core import db as _db
        return _db.db_profile_get(default)
    return load_json(f"{BASE}/user_profile.json", default)


def profile_write(profile: dict):
    """Ecrit le profil utilisateur (SQLite si dispo, sinon JSON)."""
    if _db_ready():
        from core import db as _db
        _db.db_profile_set(profile)
        return
    save_json(f"{BASE}/user_profile.json", profile)


def get_user_stats() -> str:
    """Stats d'ecoute : genre/artiste top, creneau prefere, skips, duree moyenne."""
    from services.genres import _genre_of
    if _db_ready():
        from core import db as _db
        stats = _db.db_get_user_stats()
    else:  # fallback JSON : compteurs simples sans skips ni heures fines
        history = load_json(f"{BASE}/music_history.json", [])
        chans = Counter(h.get("channel") for h in history if h.get("channel"))
        genres = Counter(_genre_of(h.get("channel", "")) for h in history)
        stats = {
            "plays_total": len(history),
            "genre_top": {"genre": genres.most_common(1)[0][0],
                          "plays": genres.most_common(1)[0][1]} if genres else None,
            "artiste_top": {"channel": chans.most_common(1)[0][0],
                            "plays": chans.most_common(1)[0][1]} if chans else None,
            "heure_pref": None, "skip_count": 0, "skip_ratio": 0.0, "duree_moyenne": None,
        }
    return json.dumps(stats, ensure_ascii=False)


def _meta(video_id):
    if video_id in state.KNOWN:
        return {"video_id": video_id, **state.KNOWN[video_id]}
    for h in hist_read(500):
        if h.get("video_id") == video_id:
            _remember(video_id, h.get("title", ""), h.get("channel", ""))
            return {"video_id": video_id, "title": h.get("title", ""), "channel": h.get("channel", "")}
    profile = profile_read({})
    for pl in profile.get("playlists", []):
        for s in pl.get("songs", []):
            if isinstance(s, dict) and s.get("video_id") == video_id:
                _remember(video_id, s.get("title", ""), s.get("channel", ""))
                return {"video_id": video_id, "title": s.get("title", ""), "channel": s.get("channel", "")}
    return None
