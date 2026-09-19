"""Endpoints de sante."""
import os
import shutil

from fastapi import APIRouter

from core import db as engine_db
from schemas.models import ApiResponse
from services import state

router = APIRouter(prefix="/api", tags=["health"])


@router.get("/health", response_model=ApiResponse)
async def health():
    """Etat du service : base, mpv, daemon, streaming et qualite reseau."""
    return {"status": "ok", "data": {
        "db": os.path.exists(engine_db.DB_PATH),
        "db_path": engine_db.DB_PATH,
        "mpv": bool(shutil.which("mpv")),
        "mpv_daemon": state._mpv_daemon is not None and state._mpv_daemon.poll() is None,
        "streaming": state.STREAMING_MODE,
        "net_quality": state.NET_QUALITY,
    }}
