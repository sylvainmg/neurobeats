"""Playlists intelligentes : creation (lots de 3) et lecture (file en RAM)."""
import json
from collections import Counter as _C
from datetime import datetime

from services import state
from services.audio import _prefetch, play_music
from services.db_access import profile_read, profile_write
from services.state import _remember, _tprint

# File de lecture en cours (RAM) : [{video_id, title, channel}]
_PLAY_QUEUE: list = []
_PLAY_POS: int = 0
_PLAY_NAME: str = ""


def _load_playlists() -> list:
    return profile_read({"playlists": []}).get("playlists", [])


def create_playlist(name: str, mood: str, count: int = 10) -> str:
    """Playlist intelligente : get_recommendation(mood) par lots de 3, 1 titre/channel max.
    Si mood est un genre connu (ex. 'rap fr'), filtrage genre strict (100% ce genre).
    Sauvegarde {name, mood, songs, created} dans user_profile.json['playlists'] (liste)."""
    from services.genres import _is_known_genre
    from services.recommendation import get_recommendation
    name = (name or "").strip() or "Sans titre"
    mood = (mood or "").strip()
    try:
        count = max(1, min(int(count or 10), 30))
    except (TypeError, ValueError):
        count = 10
    songs, seen_ids, seen_channels = [], set(), set()
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
    profile = profile_read()
    playlists = profile.get("playlists", [])
    playlists = [p for p in playlists if p.get("name", "").lower() != name.lower()]  # ecrase doublon
    playlists.append({"name": name, "mood": mood, "songs": songs,
                      "created": datetime.now().isoformat()})
    profile["playlists"] = playlists
    profile_write(profile)
    state.LAST_SEARCH.update({s["video_id"]: s for s in songs})
    out = {"status": "created", "name": name, "mood": mood,
           "count": len(songs), "songs": songs}
    if len(songs) < count:
        out["warning"] = f"Seulement {len(songs)}/{count} titres trouvés — relance pour completer."
    return json.dumps(out, ensure_ascii=False)


def load_playlist(name: str) -> str:
    """Charge la playlist nommee et lance le 1er titre (file _PLAY_QUEUE)."""
    global _PLAY_QUEUE, _PLAY_POS, _PLAY_NAME
    want = (name or "").strip().lower()
    found = next((p for p in _load_playlists() if p.get("name", "").lower() == want), None)
    if found is None:
        names = [p.get("name", "") for p in _load_playlists()]
        return json.dumps({"error": f"Playlist '{name}' introuvable.", "playlists": names},
                          ensure_ascii=False)
    songs = [s for s in found.get("songs", []) if s.get("video_id")]
    if not songs:
        return json.dumps({"error": f"Playlist '{name}' vide."}, ensure_ascii=False)
    _PLAY_QUEUE = songs
    _PLAY_POS = 0
    _PLAY_NAME = found.get("name", name)
    for s in songs[1:3]:
        _prefetch(s["video_id"])  # suite pre-resolue
    res = json.loads(play_music(songs[0]["video_id"]))
    if res.get("status") != "playing":
        return json.dumps({"error": f"Echec lancement : {res.get('error', '?')}"}, ensure_ascii=False)
    return json.dumps({"status": "playing_playlist", "name": _PLAY_NAME,
                       "position": 1, "count": len(songs), "songs": songs}, ensure_ascii=False)


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
