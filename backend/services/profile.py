"""Profil utilisateur : identite, statistiques, gestion des donnees recoltees.

Regroupe aussi les fonctions exposees a l'assistant **dedie aux gouts**
(scope « profile » du chat) : resume des gouts, notes, favoris, historique.

Toutes les fonctions renvoient du JSON (convention du projet : `run_tool` et les
tools du chat les consomment tels quels) et sont appelees hors event-loop.
"""
import json
import re
from datetime import datetime

from services import state
from services.db_access import _db_ready, get_user_stats, hist_read, profile_read, profile_write
from services.state import _tprint

MAX_NAME_LEN = 60
# Photo integree : data URL redimensionnee cote navigateur (~256 px).
_AVATAR_RE = re.compile(r"^data:image/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=\s]+$")
AVATAR_MAX_CHARS = 300_000  # ~220 Ko binaires

DEFAULT_DISPLAY_NAME = "Auditeur"


def _now() -> str:
    return datetime.now().isoformat()


def _db_module():
    """Module core.db, ou None si la base n'est pas initialisee."""
    if not _db_ready():
        return None
    from core import db
    return db


# ---------------------------------------------------------------------- identite

def _read_identity() -> dict:
    raw = profile_read({"identity": {}}).get("identity") or {}
    first = str(raw.get("first_name", "") or "")
    last = str(raw.get("last_name", "") or "")
    return {
        "first_name": first,
        "last_name": last,
        "display_name": str(raw.get("display_name", "") or "") or _display_name(first, last),
        "avatar": str(raw.get("avatar", "") or ""),
        "updated": str(raw.get("updated", "") or ""),
    }


def _display_name(first: str, last: str) -> str:
    full = f"{first} {last}".strip()
    return full or DEFAULT_DISPLAY_NAME


def _write_identity(identity: dict):
    profile = profile_read()
    profile["identity"] = identity
    profile_write(profile)


def _clean_name(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "").strip())[:MAX_NAME_LEN]


def update_identity(first_name: str | None = None, last_name: str | None = None) -> str:
    """Met a jour prenom et/ou nom (mise a jour partielle).

    `None` = champ inchange ; sinon normalisation (espaces, longueur) et
    `display_name` recalcule.
    """
    identity = _read_identity()
    first = identity["first_name"] if first_name is None else _clean_name(first_name)
    last = identity["last_name"] if last_name is None else _clean_name(last_name)
    identity.update({
        "first_name": first,
        "last_name": last,
        "display_name": _display_name(first, last),
        "updated": _now(),
    })
    _write_identity(identity)
    return json.dumps({"status": "updated", "identity": identity}, ensure_ascii=False)


def data_overview() -> str:
    """Compteurs des donnees recoltees (page Profil)."""
    return _overview()


def set_avatar(avatar: str) -> str:
    """Enregistre la photo (data URL). Valide le type et la taille."""
    value = (avatar or "").strip()
    if not value:
        return json.dumps({"error": "Image invalide : aucune donnee recue."}, ensure_ascii=False)
    if not _AVATAR_RE.match(value):
        return json.dumps(
            {"error": "Format d'image invalide (png, jpeg ou webp attendu)."},
            ensure_ascii=False)
    if len(value) > AVATAR_MAX_CHARS:
        return json.dumps(
            {"error": f"Image invalide : trop lourde (max ~{AVATAR_MAX_CHARS // 1024} Ko)."},
            ensure_ascii=False)
    identity = _read_identity()
    identity["avatar"] = value
    identity["updated"] = _now()
    _write_identity(identity)
    return json.dumps({"status": "updated", "identity": identity}, ensure_ascii=False)


def clear_avatar() -> str:
    """Retire la photo de profil."""
    identity = _read_identity()
    identity["avatar"] = ""
    identity["updated"] = _now()
    _write_identity(identity)
    return json.dumps({"status": "cleared", "identity": identity}, ensure_ascii=False)


def get_profile() -> str:
    """Identite + statistiques + compteurs (page Profil)."""
    identity = _read_identity()
    try:
        stats = json.loads(get_user_stats())
    except Exception:
        stats = {}
    return json.dumps({
        "identity": identity,
        "stats": stats,
        "overview": json.loads(_overview()),
    }, ensure_ascii=False)


# ------------------------------------------------------- donnees recoltees

