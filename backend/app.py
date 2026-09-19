"""NeuroBeats - facade du moteur (compatibilite CLI).

Le moteur est desormais decoupe en services (clean code FastAPI). Ce module
reexporte les symboles historiquement utilises par le CLI de reference
(tests/cli_reference.py) et par l'API. Preferez les imports directs depuis
services.* pour du nouveau code.
"""
from core import config
from core.config import BASE, MODEL, TIMING

from services import state
from services.state import (
    KNOWN, LAST_SEARCH, STREAM_CACHE, TIMER_MSGS,
    STREAMING_MODE, STREAMING_MOOD, STREAMING_FORCE_GENRE, STREAMING_COUNT,
    STREAMING_THREAD, STREAMING_SKIP, STREAMING_MAX_TITLE_SECS,
    _tprint, _drain_timer_msgs, _now_ms,
)
from services.db_access import (
    _db_ready, _migrate_json_to_db, hist_read, hist_append,
    profile_read, profile_write, get_user_stats, _meta,
)
from services.youtube import youtube_search, search_music, play_now
from services.audio import (
    play_music, play_choice, stop_music,
    _load_stream_cache, _save_stream_cache, _resolve_audio_url,
    _prefetch, _take_prefetch, _ipc_send, _ensure_daemon, _shutdown_daemon,
    _ipc_event_loop, _stop_player,
)
from services.genres import (
    CHANNEL_GENRE_MAP, GENERIC_CHANNELS, GENRE_LABELS, GENRE_SEARCH_TERMS,
    _genre_of, _is_known_genre, infer_genre_ollama, infer_genres_batch,
)
from services.recommendation import (
    get_recommendation, store_preference, _cold_start_warmup,
)
from services.playlists import create_playlist, load_playlist, playlist_next
from services.streaming import (
    start_streaming, stop_streaming, skip_streaming,
)
from services.network import net_probe, _apply_net_quality
from services import chat as _chat  # noqa: F401  (chat expose via routers)

# --- Qualite reseau (reexports pour l'API/CLI) ---
NET_QUALITY = state.NET_QUALITY

# Alias retro-compatibles
_drain_timer_msgs = _drain_timer_msgs
