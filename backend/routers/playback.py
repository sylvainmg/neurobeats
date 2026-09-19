"""Lecture audio : play, play_now, play_choice, stop."""
from fastapi import APIRouter

from dependencies.responses import TIMEOUT_LONG, run_tool, to_response
from schemas.models import ApiResponse, PlayChoiceRequest, PlayNowRequest, PlayRequest
from services.audio import play_choice, play_music, stop_music
from services.youtube import play_now

router = APIRouter(prefix="/api", tags=["playback"])


@router.post("/play", response_model=ApiResponse)
async def play(body: PlayRequest):
    """Joue la video correspondant au video_id fourni."""
    code, res = await run_tool(play_music, video_id=body.video_id)
    return to_response(code, res)


@router.post("/play_now", response_model=ApiResponse)
async def play_now_endpoint(body: PlayNowRequest):
    """Cherche la requete et joue directement le meilleur resultat."""
    code, res = await run_tool(play_now, timeout=TIMEOUT_LONG, query=body.query)
    return to_response(code, res)


@router.post("/play_choice", response_model=ApiResponse)
async def play_choice_endpoint(body: PlayChoiceRequest):
    """Joue le n-ieme resultat de la derniere recherche (index 1-based)."""
    code, res = await run_tool(play_choice, index=body.index)
    return to_response(code, res)


@router.post("/stop", response_model=ApiResponse)
async def stop():
    """Arrete la lecture en cours."""
    code, res = await run_tool(stop_music)
    return to_response(code, res)
