"""Profil : identite, statistiques et gestion des donnees recoltees."""
from fastapi import APIRouter
from typing import Optional

from dependencies.responses import TIMEOUT_LONG, TIMEOUT_SHORT, run_tool, to_response
from schemas.models import (
    AiSettingsRequest, ApiResponse, AvatarRequest, IdentityUpdateRequest,
)
from services import llm
from services.profile import (
    add_favorite, clear_avatar, clear_caches, clear_history, data_overview,
    delete_history_entry, delete_preference, get_profile, list_favorites,
    list_history, list_preferences, remove_favorite, set_avatar, update_identity,
)

router = APIRouter(prefix="/api/profile", tags=["profile"])


# -------------------------------------------------------------------- identite

@router.get("", response_model=ApiResponse)
async def profile_get():
    """Identite + statistiques + compteurs des donnees recoltees."""
    code, res = await run_tool(get_profile, timeout=TIMEOUT_SHORT)
    return to_response(code, res)


@router.patch("", response_model=ApiResponse)
async def profile_update(body: IdentityUpdateRequest):
    """Met a jour prenom et/ou nom (champ absent = inchange)."""
    code, res = await run_tool(update_identity, timeout=TIMEOUT_SHORT,
                               first_name=body.first_name, last_name=body.last_name)
    return to_response(code, res)


@router.put("/avatar", response_model=ApiResponse)
async def profile_avatar(body: AvatarRequest):
    """Enregistre la photo de profil (data URL, ~220 Ko max)."""
    code, res = await run_tool(set_avatar, timeout=TIMEOUT_SHORT, avatar=body.avatar)
    return to_response(code, res)


@router.delete("/avatar", response_model=ApiResponse)
async def profile_avatar_clear():
    """Retire la photo de profil."""
    code, res = await run_tool(clear_avatar, timeout=TIMEOUT_SHORT)
    return to_response(code, res)


# ------------------------------------------------------------- donnees recoltees

@router.get("/data", response_model=ApiResponse)
async def profile_data():
    """Compteurs par categorie (historique, notes, favoris, playlists, caches)."""
    code, res = await run_tool(data_overview, timeout=TIMEOUT_SHORT)
    return to_response(code, res)


@router.get("/history", response_model=ApiResponse)
async def profile_history(limit: int = 100, offset: int = 0):
    """Dernieres ecoutes (avec leur id, pour la suppression unitaire), paginees."""
    code, res = await run_tool(
        list_history, timeout=TIMEOUT_SHORT, limit=limit, offset=offset
    )
    return to_response(code, res)


@router.delete("/history/{entry_id}", response_model=ApiResponse)
async def profile_history_delete(entry_id: int):
    """Supprime une ecoute (les stats agregees sont recalculees)."""
    code, res = await run_tool(delete_history_entry, timeout=TIMEOUT_SHORT, entry_id=entry_id)
    return to_response(code, res)


@router.delete("/history", response_model=ApiResponse)
async def profile_history_clear(confirm: bool = False):
    """Efface tout l'historique. Exige `?confirm=1`."""
    code, res = await run_tool(clear_history, timeout=TIMEOUT_SHORT, confirm=confirm)
    return to_response(code, res)


@router.get("/preferences", response_model=ApiResponse)
async def profile_preferences():
    """Titres notes (★)."""
    code, res = await run_tool(list_preferences, timeout=TIMEOUT_SHORT)
    return to_response(code, res)


@router.delete("/preferences/{video_id}", response_model=ApiResponse)
async def profile_preference_delete(video_id: str):
    """Retire la note d'un titre."""
    code, res = await run_tool(delete_preference, timeout=TIMEOUT_SHORT, video_id=video_id)
    return to_response(code, res)


@router.get("/favorites", response_model=ApiResponse)
async def profile_favorites():
    """Artistes favoris."""
    code, res = await run_tool(list_favorites, timeout=TIMEOUT_SHORT)
    return to_response(code, res)


@router.post("/favorites/{channel}", response_model=ApiResponse)
async def profile_favorite_add(channel: str):
    """Ajoute un artiste aux favoris."""
    code, res = await run_tool(add_favorite, timeout=TIMEOUT_SHORT, channel=channel)
    return to_response(code, res)


@router.delete("/favorites/{channel}", response_model=ApiResponse)
async def profile_favorite_remove(channel: str):
    """Retire un artiste des favoris."""
    code, res = await run_tool(remove_favorite, timeout=TIMEOUT_SHORT, channel=channel)
    return to_response(code, res)


@router.post("/caches/clear", response_model=ApiResponse)
async def profile_caches_clear():
    """Vide les caches derives (genres inferes, embeddings, URLs audio)."""
    code, res = await run_tool(clear_caches, timeout=TIMEOUT_SHORT)
    return to_response(code, res)


# ------------------------------------------------------------------- modele IA

@router.get("/ai", response_model=ApiResponse)
async def profile_ai_get():
    """Reglages du modele IA : fournisseur, URL, modele (cle masquee) + `configured`."""
    code, res = await run_tool(llm.get_ai_config, timeout=TIMEOUT_SHORT)
    return to_response(code, res)


@router.put("/ai", response_model=ApiResponse)
async def profile_ai_update(body: AiSettingsRequest):
    """Enregistre les reglages IA.

    `api_key` absent = conservee ; `""` = effacee. Renvoie la config masquee.
    """
    code, res = await run_tool(
        llm.save_ai_config, timeout=TIMEOUT_SHORT,
        provider=body.provider, ollama=body.ollama, lmstudio=body.lmstudio,
        openai=body.openai, anthropic=body.anthropic,
    )
    return to_response(code, res)


@router.post("/ai/test", response_model=ApiResponse)
async def profile_ai_test(body: Optional[AiSettingsRequest] = None):
    """Verifie que le fournisseur repond (prompt court, latence mesuree).

    Sans corps : teste la config enregistree. Avec corps : epouse les valeurs
    volantes du formulaire (URL, modele, cle) sans rien persister — le bouton
    « Tester » du profil ne teste donc plus la config déjà sauvée.
    """
    kwargs = {}
    if body is not None:
        if body.provider is not None:
            kwargs["provider"] = body.provider
        for name in ("ollama", "lmstudio", "openai", "anthropic"):
            block = getattr(body, name)
            if block:
                kwargs[name] = block
    code, res = await run_tool(llm.test_connection, timeout=TIMEOUT_LONG, **kwargs)
    return to_response(code, res)
