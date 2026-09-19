"""Streaming continu infini : boucle reco -> lecture -> enchainement gapless."""
import json
import threading
import time

from services import state
from services.audio import (
    _ipc_send, _resolve_audio_url, _stop_player, play_music,
)
from services.db_access import _db_ready
from services.playlists import _PLAY_QUEUE, _PLAY_POS
from services.recommendation import get_recommendation
from services.state import TIMER_MSGS, _tprint


def _stream_title_done() -> bool:
    """True si le titre en cours est fini (eof) ou quasi-fini (time-pos >= duration - 1.5s)."""
    try:
        r = _ipc_send(["get_property", "eof-reached"], timeout=2.0)
        if r and r.get("error") == "success" and r.get("data") is True:
            return True
        pos = _ipc_send(["get_property", "time-pos"], timeout=2.0)
        dur = _ipc_send(["get_property", "duration"], timeout=2.0)
        p = pos.get("data") if pos and pos.get("error") == "success" else None
        d = dur.get("data") if dur and dur.get("error") == "success" else None
        if isinstance(p, (int, float)) and isinstance(d, (int, float)) and d > 0 and p >= d - 1.5:
            return True
    except Exception:
        pass
    return False


def _prefetch_next_reco(mood: str):
    """[4] Calcule la reco suivante en fond + pre-resout son URL (N+2 pret)."""
    try:
        data = json.loads(get_recommendation(mood, force_genre_filter=state.STREAMING_FORCE_GENRE))
        recos = data.get("recommendations", []) if isinstance(data, dict) else []
        if recos:
            _resolve_audio_url(recos[0]["video_id"])
            TIMER_MSGS.put(f"  [prefetch] Titre suivant prêt : {recos[0].get('title', '')[:40]}")
    except Exception as exc:
        _tprint(f"[prefetch] echec : {exc}")


def _streaming_loop():
    """Boucle infini : reco -> joue -> pre-resout le suivant -> attend fin/skip -> replace (gapless)."""
    while state.STREAMING_MODE:
        mood = state.STREAMING_MOOD
        try:
            data = json.loads(get_recommendation(mood, force_genre_filter=state.STREAMING_FORCE_GENRE))
        except Exception as exc:
            TIMER_MSGS.put(f"  [STREAMING] reco echec ({exc}), nouvel essai…")
            time.sleep(5)
            continue
        recos = data.get("recommendations", []) if isinstance(data, dict) else []
        if not recos:
            TIMER_MSGS.put("  [STREAMING] plus de nouveautés, pause 30s…")
            time.sleep(30)
            continue
        nxt = recos[0]
        try:
            state._prefetch_exec.submit(_resolve_audio_url, nxt["video_id"])  # masque la resolution
        except Exception:
            pass
        res = json.loads(play_music(nxt["video_id"]))
        if res.get("status") != "playing":
            TIMER_MSGS.put(f"  [STREAMING] echec lecture ({res.get('error', '?')}), suivant…")
            continue
        state.STREAMING_COUNT += 1
        # Pre-calcule la reco suivante pendant la lecture en cours (masque la latence).
        try:
            state._prefetch_exec.submit(_prefetch_next_reco, mood)
        except Exception:
            pass
        t_title0 = time.perf_counter()
        TIMER_MSGS.put(f"  [STREAMING] Titre {state.STREAMING_COUNT}/∞ — {nxt.get('title', '')} — {nxt.get('channel', '')}")
        while state.STREAMING_MODE and not state.STREAMING_SKIP.is_set():
            if _stream_title_done():
                break
            if time.perf_counter() - t_title0 > state.STREAMING_MAX_TITLE_SECS:
                _tprint("streaming : duree max atteinte, suivant")
                break
            time.sleep(1.0)
        state.STREAMING_SKIP.clear()
    TIMER_MSGS.put("  [STREAMING] arrêté.")


def start_streaming(mood: str = "", force_genre: bool = True) -> str:
    """Lance le flux infini (thread de fond). Mood en RAM seule.
    force_genre=True (defaut) : si mood est un genre connu, le flux ne joue QUE ce genre."""
    mood = (mood or "").strip()
    if state.STREAMING_MODE and state.STREAMING_THREAD is not None and state.STREAMING_THREAD.is_alive():
        return json.dumps({"status": "already_streaming", "mood": state.STREAMING_MOOD,
                           "count": state.STREAMING_COUNT}, ensure_ascii=False)
    state.STREAMING_MODE = True
    state.STREAMING_MOOD = mood
    state.STREAMING_FORCE_GENRE = bool(force_genre)
    state.STREAMING_COUNT = 0
    state.STREAMING_SKIP.clear()
    state.STREAMING_THREAD = threading.Thread(target=_streaming_loop, daemon=True,
                                              name="streaming")
    state.STREAMING_THREAD.start()
    return json.dumps({"status": "streaming_started", "mood": mood,
                       "force_genre": state.STREAMING_FORCE_GENRE}, ensure_ascii=False)


def stop_streaming() -> str:
    """Stoppe le flux infini + coupe mpv."""
    was = state.STREAMING_MODE
    state.STREAMING_MODE = False
    state.STREAMING_SKIP.set()  # reveille la boucle d'attente
    _stop_player()
    return json.dumps({"status": "streaming_stopped" if was else "not_streaming",
                       "played": state.STREAMING_COUNT}, ensure_ascii=False)


def skip_streaming() -> str:
    """Passe immediatement au titre suivant (sans couper le flux) et loggue le skip."""
    if _db_ready():
        from core import db as _db
        try:
            cur = _PLAY_QUEUE[_PLAY_POS]["video_id"] if _PLAY_QUEUE else None
            if cur:
                _db.db_log_skip(cur)
        except (IndexError, KeyError, TypeError):
            pass
    if not state.STREAMING_MODE:
        return json.dumps({"error": "Pas de flux en cours. Lance start_streaming d'abord."},
                          ensure_ascii=False)
    state.STREAMING_SKIP.set()
    return json.dumps({"status": "skipped", "count": state.STREAMING_COUNT}, ensure_ascii=False)
