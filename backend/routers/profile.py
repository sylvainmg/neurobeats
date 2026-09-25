"""Profil : identite, statistiques et gestion des donnees recoltees."""
import asyncio
import json
import time

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from typing import Optional

from dependencies.responses import (
    TIMEOUT_LONG, TIMEOUT_SHORT, error_status, run_tool, to_response,
)
from schemas.models import (
    AiSettingsRequest, ApiResponse, AvatarRequest, EmbeddedStartRequest,
    IdentityUpdateRequest, ModelDownloadRequest,
)
from services import hub, llm, models as model_service
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

async def _ai_payload() -> Optional[dict]:
    """Payload IA complet : sélection, configs, modèles locaux et état moteur.

    Partagé par le GET et le PUT : le client reçoit toujours la même forme, et
    le PUT n'a donc pas besoin d'un second appel pour retrouver la liste des
    modèles disponibles et l'avancement du chargement.
    """
    code, res = await run_tool(llm.get_ai_config, timeout=TIMEOUT_SHORT)
    if code != 200:
        return None
    data = res.get("data") if isinstance(res, dict) else None
    if not isinstance(data, dict):
        return None
    try:
        downloaded = json.loads(await asyncio.to_thread(model_service.list_downloaded))
    except Exception:
        downloaded = {}
    try:
        engine = await asyncio.to_thread(model_service.embedded_status)
    except Exception:
        engine = {"state": "idle"}
    manifest = downloaded.get("models") or {}
    data["models"] = [
        {"model_id": str(model_id),
         "name": str((entry or {}).get("name") or model_id),
         "size_bytes": int((entry or {}).get("size_bytes") or 0)}
        for model_id, entry in manifest.items()
    ]
    data["engine"] = engine
    return data


@router.get("/ai", response_model=ApiResponse)
async def profile_ai_get():
    """Réglages IA : sélection unique + configs + modèles locaux + état moteur.

    Le choix est un enregistrement unique (``selection``) ; ``provider`` n'en est
    qu'un dérivé. Les modèles locaux téléchargés sont exposés ici pour que le
    formulaire les présente comme des choix à part entière, au même niveau que
    les fournisseurs externes.
    """
    data = await _ai_payload()
    if data is None:
        return to_response(500, {"status": "error",
                                 "error": "Configuration IA illisible.", "data": None})
    return to_response(200, {"status": "ok", "data": data})


@router.put("/ai", response_model=ApiResponse)
async def profile_ai_update(body: AiSettingsRequest):
    """Enregistre les réglages IA — et, avec eux, la sélection.

    ``selection`` est la source de vérité du choix : l'enregistrer propage le
    choix partout (tout le reste est désélectionné). ``api_key`` absent =
    conservée ; ``""`` = effacée. ``provider`` reste accepté pour compatibilité
    et équivaut à ``selection.kind``.
    """
    response = await _run_model_command(
        llm.save_ai_config, provider=body.provider, selection=body.selection,
        ollama=body.ollama, lmstudio=body.lmstudio,
        openai=body.openai, anthropic=body.anthropic, embedded=body.embedded,
    )
    if getattr(response, "status_code", 500) != 200:
        return response
    data = await _ai_payload()
    if data is None:
        return response
    return to_response(200, {"status": "ok", "data": data})


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
        for name in ("ollama", "lmstudio", "openai", "anthropic", "embedded"):
            block = getattr(body, name)
            if block:
                kwargs[name] = block
    code, res = await run_tool(llm.test_connection, timeout=TIMEOUT_LONG, **kwargs)
    return to_response(code, res)


# ------------------------------------------- modele local (telechargement + inférence)


async def _run_model_command(tool, **kwargs):
    """Execute un tool modèle en conservant les codes 404/409 du gestionnaire."""
    try:
        raw = await asyncio.to_thread(tool, **kwargs)
    except model_service.DownloadJobNotFound as exc:
        return to_response(404, {"status": "error", "error": str(exc), "data": None})
    except model_service.DownloadConflict as exc:
        return to_response(409, {"status": "error", "error": str(exc), "data": None})
    except ValueError as exc:
        message = str(exc)
        return to_response(error_status(message), {
            "status": "error", "error": message, "data": None,
        })
    except Exception as exc:
        return to_response(500, {
            "status": "error", "error": f"{type(exc).__name__}: {exc}", "data": None,
        })
    try:
        data = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        data = raw
    return to_response(200, {"status": "ok", "data": data})


