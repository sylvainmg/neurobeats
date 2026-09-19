"""Chat stateless : historique fourni par le client, tronque cote serveur."""
from fastapi import APIRouter

from dependencies.responses import TIMEOUT_LONG, run_tool, to_response
from schemas.models import ApiResponse, ChatRequest
from services.chat import chat

router = APIRouter(prefix="/api", tags=["chat"])


@router.post("/chat", response_model=ApiResponse)
async def chat_endpoint(body: ChatRequest):
    """Boucle conversationnelle stateless : historique client tronque + tools."""
    messages = [m.model_dump() for m in body.messages]
    code, res = await run_tool(chat, timeout=TIMEOUT_LONG,
                               messages=messages, max_messages=body.max_messages)
    return to_response(code, res)
