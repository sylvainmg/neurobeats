"""NeuroBeats - persistance SQLite (stdlib uniquement).

Tables :
  history(video_id, title, channel, timestamp, duration, genre, skip)
  stats_genre(genre, plays, skips, last_played)
  stats_channel(channel, plays, skips, last_played)
  stats_hour(slot, plays)  -- slots : matin 6-12 / midi 12-14 / apres-midi 14-18 / soir 18-24 / nuit 0-6
  kv(key, value)           -- preferences, genres_favoris, playlists (JSON tel quel)
  embeddings(video_id, model_name, dim, embedding, created_at)
  genres(key, genre, created_at)
  covers(video_id, source, provider, offset, match_score, width, height, bytes)
"""
import json
import os
import sqlite3
import threading
from datetime import datetime

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # dossier backend/
DB_PATH = os.path.join(BASE, "neurobeats.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL, title TEXT DEFAULT '', channel TEXT DEFAULT '',
  timestamp TEXT NOT NULL, duration REAL, genre TEXT DEFAULT '', skip INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_history_vid ON history(video_id);
CREATE INDEX IF NOT EXISTS idx_history_ts ON history(timestamp);
CREATE TABLE IF NOT EXISTS stats_genre (
  genre TEXT PRIMARY KEY, plays INTEGER DEFAULT 0,
  skips INTEGER DEFAULT 0, last_played TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS stats_channel (
  channel TEXT PRIMARY KEY, plays INTEGER DEFAULT 0,
  skips INTEGER DEFAULT 0, last_played TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS stats_hour (
  slot TEXT PRIMARY KEY, plays INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS embeddings (
  video_id TEXT NOT NULL, model_name TEXT NOT NULL, dim INTEGER NOT NULL,
  embedding BLOB NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (video_id, model_name)
);
CREATE TABLE IF NOT EXISTS genres (
  key TEXT PRIMARY KEY, genre TEXT NOT NULL, created_at TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS covers (
  video_id TEXT PRIMARY KEY, source TEXT DEFAULT '', provider TEXT DEFAULT '',
  offset REAL, match_score REAL, width INTEGER DEFAULT 0, height INTEGER DEFAULT 0,
  bytes INTEGER DEFAULT 0, created_at TEXT DEFAULT '', last_used TEXT DEFAULT '',
  error TEXT DEFAULT ''
);
"""

_HOUR_SLOTS = [(6, 12, "matin"), (12, 14, "midi"), (14, 18, "apres-midi"),
               (18, 24, "soir"), (0, 6, "nuit")]

# Cles du profil utilisateur stockees dans la table `kv`.
_PROFILE_KEYS = ("preferences", "genres_favoris", "playlists", "identity")

# Revisions publiees au client (la base est la source de verite) : incrementees a
# chaque ecriture qui fait bouger les donnees correspondantes. Le front s'en sert
# pour se resynchroniser au lieu de garder une copie qui peut mentir.
#   stats_rev   -> ecoutes : historique, compteurs genre/chaine/heure
#   profile_rev -> profil   : notes, favoris, playlists, identite, caches derives
# Deux compteurs distincts : une ecoute ne doit pas forcer le rechargement de
# toutes les notes (potentiellement des milliers), et inversement.
_STATS_REV = 0
_PROFILE_REV = 0
_REV_LOCK = threading.Lock()


def stats_rev() -> int:
    """Revision des donnees d'ecoute (historique et compteurs)."""
    return _STATS_REV


def profile_rev() -> int:
    """Revision des donnees de profil (notes, favoris, playlists, identite)."""
    return _PROFILE_REV


def bump_stats_rev():
    """Signale un changement des donnees d'ecoute."""
    global _STATS_REV
    with _REV_LOCK:
        _STATS_REV += 1


def bump_profile_rev():
    """Signale un changement des donnees de profil."""
    global _PROFILE_REV
    with _REV_LOCK:
        _PROFILE_REV += 1


def _slot_of(ts: str) -> str:
    try:
        h = datetime.fromisoformat(ts).hour
    except (ValueError, TypeError):
        h = datetime.now().hour
    for lo, hi, name in _HOUR_SLOTS:
        if lo <= h < hi:
            return name
    return "nuit"


def _connect():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def db_init():
    """Cree toutes les tables si elles n'existent pas (idempotent)."""
    con = _connect()
    try:
        con.executescript(SCHEMA)
        con.commit()
    finally:
        con.close()


def db_ensure_schema():
    """Migre le schema : ajoute les tables manquantes (executescript idempotent)."""
    db_init()


def db_import_json() -> dict:
    """Importe music_history.json / user_profile.json dans SQLite (idempotent).

    Returns:
        dict {'history': n, 'skipped': m} : ecoutes importees et entrees ignorees.
    """
    from app import CHANNEL_GENRE_MAP  # import local : evite le cycle au chargement
    counts = {"history": 0, "skipped": 0}
    hist_path = os.path.join(BASE, "music_history.json")
    prof_path = os.path.join(BASE, "user_profile.json")
    if not os.path.exists(DB_PATH):
        db_init()
    con = _connect()
    try:
        if os.path.exists(hist_path):
            with open(hist_path, encoding="utf-8") as f:
                entries = json.load(f)
            for e in entries:
                vid = e.get("video_id", "")
                if not vid:
                    counts["skipped"] += 1
                    continue
                ts = e.get("timestamp") or datetime.now().isoformat()
                genre = CHANNEL_GENRE_MAP.get(e.get("channel", ""), "autre")
                con.execute(
                    "INSERT INTO history (video_id, title, channel, timestamp, duration, genre, skip)"
                    " VALUES (?, ?, ?, ?, ?, ?, 0)",
                    (vid, e.get("title", ""), e.get("channel", ""),
                     ts, e.get("duration"), genre))
                _bump_stats(con, genre, e.get("channel", ""), ts, False)
                counts["history"] += 1
        if os.path.exists(prof_path):
            with open(prof_path, encoding="utf-8") as f:
                profile = json.load(f)
            for key in ("preferences", "genres_favoris", "playlists"):
                if key in profile:
                    con.execute("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)",
                                (key, json.dumps(profile[key], ensure_ascii=False)))
        con.commit()
    finally:
        con.close()
    return counts


def _bump_stats(con, genre, channel, ts, skipped: bool):
    slot = _slot_of(ts)
    pcol = "skips" if skipped else "plays"
    for table, col, val in (("stats_genre", "genre", genre or "autre"),
                            ("stats_channel", "channel", channel or "?")):
        row = con.execute(f"SELECT plays, skips FROM {table} WHERE {col}=?", (val,)).fetchone()
        if row is None:
            con.execute(
                f"INSERT INTO {table} ({col}, plays, skips, last_played) VALUES (?, ?, ?, ?)",
                (val, 0 if skipped else 1, 1 if skipped else 0, ts))
        else:
            con.execute(
                f"UPDATE {table} SET {pcol}={pcol}+1, last_played=? WHERE {col}=?",
                (ts, val))
    row = con.execute("SELECT plays FROM stats_hour WHERE slot=?", (slot,)).fetchone()
    if row is None:
        con.execute("INSERT INTO stats_hour (slot, plays) VALUES (?, ?)", (slot, 0 if skipped else 1))
    elif not skipped:
        con.execute("UPDATE stats_hour SET plays=plays+1 WHERE slot=?", (slot,))


def db_log_play(video_id, title="", channel="", duration=None, genre=""):
    """Enregistre une ecoute (+ stats genre/chaine/heure). Retourne le timestamp."""
    ts = datetime.now().isoformat()
    con = _connect()
    try:
        con.execute(
            "INSERT INTO history (video_id, title, channel, timestamp, duration, genre, skip)"
            " VALUES (?, ?, ?, ?, ?, ?, 0)",
            (video_id, title, channel, ts, duration, genre or "autre"))
        _bump_stats(con, genre or "autre", channel, ts, False)
        con.commit()
    finally:
        con.close()
    bump_stats_rev()
    return ts


def db_log_skip(video_id):
    """Marque la derniere ecoute de video_id comme skippee et met a jour les compteurs.

    Returns:
        True si une ecoute a ete trouvee et marquee, False sinon.
    """
    ts = datetime.now().isoformat()
    con = _connect()
    try:
        row = con.execute(
            "SELECT id, genre, channel FROM history WHERE video_id=? ORDER BY id DESC LIMIT 1",
            (video_id,)).fetchone()
        if row is None:
            return False
        con.execute("UPDATE history SET skip=1 WHERE id=?", (row["id"],))
        _bump_stats(con, row["genre"], row["channel"], ts, True)
        con.commit()
        bump_stats_rev()
        return True
    finally:
        con.close()


def db_get_history(n=50):
    """Retourne les n dernieres ecoutes (ordre antichronologique), `id` inclus.

    L'`id` sert a la suppression unitaire depuis la page Profil.
    """
    con = _connect()
    try:
        rows = con.execute(
            "SELECT id, video_id, title, channel, timestamp, duration, genre, skip"
            " FROM history ORDER BY id DESC LIMIT ?", (n,)).fetchall()
        return [dict(r) for r in rows]
    finally:
        con.close()


def db_delete_history_entry(entry_id: int) -> bool:
    """Supprime une ecoute par son id. True si une ligne a ete supprimee."""
    con = _connect()
    try:
        cur = con.execute("DELETE FROM history WHERE id=?", (entry_id,))
        con.commit()
        deleted = cur.rowcount > 0
    finally:
        con.close()
    if deleted:
        bump_stats_rev()
    return deleted


def db_clear_history() -> int:
    """Vide tout l'historique d'ecoute. Retourne le nombre de lignes supprimees."""
    con = _connect()
    try:
        cur = con.execute("DELETE FROM history")
        con.commit()
        removed = cur.rowcount
    finally:
        con.close()
    bump_stats_rev()
    return removed


def db_recompute_stats():
    """Reconstruit les stats agregees (genre/chaine/heure) depuis l'historique.

    Necessaire apres une suppression d'ecoutes : sans cela les compteurs
    resteraient fantomes (ils sont incrementaux a l'ecriture).
    """
    con = _connect()
    try:
        for table in ("stats_genre", "stats_channel", "stats_hour"):
            con.execute(f"DELETE FROM {table}")
        rows = con.execute(
            "SELECT genre, channel, timestamp, skip FROM history").fetchall()
        for row in rows:
            _bump_stats(con, row["genre"] or "autre", row["channel"] or "?",
                        row["timestamp"], bool(row["skip"]))
        con.commit()
    finally:
        con.close()
    bump_stats_rev()


def db_list_preferences() -> dict:
    """Notes attribuees : {video_id: {rating, title, channel}}."""
    row = _connect().execute("SELECT value FROM kv WHERE key='preferences'").fetchone()
    if row is None:
        return {}
    try:
        return json.loads(row["value"])
    except json.JSONDecodeError:
        return {}


def db_delete_preference(video_id: str) -> bool:
    """Retire la note d'un titre (et l'artiste favori associe le cas echeant)."""
    prefs = db_list_preferences()
    if video_id not in prefs:
        return False
    prefs.pop(video_id, None)
    profile = db_profile_get({"preferences": {}, "genres_favoris": [], "playlists": []})
    profile["preferences"] = prefs
    favorites = list(profile.get("genres_favoris", []))
    entry = _preference_channel(video_id)
    if entry and entry in favorites:
        # L'artiste reste favori s'il est encore porte par une autre note >= 4.
        still = any(
            (p.get("channel") == entry and int(p.get("rating", 0) or 0) >= 4)
            for vid, p in prefs.items()
        )
        if not still:
            favorites.remove(entry)
            profile["genres_favoris"] = favorites
    db_profile_set(profile)
    return True


def _preference_channel(video_id: str) -> str:
    """Chaine associee a une note (avant suppression)."""
    return (db_list_preferences().get(video_id) or {}).get("channel", "")


def db_set_favorite(channel: str, favorite: bool = True) -> list:
    """Ajoute/retire un artiste des favoris. Retourne la liste a jour."""
    profile = db_profile_get({"preferences": {}, "genres_favoris": [], "playlists": []})
    favorites = [c for c in profile.get("genres_favoris", []) if c != channel]
    if favorite and channel:
        favorites.append(channel)
    profile["genres_favoris"] = favorites
    db_profile_set(profile)
    return favorites


def db_clear_derived_caches() -> dict:
    """Vide les caches derives (genres inferes, embeddings). Retourne les compteurs."""
    con = _connect()
    try:
        removed = {}
        for table in ("genres", "embeddings"):
            cur = con.execute(f"DELETE FROM {table}")
            removed[table] = cur.rowcount
        con.commit()
    finally:
        con.close()
    bump_profile_rev()
    return removed


def db_count_rows() -> dict:
    """Compteurs par table (page Profil : « mes donnees »)."""
    con = _connect()
    try:
        out = {}
        for table in ("history", "stats_genre", "stats_channel", "embeddings", "genres"):
            out[table] = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        return out
    finally:
        con.close()


def db_history_count():
    """Nombre total d'ecoutes enregistrees."""
    con = _connect()
    try:
        return con.execute("SELECT COUNT(*) FROM history").fetchone()[0]
    finally:
        con.close()


def db_get_user_stats() -> dict:
    """Statistiques d'ecoute agregees.

    Returns:
        dict {plays_total, genre_top, artiste_top, heure_pref, skip_count,
              skip_ratio, duree_moyenne}.
    """
    con = _connect()
    try:
        total = con.execute("SELECT COUNT(*) FROM history").fetchone()[0]
        skips = con.execute("SELECT COUNT(*) FROM history WHERE skip=1").fetchone()[0]
        g = con.execute(
            "SELECT genre, plays FROM stats_genre ORDER BY plays DESC LIMIT 1").fetchone()
        c = con.execute(
            "SELECT channel, plays FROM stats_channel ORDER BY plays DESC LIMIT 1").fetchone()
        h = con.execute(
            "SELECT slot, plays FROM stats_hour ORDER BY plays DESC LIMIT 1").fetchone()
        avg = con.execute(
            "SELECT AVG(duration) FROM history WHERE duration IS NOT NULL").fetchone()[0]
        return {
            "plays_total": total,
            "genre_top": {"genre": g["genre"], "plays": g["plays"]} if g else None,
            "artiste_top": {"channel": c["channel"], "plays": c["plays"]} if c else None,
            "heure_pref": {"slot": h["slot"], "plays": h["plays"]} if h else None,
            "skip_count": skips,
            "skip_ratio": round(skips / total, 3) if total else 0.0,
            "duree_moyenne": round(avg, 1) if avg else None,
        }
    finally:
        con.close()


def db_profile_get(default=None):
    """Lit les preferences/genres_favoris/playlists/identity (kv)."""
    con = _connect()
    try:
        out = dict(default) if isinstance(default, dict) else {}
        for key in _PROFILE_KEYS:
            row = con.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
            if row is not None:
                try:
                    out[key] = json.loads(row["value"])
                except json.JSONDecodeError:
                    pass
        return out
    finally:
        con.close()


def db_profile_set(profile: dict):
    """Ecrit les preferences/genres_favoris/playlists/identity (kv)."""
    con = _connect()
    try:
        for key in _PROFILE_KEYS:
            if key in profile:
                con.execute("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)",
                            (key, json.dumps(profile[key], ensure_ascii=False)))
        con.commit()
    finally:
        con.close()
    bump_profile_rev()


def db_playlists_get():
    """Retourne la liste des playlists sauvegardees."""
    return db_profile_get({"playlists": []}).get("playlists", [])


def db_playlists_save(playlists):
    """Sauvegarde la liste des playlists."""
    con = _connect()
    try:
        con.execute("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)",
                    ("playlists", json.dumps(playlists, ensure_ascii=False)))
        con.commit()
    finally:
        con.close()
    # Le compteur de playlists fait partie du profil public.
    bump_profile_rev()


def db_genre_get(key):
    """Genre infere en cache pour une cle 'titre|chaine' (lowercase), ou None."""
    con = _connect()
    try:
        row = con.execute("SELECT genre FROM genres WHERE key=?", (key,)).fetchone()
        return row["genre"] if row else None
    finally:
        con.close()


def db_genre_get_many(keys):
    """{cle: genre} pour les cles presentes en cache."""
    out = {}
    if not keys:
        return out
    con = _connect()
    try:
        for k in keys:
            row = con.execute("SELECT genre FROM genres WHERE key=?", (k,)).fetchone()
            if row is not None:
                out[k] = row["genre"]
        return out
    finally:
        con.close()


def db_genre_put(key, genre):
    """Met en cache un genre infere pour une cle 'titre|chaine'."""
    from datetime import datetime as _dt
    con = _connect()
    try:
        con.execute("INSERT OR REPLACE INTO genres (key, genre, created_at) VALUES (?, ?, ?)",
                    (key, genre, _dt.now().isoformat()))
        con.commit()
    finally:
        con.close()


_COVER_FIELDS = ("source", "provider", "offset", "match_score", "width",
                 "height", "bytes", "error")


def db_cover_get(video_id):
    """Provenance enregistree pour une pochette, ou None (jamais tentee)."""
    con = _connect()
    try:
        row = con.execute("SELECT * FROM covers WHERE video_id=?", (video_id,)).fetchone()
        return dict(row) if row is not None else None
    finally:
        con.close()


def db_cover_put(video_id, **fields):
    """Enregistre la provenance d'une pochette — ou d'un echec (`source='miss'`).

    La table est la memoire longue des pochettes : elle evite de re-solliciter
    les fournisseurs d'album art et porte le cache negatif. Le fichier lui-meme
    vit dans COVERS_DIR ; ici on ne garde que ce qui l'explique.
    """
    now = datetime.now().isoformat()
    columns = ", ".join(_COVER_FIELDS)
    placeholders = ", ".join("?" * len(_COVER_FIELDS))
    con = _connect()
    try:
        con.execute(
            f"INSERT OR REPLACE INTO covers (video_id, {columns}, created_at, last_used)"
            f" VALUES (?, {placeholders}, ?, ?)",
            (video_id, *(fields.get(key) for key in _COVER_FIELDS), now, now))
        con.commit()
    finally:
        con.close()


def db_cover_touch(video_id):
    """Marque la pochette comme recemment servie (eviction LRU)."""
    con = _connect()
    try:
        con.execute("UPDATE covers SET last_used=? WHERE video_id=?",
                    (datetime.now().isoformat(), video_id))
        con.commit()
    finally:
        con.close()


def db_covers_lru():
    """Pochettes presentes en cache, de la moins recemment servie a la plus recente."""
    con = _connect()
    try:
        rows = con.execute(
            "SELECT video_id, last_used, bytes FROM covers WHERE source != 'miss'"
            " ORDER BY last_used ASC").fetchall()
        return [dict(row) for row in rows]
    finally:
        con.close()


def db_cover_delete(video_id) -> bool:
    """Retire la ligne d'une pochette. True si une ligne existait."""
    con = _connect()
    try:
        cur = con.execute("DELETE FROM covers WHERE video_id=?", (video_id,))
        con.commit()
        return cur.rowcount > 0
    finally:
        con.close()


def db_clear_covers() -> int:
    """Vide la table des pochettes (fichiers inclus, cf. services/covers.clear)."""
    con = _connect()
    try:
        cur = con.execute("DELETE FROM covers")
        con.commit()
        return cur.rowcount
    finally:
        con.close()


EMBED_MODEL = "all-MiniLM-L6-v2"


def db_embed_get(video_id, model_name=EMBED_MODEL):
    """Retourne le ndarray normalise en cache, ou None (miss ou autre modele)."""
    import io
    con = _connect()
    try:
        row = con.execute(
            "SELECT embedding FROM embeddings WHERE video_id=? AND model_name=?",
            (video_id, model_name)).fetchone()
        if row is None:
            return None
        import numpy as np
        return np.load(io.BytesIO(row["embedding"]))
    except Exception:
        return None
    finally:
        con.close()


def db_embed_get_many(video_ids, model_name=EMBED_MODEL):
    """{video_id: ndarray} pour les hits uniquement."""
    import io
    out = {}
    if not video_ids:
        return out
    con = _connect()
    try:
        import numpy as np
        for vid in video_ids:
            row = con.execute(
                "SELECT embedding FROM embeddings WHERE video_id=? AND model_name=?",
                (vid, model_name)).fetchone()
            if row is not None:
                try:
                    out[vid] = np.load(io.BytesIO(row["embedding"]))
                except Exception:
                    pass
        return out
    finally:
        con.close()


def db_embed_put(video_id, vector, model_name=EMBED_MODEL):
    """Stocke un vecteur (ndarray ou liste) en BLOB. Ecrase si le modele change."""
    import io
    from datetime import datetime as _dt
    import numpy as np
    arr = np.asarray(vector, dtype=np.float32)
    buf = io.BytesIO()
    np.save(buf, arr, allow_pickle=False)
    con = _connect()
    try:
        con.execute(
            "INSERT OR REPLACE INTO embeddings (video_id, model_name, dim, embedding, created_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (video_id, model_name, int(arr.shape[0]), buf.getvalue(), _dt.now().isoformat()))
        con.commit()
    finally:
        con.close()
