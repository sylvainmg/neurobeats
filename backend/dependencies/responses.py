"""Helpers partages par les routers : execution des tools moteur + enveloppe API."""
import asyncio
import json
import re

from fastapi.responses import JSONResponse

from core.config import TIMING

TIMEOUT_LONG = 120  # reco / playlist / play_now (inference genre + O2 + ytsearch)
TIMEOUT_SHORT = 30  # autres


def error_status(message: str) -> int:
    """Mappe un message d'erreur moteur vers un code HTTP."""
    m = (message or "").lower()
    if re.search(r"introuvable|inconnu|\bvide\b|aucun", m):
        return 404
    if re.search(r"indisponible|hors-ligne|offline", m):
        return 503
    if re.search(r"invalide|trop vague|hors limites", m):
        return 422
    return 400


async def run_tool(tool, timeout=TIMEOUT_SHORT, **kwargs):
    """Execute un tool moteur (bloquant) hors event-loop et normalise la reponse.

    Retourne un tuple (code_http, corps_json).
    """
    print(f"[API] {getattr(tool, '__name__', tool)} {kwargs}", flush=True)
    try:
        raw = await asyncio.wait_for(asyncio.to_thread(tool, **kwargs), timeout)
    except asyncio.TimeoutError:
        return 504, {"status": "error",
                     "error": f"Timeout {timeout}s sur {getattr(tool, '__name__', tool)}",
                     "data": None}
    except Exception as exc:
        return 500, {"status": "error", "error": f"{type(exc).__name__}: {exc}", "data": None}
    try:
        data = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        data = raw if isinstance(raw, (dict, list)) else {"raw": raw}
    if isinstance(data, dict) and data.get("error"):
        return error_status(data["error"]), {"status": "error", "error": data["error"], "data": data}
    return 200, {"status": "ok", "data": data}


def to_response(code: int, body: dict) -> JSONResponse:
    """Construit la JSONResponse a partir du couple (code HTTP, corps)."""
    return JSONResponse(status_code=code, content=body)
