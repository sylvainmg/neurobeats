"""Playlists : CRUD (creation, lecture, modification, suppression) et lecture.

Le stockage est un blob JSON dans la table `kv` (cle `playlists`), lu/ecrit via
`profile_read`/`profile_write`. Chaque playlist porte un `id` stable : les
operations se font par id (ou par nom, resolu a la volee) pour rester robustes au
renommage. Les playlists historiques sans `id` sont migrees a la premiere lecture.
"""
import json
import uuid
from collections import Counter as _C
from datetime import datetime

from core.config import VIDEO_ID_RE
from services import state
from services.audio import _prefetch, play_music
from services.db_access import _meta, profile_read, profile_write
from services.state import _remember, _tprint

# File de lecture en cours (RAM) : [{video_id, title, channel}]
_PLAY_QUEUE: list = []
_PLAY_POS: int = 0
_PLAY_NAME: str = ""

# Revision des playlists : incrementee a chaque ecriture. Poussee par le
# WebSocket, elle permet au client de se resynchroniser des qu'une playlist
# change — y compris quand c'est l'assistant IA qui l'a modifiee.
_REV: int = 0


def playlists_rev() -> int:
    """Compteur de revision des playlists (0 = jamais ecrit depuis le demarrage)."""
    return _REV


def _now() -> str:
    return datetime.now().isoformat()


# ------------------------------------------------------------------ persistance

def _normalize(raw) -> tuple[dict, bool]:
    """Normalise une playlist et signale si quelque chose a change (migration)."""
    if not isinstance(raw, dict):
        return {}, False
    playlist_id = raw.get("id")
    if not isinstance(playlist_id, str) or not playlist_id:
        playlist_id = uuid.uuid4().hex
    name = (raw.get("name") or "").strip() or "Sans titre"
    songs = [s for s in (raw.get("songs") or []) if isinstance(s, dict) and s.get("video_id")]
    created = raw.get("created") or _now()
    clean = {
        "id": playlist_id,
        "name": name,
        "mood": raw.get("mood") or "",
        "songs": songs,
        "created": created,
        "updated": raw.get("updated") or created,
    }
    return clean, clean != raw


def _load_playlists() -> list:
    """Playlists normalisees ; migre (attribue les `id` manquants) si necessaire."""
    raw = profile_read({"playlists": []}).get("playlists", [])
    if not isinstance(raw, list):
        return []
    playlists, migrated = [], False
    for entry in raw:
        clean, changed = _normalize(entry)
        if clean:
            playlists.append(clean)
        migrated = migrated or changed
    if migrated:
        _save_playlists(playlists)
        _tprint(f"[playlists] migration : {len(playlists)} playlist(s) normalisee(s)")
    return playlists


def _save_playlists(playlists: list):
    global _REV
    profile = profile_read()
    profile["playlists"] = playlists
    profile_write(profile)
    _REV += 1  # signale la modification aux clients temps reel


def _find(playlist: str) -> dict | None:
    """Resout une playlist par id, puis par nom (insensible a la casse)."""
    want = (playlist or "").strip()
    if not want:
        return None
    playlists = _load_playlists()
    for entry in playlists:
        if entry["id"] == want:
            return entry
    low = want.lower()
    for entry in playlists:
        if entry["name"].lower() == low:
            return entry
    return None


def _unique_name(name: str, playlists: list, exclude_id: str | None = None) -> str:
    """Nom libre : suffixe « (2) », « (3) »… si le nom est deja pris."""
    base = (name or "").strip() or "Sans titre"
    taken = {p["name"].lower() for p in playlists if p["id"] != exclude_id}
    if base.lower() not in taken:
        return base
    index = 2
    while f"{base} ({index})".lower() in taken:
        index += 1
    return f"{base} ({index})"


def _not_found(playlist: str) -> str:
    return json.dumps({"error": f"Playlist '{playlist}' introuvable."}, ensure_ascii=False)


