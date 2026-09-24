"""Paroles des titres : endpoint GET /api/lyrics (synchronisees si dispo)."""
from fastapi import APIRouter

from core.config import LYRICS_ENABLED, VIDEO_ID_RE
from dependencies.responses import TIMEOUT_SHORT, run_tool, to_response
from services import lyrics

router = APIRouter(prefix="/api", tags=["lyrics"])


@router.get("/lyrics")
async def get_lyrics(video_id: str, title: str = "", channel: str = "",
                     duration: float = 0):
    """Paroles d'un titre (synchronisees si disponibles, sinon texte brut).

    `title`/`channel`/`duration` sont des replis clients : le serveur resout les
    metadonnees lui-meme (historique/KNOWN), ces parametres ne servent que pour
    un titre pas encore joue (file prechargee, dernier historique vide).

    Reponses (enveloppe `data`) :
      {found: true,  synced, source: "lrclib"|"genius", instrumental, lines:[{time,text}]}
      {found: false, message: null}            aucune source ne possede les paroles
      {found: false, message: "...", retryable}  panne reseau -> bouton Reessayer
    """
    if not VIDEO_ID_RE.match(video_id):
        return to_response(400, {"status": "error",
                                 "error": "Identifiant de vidéo invalide.", "data": None})
    if not LYRICS_ENABLED:
        # Coupe proprement : l'UI affiche le repli « aucune parole ».
        return to_response(200, {"status": "ok", "data": lyrics._not_found()})
    dur = duration or None
    code, res = await run_tool(lyrics.get_lyrics, timeout=TIMEOUT_SHORT,
                               video_id=video_id, title=title, channel=channel,
                               duration=dur)
    return to_response(code, res)