"""Schemas Pydantic de l'API NeuroBeats."""
from typing import Any, List, Optional

from pydantic import BaseModel, Field


class ApiResponse(BaseModel):
    """Enveloppe standard : {status, data, error}."""
    status: str  # "ok" | "error"
    data: Optional[Any] = None
    error: Optional[str] = None


# ----------------------------- Recherche / lecture -----------------------------
class PlayRequest(BaseModel):
    video_id: str = Field(..., description="video_id YouTube (11 caracteres)")


class PlayNowRequest(BaseModel):
    query: str = Field(..., description="Requete a chercher ET jouer en un appel")


class PlayChoiceRequest(BaseModel):
    index: int = Field(..., ge=1, le=10, description="Numero du choix (1-based)")


class PreferenceRequest(BaseModel):
    video_id: str
    rating: int = Field(..., ge=1, le=5)


# ----------------------------- Streaming --------------------------------------
class StreamStartRequest(BaseModel):
    mood: str = ""
    force_genre: bool = True


# ----------------------------- Playlists --------------------------------------
class PlaylistCreateRequest(BaseModel):
    name: str
    mood: str = ""
    count: int = Field(10, ge=1, le=30)


# ----------------------------- Chat -------------------------------------------
class ChatMessage(BaseModel):
    role: str
    content: str = ""


class ChatRequest(BaseModel):
    messages: List[ChatMessage] = Field(default_factory=list)
    max_messages: int = Field(20, ge=1, le=100)
