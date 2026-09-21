"""Endpoints de sante."""
import os
import shutil

from fastapi import APIRouter

from core import db as engine_db
from routers import realtime
from schemas.models import ApiResponse
from services import audiocache, covers, state
from services.queue import fill_in_progress, queue_remaining, watchdog_alive

router = APIRouter(prefix="/api", tags=["health"])


@router.get("/health", response_model=ApiResponse)
async def health():
    """Etat du service : base, mpv, daemon, streaming, file et qualite reseau."""
    return {"status": "ok", "data": {
        "db": os.path.exists(engine_db.DB_PATH),
        "db_path": engine_db.DB_PATH,
        "mpv": bool(shutil.which("mpv")),
        "mpv_daemon": state._mpv_daemon is not None and state._mpv_daemon.poll() is None,
        "streaming": state.STREAMING_MODE,
        "streaming_mood": state.STREAMING_MOOD,
        "streaming_count": state.STREAMING_COUNT,
        "queue_remaining": queue_remaining(),
        "queue_watchdog": watchdog_alive(),
        "queue_filling": fill_in_progress(),
        "ws_clients": realtime.clients_count(),
        "net_quality": state.NET_QUALITY,
        "audio_cache": audiocache.stats(),
        "cover_cache": covers.stats(),
    }}
