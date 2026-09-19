"""Stats utilisateur et preferences."""
from fastapi import APIRouter

from dependencies.responses import run_tool, to_response
from schemas.models import ApiResponse, PreferenceRequest
from services.db_access import get_user_stats
from services.recommendation import store_preference

router = APIRouter(prefix="/api", tags=["stats"])


@router.get("/stats", response_model=ApiResponse)
async def stats():
    """Statistiques d'ecoute de l'utilisateur."""
    code, body = await run_tool(get_user_stats)
    return to_response(code, body)


@router.post("/preference", response_model=ApiResponse)
async def preference(body: PreferenceRequest):
    """Stocke la note (1-5) d'une video dans le profil."""
    code, res = await run_tool(store_preference, video_id=body.video_id, rating=body.rating)
    return to_response(code, res)
