"""Playlists : lecture, creation, titre suivant."""
from fastapi import APIRouter

from dependencies.responses import TIMEOUT_LONG, run_tool, to_response
from schemas.models import ApiResponse, PlaylistCreateRequest
from services.playlists import create_playlist, load_playlist, playlist_next

router = APIRouter(prefix="/api/playlist", tags=["playlists"])


@router.get("", response_model=ApiResponse)
async def playlist(name: str):
    """Charge la playlist nommee et lance son premier titre."""
    code, res = await run_tool(load_playlist, name=name)
    return to_response(code, res)


@router.post("/create", response_model=ApiResponse)
async def playlist_create(body: PlaylistCreateRequest):
    """Cree une playlist intelligente (name, mood, count) et la sauvegarde."""
    code, res = await run_tool(create_playlist, timeout=TIMEOUT_LONG,
                               name=body.name, mood=body.mood, count=body.count)
    return to_response(code, res)


@router.post("/next", response_model=ApiResponse)
async def playlist_next_endpoint():
    """Passe au titre suivant de la playlist en cours."""
    code, res = await run_tool(playlist_next)
    return to_response(code, res)
