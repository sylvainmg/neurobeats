"""Recherche YouTube."""
from fastapi import APIRouter

from dependencies.responses import TIMEOUT_SHORT, run_tool, to_response
from schemas.models import ApiResponse
from services.suggestions import get_search_suggestions, refresh_search_suggestions
from services.youtube import search_music

router = APIRouter(prefix="/api", tags=["search"])


@router.get("/search", response_model=ApiResponse)
async def search(q: str, limit: int = 5):
    """Recherche YouTube et retourne les resultats enrichis de leur genre."""
    code, body = await run_tool(search_music, query=q, limit=limit)
    return to_response(code, body)


@router.get("/search/suggestions", response_model=ApiResponse)
async def search_suggestions():
    """Points de depart de recherche libelles par l'IA (peut etre vide)."""
    code, body = await run_tool(get_search_suggestions, timeout=TIMEOUT_SHORT)
    return to_response(code, body)


@router.post("/search/suggestions/refresh", response_model=ApiResponse)
async def search_suggestions_refresh():
    """Force une nouvelle proposition de points de depart."""
    code, body = await run_tool(refresh_search_suggestions, timeout=TIMEOUT_SHORT)
    return to_response(code, body)
