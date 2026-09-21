"""Recommandation."""
import json

from fastapi import APIRouter

from dependencies.responses import TIMEOUT_LONG, run_tool, to_response
from schemas.models import ApiResponse
from services.home import get_home
from services.recommendation import get_recommendation

router = APIRouter(prefix="/api", tags=["recommendation"])


@router.get("/home", response_model=ApiResponse)
async def home():
    """Contenu d'accueil (recos + habillage LLM), servi depuis un cache RAM.

    Repond immediatement : la reco et le LLM tournent en arriere-plan. Le client
    repasse tant que `ready` est faux.
    """
    return {"status": "ok", "data": json.loads(get_home())}


@router.get("/recommend", response_model=ApiResponse)
async def recommend(mood: str = "", force_genre: bool = False):
    """Retourne des recommandations a partir d'un contexte (mood) et de l'historique."""
    code, body = await run_tool(get_recommendation, timeout=TIMEOUT_LONG,
                                query=mood, force_genre_filter=force_genre)
    return to_response(code, body)