# ----------------------------------------------------------------------- lecture

def list_playlists(video_id: str = "") -> str:
    """Resumes (sans les titres) : pour la bibliotheque et la barre laterale.

    Si `video_id` est fourni, chaque resume porte `contains` : permet au modal
    « ajouter a une playlist » de cocher celles qui contiennent deja le titre.
    """
    playlists = _load_playlists()
    want = (video_id or "").strip()
    resumes = []
    for p in playlists:
        item = {"id": p["id"], "name": p["name"], "mood": p["mood"], "count": len(p["songs"]),
                "cover": (p["songs"][0]["video_id"] if p["songs"] else ""),
                "created": p["created"], "updated": p["updated"]}
        if want:
            item["contains"] = any(s.get("video_id") == want for s in p["songs"])
        resumes.append(item)
    return json.dumps({"playlists": resumes}, ensure_ascii=False)


def get_playlist(playlist: str) -> str:
    """Playlist complete, titres inclus."""
    found = _find(playlist)
    if found is None:
        return _not_found(playlist)
    return json.dumps({"playlist": found}, ensure_ascii=False)


# ---------------------------------------------------------------------- creation

def create_empty_playlist(name: str) -> str:
    """Nouvelle playlist vide (creation manuelle depuis l'UI)."""
    playlists = _load_playlists()
    stamp = _now()
    created = {"id": uuid.uuid4().hex, "name": _unique_name(name, playlists), "mood": "",
               "songs": [], "created": stamp, "updated": stamp}
    playlists.append(created)
    _save_playlists(playlists)
    return json.dumps({"status": "created", "playlist": created}, ensure_ascii=False)


def create_playlist_from(name: str, video_ids: list) -> str:
    """Cree une playlist contenant EXACTEMENT les titres donnes (selection UI).

    Utilise par « Enregistrer en playlist » depuis Decouvrir : on sauvegarde ce que
    l'utilisateur voit, pas une nouvelle generation. Les titres inconnus du moteur
    sont ignores ; si aucun ne reste, on renvoie une erreur explicite.
    """
    wanted = []
    seen = set()
    for raw in video_ids or []:
        vid = (raw or "").strip() if isinstance(raw, str) else ""
        if not vid or vid in seen or not VIDEO_ID_RE.match(vid):
            continue
        seen.add(vid)
        wanted.append(vid)
    if not wanted:
        return json.dumps({"error": "Aucun titre valide a enregistrer."}, ensure_ascii=False)
    songs = []
    for vid in wanted:
        meta = state.LAST_SEARCH.get(vid) or _meta(vid)
        if meta is None:
            continue
        songs.append({"video_id": vid, "title": meta.get("title", ""),
                      "channel": meta.get("channel", "")})
        _remember(vid, meta.get("title", ""), meta.get("channel", ""))
    if not songs:
        return json.dumps({"error": "Titres inconnus du moteur (search_music d'abord)."},
                          ensure_ascii=False)
    playlists = _load_playlists()
    stamp = _now()
    entry = {"id": uuid.uuid4().hex, "name": _unique_name(name, playlists), "mood": "",
             "songs": songs, "created": stamp, "updated": stamp}
    playlists.append(entry)
    _save_playlists(playlists)
    state.LAST_SEARCH.update({s["video_id"]: s for s in songs})
    return json.dumps({"status": "created", "playlist": entry,
                       "name": entry["name"], "count": len(songs), "songs": songs},
                      ensure_ascii=False)


