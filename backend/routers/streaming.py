"""Streaming continu infini."""
from fastapi import APIRouter

from dependencies.responses import run_tool, to_response
from schemas.models import ApiResponse, StreamStartRequest
from services.streaming import skip_streaming, start_streaming, stop_streaming

router = APIRouter(prefix="/api/stream", tags=["streaming"])


@router.post("/start", response_model=ApiResponse)
async def stream_start(body: StreamStartRequest):
    """Lance le flux infini (thread de fond) ; force_genre restreint au genre demande."""
    code, res = await run_tool(start_streaming, mood=body.mood, force_genre=body.force_genre)
    return to_response(code, res)


@router.post("/stop", response_model=ApiResponse)
async def stream_stop():
    """Arrete le flux infini et coupe la lecture."""
    code, res = await run_tool(stop_streaming)
    return to_response(code, res)


@router.post("/skip", response_model=ApiResponse)
async def stream_skip():
    """Passe au titre suivant du flux sans le couper."""
    code, res = await run_tool(skip_streaming)
    return to_response(code, res)
