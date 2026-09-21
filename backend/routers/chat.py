"""Chat : historique fourni par le client, tronque cote serveur.

- POST /api/chat : reponse complete (bloquant), conserve pour compatibilite.
- POST /api/chat/stream : Server-Sent Events (token / tool_start / tool_end / done / error).
"""
import json

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from dependencies.responses import TIMEOUT_LONG, run_tool, to_response
from schemas.models import ApiResponse, ChatRequest
from services.chat import chat, chat_stream

router = APIRouter(prefix="/api", tags=["chat"])

_SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",  # pas de tampon intermediaire (nginx) sur le flux
}


@router.post("/chat", response_model=ApiResponse)
async def chat_endpoint(body: ChatRequest):
    """Boucle conversationnelle stateless : historique client tronque + tools."""
    messages = [m.model_dump() for m in body.messages]
    code, res = await run_tool(chat, timeout=TIMEOUT_LONG,
                               messages=messages, max_messages=body.max_messages,
                               scope=body.scope)
    return to_response(code, res)


@router.post("/chat/stream")
async def chat_stream_endpoint(body: ChatRequest):
    """Meme boucle, en flux : chaque evenement est un `data: {json}`."""
    messages = [m.model_dump() for m in body.messages]
    max_messages = body.max_messages
    scope = body.scope

    def event_gen():
        # Generateur SYNC : Starlette l'itere dans un threadpool, ce qui convient
        # au client ollama bloquant. Chaque `yield` est envoye immediatement.
        try:
            for event in chat_stream(messages, max_messages, scope):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except Exception as exc:
            # Une erreur en plein flux ne doit pas produire un 500 (entetes deja envoyes).
            payload = {"type": "error", "error": f"{type(exc).__name__}: {exc}"}
            yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_gen(), media_type="text/event-stream", headers=_SSE_HEADERS)