def _overview() -> str:
    """Compteurs par categorie (sans le detail)."""
    counts = {}
    db = _db_module()
    if db is not None:
        try:
            counts = db.db_count_rows()
        except Exception:
            counts = {}
    profile = profile_read({"preferences": {}, "genres_favoris": [], "playlists": []})
    playlists = profile.get("playlists", []) or []
    return json.dumps({
        "history": counts.get("history", 0),
        "ratings": len(profile.get("preferences", {}) or {}),
        "favorites": len(profile.get("genres_favoris", []) or []),
        "playlists": len(playlists),
        "cached_genres": counts.get("genres", 0),
        "embeddings": counts.get("embeddings", 0),
    }, ensure_ascii=False)


def list_history(limit: int = 100, offset: int = 0) -> str:
    """Dernieres ecoutes, avec leur `id` (suppression unitaire), page par page.

    `offset` permet au modal d'historique de charger par tranches (scroll
    infini) au lieu de tout ramener d'un coup : 743 lignes dans le DOM ne se
    rendent pas d'un seul bloc.
    """
    try:
        limit = max(1, min(int(limit or 100), 5000))
    except (TypeError, ValueError):
        limit = 100
    try:
        offset = max(0, int(offset or 0))
    except (TypeError, ValueError):
        offset = 0
    db = _db_module()
    if db is not None:
        rows = db.db_get_history(limit, offset)
    else:  # repli JSON : pas d'id stable, on en fabrique un index
        rows = list(reversed(hist_read(offset + limit)))
        rows = rows[offset:offset + limit]
        for index, row in enumerate(rows):
            row["id"] = index
    return json.dumps({"entries": rows}, ensure_ascii=False)


def delete_history_entry(entry_id: int) -> str:
    """Supprime une ecoute et recalcule les stats agregees."""
    db = _db_module()
    if db is None:
        return json.dumps({"error": "Historique indisponible (base non initialisee)."},
                          ensure_ascii=False)
    try:
        entry_id = int(entry_id)
    except (TypeError, ValueError):
        return json.dumps({"error": f"Identifiant invalide '{entry_id}'."}, ensure_ascii=False)
    if not db.db_delete_history_entry(entry_id):
        return json.dumps({"error": f"Ecoute {entry_id} introuvable."}, ensure_ascii=False)
    db.db_recompute_stats()
    return json.dumps({"status": "deleted", "id": entry_id}, ensure_ascii=False)


def clear_history(confirm: bool = False) -> str:
    """Vide tout l'historique (et les stats agregees). Exige `confirm=True`."""
    if not confirm:
        return json.dumps(
            {"error": "Confirmation invalide : precise `confirm=1` pour effacer l'historique."},
            ensure_ascii=False)
    db = _db_module()
    if db is None:
        return json.dumps({"error": "Historique indisponible (base non initialisee)."},
                          ensure_ascii=False)
    removed = db.db_clear_history()
    db.db_recompute_stats()
    return json.dumps({"status": "cleared", "removed": removed}, ensure_ascii=False)


def list_preferences() -> str:
    """Titres notes (★) : {video_id, rating, title, channel}."""
    prefs = profile_read({"preferences": {}}).get("preferences", {}) or {}
    items = [{"video_id": vid, "rating": int(p.get("rating", 0) or 0),
              "title": p.get("title", ""), "channel": p.get("channel", "")}
             for vid, p in prefs.items()]
    items.sort(key=lambda x: (-x["rating"], x["title"].lower()))
    return json.dumps({"ratings": items}, ensure_ascii=False)


def delete_preference(video_id: str) -> str:
    """Retire la note d'un titre."""
    vid = (video_id or "").strip()
    db = _db_module()
    if db is None:
        return json.dumps({"error": "Notes indisponibles (base non initialisee)."},
                          ensure_ascii=False)
    if not db.db_delete_preference(vid):
        return json.dumps({"error": f"Aucune note pour '{vid}'."}, ensure_ascii=False)
    return json.dumps({"status": "deleted", "video_id": vid}, ensure_ascii=False)


def list_favorites() -> str:
    """Artistes favoris (issus des notes ★ ≥ 4)."""
    favorites = profile_read({"genres_favoris": []}).get("genres_favoris", []) or []
    return json.dumps({"favorites": favorites}, ensure_ascii=False)


