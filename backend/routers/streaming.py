"""Streaming continu infini."""
from fastapi import APIRouter

from dependencies.responses import run_tool, to_response
from schemas.models import (
    ApiResponse, JumpRequest, QueueRemoveRequest, RepeatRequest, ShuffleRequest,
    StreamStartRequest,
)
from services.queue import queue_snapshot
from services.streaming import (
    jump_to_queue, play_previous, remove_queued, set_repeat, set_shuffle,
    skip_streaming, start_streaming, stop_streaming,
)

router = APIRouter(prefix="/api/stream", tags=["streaming"])


@router.get("/queue", response_model=ApiResponse)
async def stream_queue():
    """File de lecture pre-calculee (titres a venir, position, mood)."""
    return {"status": "ok", "data": queue_snapshot()}


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


@router.post("/jump", response_model=ApiResponse)
async def stream_jump(body: JumpRequest):
    """Joue le n-ieme titre de la file (1-based) et reprend l'enchainement."""
    code, res = await run_tool(jump_to_queue, index=body.index)
    return to_response(code, res)


@router.post("/previous", response_model=ApiResponse)
async def stream_previous():
    """Rejoue le titre precedent de la session (ou revient au debut du courant)."""
    code, res = await run_tool(play_previous)
    return to_response(code, res)


@router.post("/queue/remove", response_model=ApiResponse)
async def stream_queue_remove(body: QueueRemoveRequest):
    """Retire un titre a venir de la file ; la lecture en cours n'est pas touchee."""
    code, res = await run_tool(remove_queued, index=body.index)
    return to_response(code, res)


@router.post("/shuffle", response_model=ApiResponse)
async def stream_shuffle(body: ShuffleRequest):
    """Active/desactive l'ordre aleatoire de la file."""
    code, res = await run_tool(set_shuffle, enabled=body.shuffle)
    return to_response(code, res)


@router.post("/repeat", response_model=ApiResponse)
async def stream_repeat(body: RepeatRequest):
    """Regle le mode de repetition : off | all | one."""
    code, res = await run_tool(set_repeat, mode=body.mode)
    return to_response(code, res)