@router.get("/ai/recommend", response_model=ApiResponse)
async def profile_ai_recommend():
    """Sonde la machine et propose les modeles locaux qui tiennent dedans.

    Classement curé (catalogue embarqué) : tool-calling + français sont les
    critères NeuroBeats ; `fits` indique si le modèle passe la RAM libre.
    """
    code, res = await run_tool(model_service.recommend, timeout=TIMEOUT_SHORT)
    return to_response(code, res)


@router.get("/ai/models", response_model=ApiResponse)
async def profile_ai_models():
    """Modeles telecharges (manifeste) + fichiers GGUF presents sur disque."""
    code, res = await run_tool(model_service.list_downloaded, timeout=TIMEOUT_SHORT)
    return to_response(code, res)


@router.get("/ai/models/hub", response_model=ApiResponse)
async def profile_ai_models_hub(q: str = "", limit: int = 20):
    """Cherche des depots GGUF sur Hugging Face (hors catalogue cure).

    Resultat mis en cache (10 min) : rouvrir le navigateur ne reinterroge pas le
    Hub a chaque frappe. Panne reseau -> 503 avec un message explicite.
    """
    code, res = await run_tool(hub.search_models, timeout=TIMEOUT_LONG,
                               query=q, limit=limit)
    return to_response(code, res)


@router.get("/ai/models/hub/files", response_model=ApiResponse)
async def profile_ai_models_hub_files(repo: str = ""):
    """Fichiers GGUF d'un depot, avec taille et verdict de compatibilite."""
    code, res = await run_tool(hub.repo_files, timeout=TIMEOUT_LONG, repo_id=repo)
    return to_response(code, res)


@router.get("/ai/models/downloads", response_model=ApiResponse)
@router.get("/ai/models/download/jobs", response_model=ApiResponse,
            include_in_schema=False)
@router.get("/ai/models/download", response_model=ApiResponse,
            include_in_schema=False)
async def profile_ai_download_jobs():
    """Liste les téléchargements dans ``data.jobs``."""
    return await _run_model_command(model_service.list_download_jobs)


@router.get("/ai/models/downloads/{job_id}", response_model=ApiResponse)
@router.get("/ai/models/download/{job_id}/state", response_model=ApiResponse,
            include_in_schema=False)
@router.get("/ai/models/download/{job_id}/status", response_model=ApiResponse,
            include_in_schema=False)
async def profile_ai_download_state(job_id: str):
    """Retourne un job unique ; 404 si son identifiant n'est pas connu."""
    return await _run_model_command(model_service.download_state, job_id=job_id)


@router.post("/ai/models/downloads/{job_id}/pause", response_model=ApiResponse)
@router.post("/ai/models/download/{job_id}/pause", response_model=ApiResponse,
             include_in_schema=False)
async def profile_ai_download_pause(job_id: str):
    """Met en pause un transfert actif et conserve son staging."""
    return await _run_model_command(model_service.pause_download, job_id=job_id)


@router.post("/ai/models/downloads/{job_id}/resume", response_model=ApiResponse)
@router.post("/ai/models/download/{job_id}/resume", response_model=ApiResponse,
             include_in_schema=False)
async def profile_ai_download_resume(job_id: str):
    """Reprend un job ``paused`` dans son staging durable."""
    return await _run_model_command(model_service.resume_download, job_id=job_id)


@router.delete("/ai/models/downloads/{job_id}", response_model=ApiResponse)
@router.post("/ai/models/download/{job_id}/cancel", response_model=ApiResponse,
             include_in_schema=False)
async def profile_ai_download_cancel(job_id: str):
    """Annule un job et supprime son staging ; l'etat final est persistant."""
    return await _run_model_command(model_service.cancel_download, job_id=job_id)


