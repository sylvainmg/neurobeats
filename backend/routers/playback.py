"""Lecture audio : play, play_now, play_choice, stop, etat courant."""
import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from dependencies.responses import TIMEOUT_LONG, run_tool, to_response
from schemas.models import (
    ApiResponse, PlayChoiceRequest, PlayNowRequest, PlayRequest,
    SeekRequest, VolumeRequest,
)
from services import audiocache
from services.audio import (
    playback_state, play_and_stream, play_choice, prepare_playback, seek_music,
    set_volume, stop_music, toggle_pause,
)
from services.youtube import play_now

router = APIRouter(prefix="/api", tags=["playback"])

_LOOPBACK = {"127.0.0.1", "::1", "localhost"}


def _parse_range(value: str) -> tuple[int, int]:
    """Plage demandee en [debut, fin] ; tout le contenu si absente/illisible."""
    if not value.startswith("bytes="):
        return 0, 1 << 62
    start, _, end = value[6:].split(",")[0].strip().partition("-")
    try:
        if not start:
            # Suffixe (`bytes=-N`) : rare ici, on sert tout le contenu.
            return 0, 1 << 62
        return int(start), (int(end) if end else 1 << 62)
    except ValueError:
        return 0, 1 << 62


@router.api_route("/audio/{video_id}", methods=["GET", "HEAD"], include_in_schema=False)
async def audio_cache_endpoint(request: Request, video_id: str):
    """Sert un titre depuis le cache RAM local (lecture mpv uniquement).

    Reimplemente les requetes `Range` : mpv s'en sert pour se deplacer dans le
    titre, il faut donc repondre 206 + `Content-Range` pour que le seek marche.
    """
    host = request.client.host if request.client else ""
    if host not in _LOOPBACK:
        raise HTTPException(status_code=403, detail="Réservé au lecteur local.")
    start, end = _parse_range(request.headers.get("range", ""))
    item = audiocache.read(video_id, start, end)
    if item is None:
        raise HTTPException(status_code=404, detail="Titre absent du cache RAM.")
    data, total, lo, hi = item
    # `Content-Length` explicite : un HEAD doit annoncer la taille reelle (sinon
    # mpv/ffmpeg lit 0 et croit le flux vide).
    headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "Content-Length": str(len(data)),
    }
    status = 200
    if start > 0 or end < (1 << 62):
        headers["Content-Range"] = f"bytes {lo}-{hi}/{total}"
        status = 206
    body = b"" if request.method == "HEAD" else data
    return Response(content=body, status_code=status,
                    media_type=audiocache.CONTENT_TYPE, headers=headers)


@router.get("/now", response_model=ApiResponse)
async def now():
    """Etat de lecture courant (titre, position, duree)."""
    return {"status": "ok", "data": json.loads(playback_state())}


@router.post("/play", response_model=ApiResponse)
async def play(body: PlayRequest):
    """Joue la video fournie puis demarre le flux infini (auto-streaming)."""
    code, res = await run_tool(play_and_stream, video_id=body.video_id)
    return to_response(code, res)


@router.post("/play_now", response_model=ApiResponse)
async def play_now_endpoint(body: PlayNowRequest):
    """Cherche la requete et joue directement le meilleur resultat."""
    code, res = await run_tool(play_now, timeout=TIMEOUT_LONG, query=body.query)
    return to_response(code, res)


@router.post("/play_choice", response_model=ApiResponse)
async def play_choice_endpoint(body: PlayChoiceRequest):
    """Joue le n-ieme resultat de la derniere recherche (index 1-based)."""
    code, res = await run_tool(play_choice, index=body.index)
    return to_response(code, res)


@router.post("/stop", response_model=ApiResponse)
async def stop():
    """Arrete la lecture en cours."""
    code, res = await run_tool(stop_music)
    return to_response(code, res)


@router.post("/prepare", response_model=ApiResponse)
async def prepare():
    """Prepare la lecture : dernier titre charge en pause + file pre-chargee."""
    code, res = await run_tool(prepare_playback, timeout=TIMEOUT_LONG)
    return to_response(code, res)


@router.post("/pause", response_model=ApiResponse)
async def pause():
    """Bascule pause/reprise de la lecture en cours."""
    code, res = await run_tool(toggle_pause)
    return to_response(code, res)


@router.post("/seek", response_model=ApiResponse)
async def seek(body: SeekRequest):
    """Deplace la lecture a une position (secondes)."""
    code, res = await run_tool(seek_music, position=body.position)
    return to_response(code, res)


@router.post("/volume", response_model=ApiResponse)
async def volume(body: VolumeRequest):
    """Regle le volume de lecture (0-100)."""
    code, res = await run_tool(set_volume, volume=body.volume)
    return to_response(code, res)