def add_favorite(channel: str) -> str:
    """Ajoute un artiste aux favoris."""
    name = (channel or "").strip()
    if not name:
        return json.dumps({"error": "Artiste invalide."}, ensure_ascii=False)
    db = _db_module()
    if db is None:
        return json.dumps({"error": "Favoris indisponibles (base non initialisee)."},
                          ensure_ascii=False)
    favorites = db.db_set_favorite(name, True)
    return json.dumps({"status": "added", "channel": name, "favorites": favorites},
                      ensure_ascii=False)


def remove_favorite(channel: str) -> str:
    """Retire un artiste des favoris."""
    name = (channel or "").strip()
    db = _db_module()
    if db is None:
        return json.dumps({"error": "Favoris indisponibles (base non initialisee)."},
                          ensure_ascii=False)
    current = profile_read({"genres_favoris": []}).get("genres_favoris", []) or []
    if name not in current:
        return json.dumps({"error": f"'{name}' n'est pas dans les favoris."}, ensure_ascii=False)
    favorites = db.db_set_favorite(name, False)
    return json.dumps({"status": "removed", "channel": name, "favorites": favorites},
                      ensure_ascii=False)


def clear_caches() -> str:
    """Vide les caches derives : genres inferes, embeddings, URLs audio, pochettes."""
    removed = {"genres": 0, "embeddings": 0, "urls": 0, "covers": 0}
    db = _db_module()
    if db is not None:
        try:
            counts = db.db_clear_derived_caches()
            removed["genres"] = counts.get("genres", 0)
            removed["embeddings"] = counts.get("embeddings", 0)
            removed["lyrics"] = counts.get("lyrics", 0)
        except Exception as exc:
            _tprint(f"[profile] purge caches sqlite echec : {exc}")
    try:
        from services.audio import _save_stream_cache
        removed["urls"] = len(state.STREAM_CACHE)
        state.STREAM_CACHE.clear()
        _save_stream_cache()
    except Exception as exc:
        _tprint(f"[profile] purge cache URL echec : {exc}")
    try:
        from services import covers
        removed["covers"] = covers.clear()
    except Exception as exc:
        _tprint(f"[profile] purge cache pochettes echec : {exc}")
    return json.dumps({"status": "cleared", "removed": removed}, ensure_ascii=False)


def delete_last_listen(video_id: str) -> str:
    """Retire la derniere ecoute d'un titre (outil de l'assistant gouts)."""
    vid = (video_id or "").strip()
    db = _db_module()
    if db is None:
        return json.dumps({"error": "Historique indisponible (base non initialisee)."},
                          ensure_ascii=False)
    rows = db.db_get_history(500)
    entry = next((r for r in rows if r.get("video_id") == vid), None)
    if entry is None:
        return json.dumps({"error": f"Aucune ecoute de '{vid}' dans l'historique."},
                          ensure_ascii=False)
    db.db_delete_history_entry(entry["id"])
    db.db_recompute_stats()
    return json.dumps({"status": "deleted", "id": entry["id"], "video_id": vid,
                       "title": entry.get("title", "")}, ensure_ascii=False)


def get_taste_summary() -> str:
    """Resume des gouts : stats d'ecoute + notes + favoris + playlists + compteurs."""
    try:
        stats = json.loads(get_user_stats())
    except Exception:
        stats = {}
    prefs = json.loads(list_preferences()).get("ratings", [])
    liked = [p for p in prefs if p["rating"] >= 4]
    disliked = [p for p in prefs if p["rating"] <= 2]
    favorites = json.loads(list_favorites()).get("favorites", [])
    # Playlists : contenu agrege (artistes recurrents, titres gardes) pour que
    # l'analyse des gouts voie ce que l'utilisateur a choisi de conserver.
    playlists = profile_read({"playlists": []}).get("playlists", []) or []
    artist_counts: dict = {}
    for playlist in playlists:
        for song in (playlist or {}).get("songs") or []:
            channel = (song or {}).get("channel")
            if channel:
                artist_counts[channel] = artist_counts.get(channel, 0) + 1
    playlist_digest = {
        "count": len(playlists),
        "names": [p.get("name", "") for p in playlists][:10],
        "top_artists": [c for c, _ in sorted(artist_counts.items(),
                                             key=lambda kv: -kv[1])[:5]],
    }
    return json.dumps({
        "stats": stats,
        "favorites": favorites,
        "liked": liked[:10],
        "disliked": disliked[:10],
        "rated_count": len(prefs),
        "playlists": playlist_digest,
        "overview": json.loads(_overview()),
    }, ensure_ascii=False)
