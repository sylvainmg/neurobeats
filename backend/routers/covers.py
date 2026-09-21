"""Pochettes HQ : sert l'image carree generee pour un titre."""
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from core.config import COVERS_ENABLED, COVERS_WAIT_SECS, VIDEO_ID_RE
from services import covers
from services.db_access import _meta

router = APIRouter(prefix="/api", tags=["covers"])


@router.api_route("/covers/{video_id}", methods=["GET", "HEAD"], include_in_schema=False)
def cover(request: Request, video_id: str):
    """Sert la pochette HQ d'un titre, en la programmant si elle manque.

    Synchrone volontairement : l'attente eventuelle — le temps qu'une generation
    deja lancee aboutisse — se fait dans le threadpool de FastAPI. La boucle
    d'evenements, qui sert l'audio, n'est donc jamais retardee par une pochette.

    Reponses possibles :
      200 l'image webp carree ;
      202 generation en cours — le client garde la vignette YouTube et retente ;
      404 aucune source exploitable, la vignette YouTube fait alors office de
          pochette (c'est le cas normal d'une video privee ou retiree).
    """
    if not VIDEO_ID_RE.match(video_id):
        raise HTTPException(status_code=400, detail="Identifiant de vidéo invalide.")
    if not COVERS_ENABLED:
        raise HTTPException(status_code=404, detail="Pochettes HQ désactivées.")

    data = covers.read(video_id)
    if data is None:
        meta = _meta(video_id) or {}
        covers.ensure_async(video_id, meta.get("title", ""), meta.get("channel", ""))
        data = covers.wait_read(video_id, COVERS_WAIT_SECS)
    if data is None:
        if covers.generating(video_id):
            return Response(status_code=202, headers={"Retry-After": "2"})
        raise HTTPException(status_code=404, detail="Pas de pochette HQ pour ce titre.")

    # `Content-Length` explicite (comme l'endpoint audio) : un HEAD doit annoncer
    # la taille reelle. Le cache navigateur est long : une pochette ne change pas.
    headers = {
        "Content-Length": str(len(data)),
        "Cache-Control": "public, max-age=86400",
    }
    return Response(content=b"" if request.method == "HEAD" else data,
                    media_type="image/webp", headers=headers)