def create_playlist(name: str, mood: str, count: int = 10) -> str:
    """Playlist intelligente : get_recommendation(mood) par lots de 3, 1 titre/channel max.

    Si mood est un genre connu, filtrage genre strict (100% ce genre).
    Ne remplace jamais une playlist existante : le nom est suffixe si besoin.
    """
    from services.genres import _is_known_genre
    from services.recommendation import get_recommendation
    name = (name or "").strip() or "Sans titre"
    mood = (mood or "").strip()
    try:
        count = max(1, min(int(count or 10), 30))
    except (TypeError, ValueError):
        count = 10
    songs, seen_ids = [], set()
    strict = _is_known_genre(mood) is not None  # filtrage genre dur
    per_channel_cap = 2 if strict else 1  # genre strict : 2/chaîne max (1 sinon)
    chan_count = _C()
    rounds = 0
    while len(songs) < count and rounds < count:  # borne : 1 tour max par titre voulu
        rounds += 1
        try:
            data = json.loads(get_recommendation(mood, force_genre_filter=True))
        except Exception as exc:
            _tprint(f"playlist tour {rounds} echec : {exc}")
            break
        recos = data.get("recommendations", []) if isinstance(data, dict) else []
        added = False
        for r in recos:
            vid = r.get("video_id", "")
            ch = (r.get("channel") or "").lower()
            if not vid or vid in seen_ids or chan_count[ch] >= per_channel_cap:
                continue  # shuffle contextuel : cap par chaine
            seen_ids.add(vid)
            chan_count[ch] += 1
            songs.append({"video_id": vid, "title": r.get("title", ""),
                          "channel": r.get("channel", "")})
            _remember(vid, r.get("title", ""), r.get("channel", ""))
            added = True
            print(f"  … titres {len(songs)}/{count} : {r.get('title', '')[:50]}", flush=True)
            if len(songs) >= count:
                break
        if not added:
            _tprint(f"playlist tour {rounds} sans ajout, arret")
            break
    songs = songs[:count]
    playlists = _load_playlists()
    stamp = _now()
    entry = {"id": uuid.uuid4().hex, "name": _unique_name(name, playlists), "mood": mood,
             "songs": songs, "created": stamp, "updated": stamp}
    playlists.append(entry)
    _save_playlists(playlists)
    state.LAST_SEARCH.update({s["video_id"]: s for s in songs})
    out = {"status": "created", "playlist": entry,
           "name": entry["name"], "mood": mood, "count": len(songs), "songs": songs}
    if len(songs) < count:
        out["warning"] = f"Seulement {len(songs)}/{count} titres trouvés — relance pour completer."
    return json.dumps(out, ensure_ascii=False)


# ------------------------------------------------------------------- modification

def rename_playlist(playlist: str, name: str) -> str:
    """Renomme une playlist (nom rendu unique si deja pris)."""
    playlists = _load_playlists()
    found = _find(playlist)
    if found is None:
        return _not_found(playlist)
    clean = _unique_name(name, playlists, exclude_id=found["id"])
    for entry in playlists:
        if entry["id"] == found["id"]:
            entry["name"] = clean
            entry["updated"] = _now()
            _save_playlists(playlists)
            return json.dumps({"status": "renamed", "playlist": entry}, ensure_ascii=False)
    return _not_found(playlist)


def delete_playlist(playlist: str) -> str:
    """Supprime une playlist."""
    found = _find(playlist)
    if found is None:
        return _not_found(playlist)
    remaining = [p for p in _load_playlists() if p["id"] != found["id"]]
    _save_playlists(remaining)
    return json.dumps({"status": "deleted", "id": found["id"], "name": found["name"]},
                      ensure_ascii=False)


def add_track(playlist: str, video_id: str) -> str:
    """Ajoute un titre a une playlist (dedup par video_id)."""
    vid = (video_id or "").strip()
    if not VIDEO_ID_RE.match(vid):
        return json.dumps({"error": f"video_id invalide '{video_id}'."}, ensure_ascii=False)
    meta = state.LAST_SEARCH.get(vid) or _meta(vid)
    if meta is None:
        return json.dumps({"error": f"video_id '{vid}' inconnu. Utilise search_music d'abord."},
                          ensure_ascii=False)
    playlists = _load_playlists()
    found = _find(playlist)
    if found is None:
        return _not_found(playlist)
    for entry in playlists:
        if entry["id"] != found["id"]:
            continue
        if any(s.get("video_id") == vid for s in entry["songs"]):
            return json.dumps({"status": "already_present", "playlist": entry}, ensure_ascii=False)
        entry["songs"].append({"video_id": vid, "title": meta.get("title", ""),
                               "channel": meta.get("channel", "")})
        entry["updated"] = _now()
        _remember(vid, meta.get("title", ""), meta.get("channel", ""))
        _save_playlists(playlists)
        return json.dumps({"status": "added", "playlist": entry}, ensure_ascii=False)
    return _not_found(playlist)


