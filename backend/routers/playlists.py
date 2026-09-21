"""Playlists : CRUD complet (/api/playlists) + endpoints historiques (/api/playlist)."""
from fastapi import APIRouter

from dependencies.responses import TIMEOUT_LONG, TIMEOUT_SHORT, run_tool, to_response
from schemas.models import (
    ApiResponse, PlaylistCreateRequest, PlaylistPatchRequest, PlaylistPlayRequest,
    PlaylistTrackRequest,
)
from services.playlists import (
    add_track, create_empty_playlist, create_playlist, create_playlist_from,
    delete_playlist, get_playlist, list_playlists, load_playlist, playlist_next,
    remove_track, rename_playlist,
)

router = APIRouter(prefix="/api", tags=["playlists"])


# ------------------------------------------------------------------ CRUD complet

@router.get("/playlists", response_model=ApiResponse)
async def playlists_list(video_id: str = ""):
    """Resumes des playlists. `?video_id=` ajoute `contains` (deja presente ?)."""
    code, res = await run_tool(list_playlists, video_id=video_id)
    return to_response(code, res)


@router.get("/playlists/{playlist_id}", response_model=ApiResponse)
async def playlists_detail(playlist_id: str):
    """Detail d'une playlist, titres inclus (id ou nom)."""
    code, res = await run_tool(get_playlist, playlist=playlist_id)
    return to_response(code, res)


@router.post("/playlists", response_model=ApiResponse)
async def playlists_create(body: PlaylistCreateRequest):
    """Cree une playlist : titres explicites, generation IA (mood), ou playlist vide."""
    if body.video_ids:
        code, res = await run_tool(create_playlist_from, timeout=TIMEOUT_LONG,
                                   name=body.name, video_ids=body.video_ids)
    elif (body.mood or "").strip():
        code, res = await run_tool(create_playlist, timeout=TIMEOUT_LONG,
                                   name=body.name, mood=body.mood, count=body.count)
    else:
        code, res = await run_tool(create_empty_playlist, name=body.name)
    return to_response(code, res)


@router.patch("/playlists/{playlist_id}", response_model=ApiResponse)
async def playlists_rename(playlist_id: str, body: PlaylistPatchRequest):
    """Renomme une playlist."""
    code, res = await run_tool(rename_playlist, playlist=playlist_id, name=body.name)
    return to_response(code, res)


@router.delete("/playlists/{playlist_id}", response_model=ApiResponse)
async def playlists_delete(playlist_id: str):
    """Supprime une playlist."""
    code, res = await run_tool(delete_playlist, playlist=playlist_id)
    return to_response(code, res)


@router.post("/playlists/{playlist_id}/tracks", response_model=ApiResponse)
async def playlists_add_track(playlist_id: str, body: PlaylistTrackRequest):
    """Ajoute un titre a une playlist."""
    code, res = await run_tool(add_track, playlist=playlist_id, video_id=body.video_id)
    return to_response(code, res)


@router.delete("/playlists/{playlist_id}/tracks/{video_id}", response_model=ApiResponse)
async def playlists_remove_track(playlist_id: str, video_id: str):
    """Retire un titre d'une playlist."""
    code, res = await run_tool(remove_track, playlist=playlist_id, video_id=video_id)
    return to_response(code, res)


@router.post("/playlists/{playlist_id}/play", response_model=ApiResponse)
async def playlists_play(playlist_id: str, body: PlaylistPlayRequest):
    """Joue la playlist a partir de `start`."""
    code, res = await run_tool(load_playlist, timeout=TIMEOUT_LONG,
                               name=playlist_id, start=body.start)
    return to_response(code, res)


# ------------------------------------------------- endpoints historiques (compat)

@router.get("/playlist", response_model=ApiResponse)
async def playlist(name: str, start: int = 0):
    """Charge la playlist nommee et lance son titre (compat CLI)."""
    code, res = await run_tool(load_playlist, timeout=TIMEOUT_LONG, name=name, start=start)
    return to_response(code, res)


@router.post("/playlist/create", response_model=ApiResponse)
async def playlist_create(body: PlaylistCreateRequest):
    """Cree une playlist intelligente (name, mood, count)."""
    code, res = await run_tool(create_playlist, timeout=TIMEOUT_LONG,
                               name=body.name, mood=body.mood, count=body.count)
    return to_response(code, res)


@router.post("/playlist/next", response_model=ApiResponse)
async def playlist_next_endpoint():
    """Passe au titre suivant de la playlist en cours."""
    code, res = await run_tool(playlist_next, timeout=TIMEOUT_SHORT)
    return to_response(code, res)
