"""Recommandation."""
from fastapi import APIRouter

from dependencies.responses import TIMEOUT_LONG, run_tool, to_response
from schemas.models import ApiResponse
from services.recommendation import get_recommendation

router = APIRouter(prefix="/api", tags=["recommendation"])


@router.get("/recommend", response_model=ApiResponse)
async def recommend(mood: str = "", force_genre: bool = False):
    """Retourne des recommandations a partir d'un contexte (mood) et de l'historique."""
    code, body = await run_tool(get_recommendation, timeout=TIMEOUT_LONG,
                                query=mood, force_genre_filter=force_genre)
    return to_response(code, body)