def remove_track(playlist: str, video_id: str) -> str:
    """Retire un titre d'une playlist."""
    vid = (video_id or "").strip()
    playlists = _load_playlists()
    found = _find(playlist)
    if found is None:
        return _not_found(playlist)
    for entry in playlists:
        if entry["id"] != found["id"]:
            continue
        before = len(entry["songs"])
        entry["songs"] = [s for s in entry["songs"] if s.get("video_id") != vid]
        if len(entry["songs"]) == before:
            return json.dumps({"error": f"Titre '{vid}' absent de la playlist."},
                              ensure_ascii=False)
        entry["updated"] = _now()
        _save_playlists(playlists)
        return json.dumps({"status": "removed", "playlist": entry}, ensure_ascii=False)
    return _not_found(playlist)


# ------------------------------------------------------------------------ lecture

def load_playlist(name: str, start: int = 0) -> str:
    """Charge la playlist nommee et lance le titre a l'index `start` (file _PLAY_QUEUE)."""
    global _PLAY_QUEUE, _PLAY_POS, _PLAY_NAME
    found = _find(name)
    if found is None:
        names = [p.get("name", "") for p in _load_playlists()]
        return json.dumps({"error": f"Playlist '{name}' introuvable.", "playlists": names},
                          ensure_ascii=False)
    songs = [s for s in found.get("songs", []) if s.get("video_id")]
    if not songs:
        return json.dumps({"error": f"Playlist '{found['name']}' vide."}, ensure_ascii=False)
    try:
        index = max(0, min(int(start or 0), len(songs) - 1))
    except (TypeError, ValueError):
        index = 0
    _PLAY_QUEUE = songs
    _PLAY_POS = index
    _PLAY_NAME = found["name"]
    for s in songs[index + 1:index + 3]:
        _prefetch(s["video_id"])  # suite pre-resolue
    res = json.loads(play_music(songs[index]["video_id"]))
    if res.get("status") != "playing":
        return json.dumps({"error": f"Echec lancement : {res.get('error', '?')}"}, ensure_ascii=False)
    return json.dumps({"status": "playing_playlist", "name": _PLAY_NAME,
                       "position": index + 1, "count": len(songs), "songs": songs},
                      ensure_ascii=False)


def playlist_next() -> str:
    """Titre suivant de la file en cours (utilise par skip / fin de titre)."""
    global _PLAY_POS
    if not _PLAY_QUEUE or _PLAY_POS + 1 >= len(_PLAY_QUEUE):
        return json.dumps({"status": "playlist_end", "name": _PLAY_NAME}, ensure_ascii=False)
    _PLAY_POS += 1
    nxt = _PLAY_QUEUE[_PLAY_POS]
    if _PLAY_POS + 1 < len(_PLAY_QUEUE):
        _prefetch(_PLAY_QUEUE[_PLAY_POS + 1]["video_id"])
    res = json.loads(play_music(nxt["video_id"]))
    if res.get("status") != "playing":
        return json.dumps({"error": f"Echec titre suivant : {res.get('error', '?')}"}, ensure_ascii=False)
    return json.dumps({"status": "playing_playlist", "name": _PLAY_NAME,
                       "position": _PLAY_POS + 1, "count": len(_PLAY_QUEUE),
                       "video_id": nxt["video_id"], "title": nxt.get("title", "")}, ensure_ascii=False)
