"""Recherche YouTube."""
from fastapi import APIRouter

from dependencies.responses import run_tool, to_response
from schemas.models import ApiResponse
from services.youtube import search_music

router = APIRouter(prefix="/api", tags=["search"])


@router.get("/search", response_model=ApiResponse)
async def search(q: str, limit: int = 5):
    """Recherche YouTube et retourne les resultats enrichis de leur genre."""
    code, body = await run_tool(search_music, query=q, limit=limit)
    return to_response(code, body)
