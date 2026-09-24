"""Transfert vers le telephone : le code, le manifeste, les fichiers.

Deux publics bien separes :

- la **creation** d'une session est reservee a la machine du bureau (le navigateur
  affiche le code) ;
- la **lecture** du manifeste et des fichiers accepte le telephone sur le reseau
  local, mais seulement avec le jeton porte par le code.

Le chemin `/t/...` est volontairement court : il finit dans un code QR, et chaque
caractere en plus le rend plus dense donc plus dur a scanner.
"""
import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from core.config import VIDEO_ID_RE
from dependencies.responses import TIMEOUT_SHORT, run_tool, to_response
from schemas.models import ApiResponse, TransferRequest
from services import transfer

router = APIRouter(tags=["transfer"])

_LOOPBACK = {"127.0.0.1", "::1", "localhost"}
# Ce que YouTube sert en bestaudio : le relais le reprend tel quel.
DEFAULT_AUDIO_TYPE = "audio/webm"


@router.post("/api/transfer", response_model=ApiResponse)
async def transfer_create(body: TransferRequest, request: Request):
    """Ouvre une session de transfert et rend le code a afficher.

    Reserve au bureau : le code est une cle d'acces au reseau local, sa creation
    ne doit pas etre possible depuis l'exterieur.
    """
    host = request.client.host if request.client else ""
    if host not in _LOOPBACK:
        raise HTTPException(status_code=403, detail="Réservé au bureau local.")
    code, res = await run_tool(transfer.create, timeout=TIMEOUT_SHORT,
                               playlist_id=body.playlist_id, mode=body.mode)
    return to_response(code, res)


@router.api_route("/t/{session}", methods=["GET", "HEAD"], include_in_schema=False)
def transfer_manifest(session: str, k: str = ""):
    """Manifeste : ce que le telephone doit telecharger, avec ses URLs."""
    data = json.loads(transfer.manifest(session, k))
    if data.get("error"):
        raise HTTPException(status_code=404, detail=data["error"])
    return JSONResponse(content=data)


@router.api_route("/t/{session}/c/{video_id}", methods=["GET", "HEAD"],
                  include_in_schema=False)
def transfer_cover(session: str, video_id: str, k: str = ""):
    """Sert la pochette du titre, telle que le bureau l'affiche.

    Le telephone la rapatrie a l'import : c'est ce qui lui permet de montrer la
    meme image hors ligne, sans rien recalculer.
    """
    if not VIDEO_ID_RE.match(video_id):
        raise HTTPException(status_code=400, detail="Identifiant de vidéo invalide.")
    octets = transfer.pochette(session, k, video_id)
    if not octets:
        raise HTTPException(status_code=404, detail="Pochette indisponible.")
    return Response(
        content=octets,
        media_type="image/webp",
        headers={"Cache-Control": "private, max-age=86400"},
    )


@router.api_route("/t/{session}/a/{video_id}", methods=["GET", "HEAD"],
                  include_in_schema=False)
def transfer_audio(session: str, video_id: str, request: Request, k: str = ""):
    """Sert un titre du transfert, plage par plage.

    Un titre prepare part du disque du bureau — il porte alors ses etiquettes et sa
    pochette ; les autres sont relayes depuis YouTube en requetes bornees, comme
    mpv se deplace dans un titre. Dans les deux cas la reponse annonce la taille
    totale, donc la reprise est possible.
    """
    if not VIDEO_ID_RE.match(video_id):
        raise HTTPException(status_code=400, detail="Identifiant de vidéo invalide.")
    source = transfer.source_audio(session, k, video_id)
    if not source:
        if not transfer.connue(session, k, video_id):
            raise HTTPException(status_code=404,
                                detail="Titre indisponible pour cette session.")
        # Titre de la session, mais pas joignable à cette seconde (préparation pas
        # finie, YouTube qui souffle) : on ne prononce pas un échec — on relance la
        # préparation en fond et on invite le téléphone à repasser dans 3 s.
        transfer.relancer_preparation(session, k, video_id)
        raise HTTPException(status_code=409,
                            detail="Titre en cours de préparation.",
                            headers={"Retry-After": "3"})
    chemin, type_audio = source
    status, headers, body = transfer.serve(chemin, request.headers.get("range", ""),
                                           type_audio)
    if status == 502:
        raise HTTPException(status_code=502, detail="Source audio injoignable.")
    if request.method == "HEAD":
        return Response(status_code=status, headers=headers)
    return StreamingResponse(body, status_code=status, headers=headers)