@router.post("/ai/models/download", response_model=ApiResponse)
async def profile_ai_download(body: ModelDownloadRequest):
    """Lance le telechargement d'un modele en arriere-plan -> {job_id}.

    ``model_id`` vise le catalogue cure ; ``repo`` + ``filename`` visent un
    modele choisi sur Hugging Face (hors catalogue). La progression reste
    lisible sur l'ancien flux SSE ``/ai/models/download/{job_id}``.
    """
    entry = None
    if body.repo or body.filename:
        try:
            entry = model_service.custom_entry(
                body.repo or "", body.filename or "",
                size_bytes=body.size_bytes or 0)
        except ValueError as exc:
            return to_response(error_status(str(exc)), {
                "status": "error", "error": str(exc), "data": None,
            })
    return await _run_model_command(model_service.start_download,
                                    model_id=body.model_id or "", entry=entry)


@router.get("/ai/models/download/{job_id}")
async def profile_ai_download_stream(job_id: str, request: Request):
    """Flux SSE de progression d'un telechargement de modele.

    Le flux reste ouvert en pause : il envoie des snapshots courants jusqu'a
    resume/cancel/done. Une deconnexion ferme seulement le producteur SSE, jamais
    le processus worker.
    """
    try:
        await asyncio.to_thread(model_service.download_state, job_id)
    except model_service.DownloadJobNotFound as exc:
        return to_response(404, {"status": "error", "error": str(exc), "data": None})
    except Exception as exc:
        return to_response(500, {
            "status": "error", "error": f"{type(exc).__name__}: {exc}", "data": None,
        })

    async def event_gen():
        yield f"data: {json.dumps({'type': 'job', 'job_id': job_id})}\n\n"
        last_emit = time.monotonic()
        while True:
            if await request.is_disconnected():
                return
            try:
                state = json.loads(
                    await asyncio.to_thread(model_service.download_snapshot, job_id)
                )
            except model_service.DownloadJobNotFound as exc:
                yield f"data: {json.dumps({'type': 'end', 'error': str(exc)})}\n\n"
                return
            except Exception as exc:
                yield f"data: {json.dumps({'type': 'end', 'error': str(exc)})}\n\n"
                return
            payload = {"type": "progress", **state}
            yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
            if state.get("status") in ("done", "error", "cancelled", "canceled"):
                yield f"data: {json.dumps({'type': 'end'})}\n\n"
                return
            if time.monotonic() - last_emit >= 15:
                # Un commentaire SSE ne consomme pas le parseur JSON du client.
                yield ": keep-alive\n\n"
                last_emit = time.monotonic()
            await asyncio.sleep(1.0)

    return StreamingResponse(event_gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no",
                                      "Connection": "keep-alive"})


@router.get("/ai/embedded", response_model=ApiResponse)
async def profile_ai_embedded():
    """État du moteur local : ``idle`` · ``loading`` · ``ready`` · ``error``.

    Lisible PENDANT un chargement : le client poll cet endpoint pour afficher
    une progression réelle au lieu d'attendre une requête bloquante.
    """
    code, res = await run_tool(model_service.embedded_status, timeout=TIMEOUT_SHORT)
    return to_response(code, res)


@router.post("/ai/embedded/start", response_model=ApiResponse)
async def profile_ai_embedded_start(body: EmbeddedStartRequest):
    """(Re)lance le chargement d'un modèle local, sans bloquer.

    Le modèle doit être celui de la sélection (invariant du moteur, garanti par
    `model_service.ensure_embedded`). L'avancement se suit via ``/ai/embedded``.
    """
    code, res = await run_tool(model_service.switch_embedded, timeout=TIMEOUT_SHORT,
                               model_id=body.model_id)
    return to_response(code, res)


@router.post("/ai/embedded/stop", response_model=ApiResponse)
async def profile_ai_embedded_stop():
    """Arrete llama-server (libere la RAM) ; safe si deja arrete."""
    code, res = await run_tool(model_service.stop_embedded, timeout=TIMEOUT_SHORT)
    return to_response(code, res)


# DOIT rester en dernier : le convertisseur `:path` est glouton et capterait
# sinon `/ai/models/downloads/{job_id}` (l'annulation d'un job casserait).
@router.delete("/ai/models/{model_id:path}", response_model=ApiResponse)
async def profile_ai_model_delete(model_id: str):
    """Supprime un modele telecharge (.gguf purge, manifeste nettoye).

    Le parametre est un chemin : l'identifiant d'un modele Hugging Face contient
    des « / » (« depot/fichier.gguf »), qu'un segment unique ne capturerait pas.
    """
    return await _run_model_command(model_service.delete_downloaded, model_id=model_id)
