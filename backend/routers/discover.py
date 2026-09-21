"""Decouvrir : sections de recommandation (mix, genres, redecouvre, artistes).

Toutes les routes repondent immediatement : la construction se fait en fond.
"""
from fastapi import APIRouter

from dependencies.responses import TIMEOUT_SHORT, run_tool, to_response
from schemas.models import ApiResponse
from services.discover import get_discover, get_genre_section, refresh_discover

router = APIRouter(prefix="/api", tags=["discover"])


@router.get("/discover", response_model=ApiResponse)
async def discover():
    """Sections de decouverte. `ready`/`building` indiquent ou en est la construction."""
    code, res = await run_tool(get_discover, timeout=TIMEOUT_SHORT)
    return to_response(code, res)


@router.get("/discover/genre/{genre}", response_model=ApiResponse)
async def discover_genre(genre: str, force: bool = False):
    """Tuile d'un genre : construite a la demande (repond tout de suite, `building`).

    `?force=1` ignore le cache (bouton « Reessayer » apres un vivier vide).
    """
    code, res = await run_tool(get_genre_section, timeout=TIMEOUT_SHORT,
                               genre=genre, force=force)
    return to_response(code, res)


@router.post("/discover/refresh", response_model=ApiResponse)
async def discover_refresh():
    """Purge le cache de decouverte et relance la construction en fond."""
    code, res = await run_tool(refresh_discover, timeout=TIMEOUT_SHORT)
    return to_response(code, res)
