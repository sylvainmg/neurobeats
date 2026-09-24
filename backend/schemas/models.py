"""Schemas Pydantic de l'API NeuroBeats."""
from typing import Any, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


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


class SeekRequest(BaseModel):
    position: float = Field(..., ge=0, description="Position en secondes")


class VolumeRequest(BaseModel):
    volume: int = Field(..., ge=0, le=100, description="Volume (0-100)")


class PreferenceRequest(BaseModel):
    video_id: str
    rating: int = Field(..., ge=1, le=5)


# ----------------------------- Streaming --------------------------------------
class StreamStartRequest(BaseModel):
    mood: str = ""
    force_genre: bool = True


class ShuffleRequest(BaseModel):
    shuffle: bool


class RepeatRequest(BaseModel):
    mode: Literal["off", "all", "one"]


class JumpRequest(BaseModel):
    index: int = Field(
        ..., ne=0,
        description="Position dans la file (1-based) ; negatif = pas en arriere "
                    "dans les titres deja passes (rejoue le titre)",
    )


class QueueRemoveRequest(BaseModel):
    index: int = Field(
        ..., ge=1,
        description="Position dans la file (1-based), parmi les titres a venir",
    )


# ----------------------------- Profil -----------------------------------------
class IdentityUpdateRequest(BaseModel):
    """Mise a jour partielle : un champ absent (`None`) reste inchange."""
    first_name: Optional[str] = Field(None, max_length=60)
    last_name: Optional[str] = Field(None, max_length=60)


class AvatarRequest(BaseModel):
    avatar: str = Field(..., description="Photo en data URL (image png, jpeg ou webp)")


class AiSettingsRequest(BaseModel):
    """Reglages IA : fournisseur actif + blocs par provider (secrets inclus).

    `api_key` absent (None) = conserve l'existante ; `""` = l'efface.
    """
    provider: Optional[str] = None
    ollama: Optional[dict] = None
    lmstudio: Optional[dict] = None
    openai: Optional[dict] = None
    anthropic: Optional[dict] = None


# ----------------------------- Playlists --------------------------------------
class PlaylistCreateRequest(BaseModel):
    # `mood` renseigne => generation IA (recommandations) ; vide => playlist vide.
    # `video_ids` renseigne => playlist composee EXACTEMENT de ces titres (selection UI).
    name: str
    mood: str = ""
    count: int = Field(10, ge=1, le=30)
    video_ids: List[str] = Field(default_factory=list)


class PlaylistPatchRequest(BaseModel):
    name: str = Field(..., min_length=1, description="Nouveau nom de la playlist")


class PlaylistTrackRequest(BaseModel):
    video_id: str = Field(..., description="video_id YouTube (11 caracteres)")


class PlaylistPlayRequest(BaseModel):
    start: int = Field(0, ge=0, description="Index du titre de depart (0 = premier)")


# ----------------------------- Chat -------------------------------------------
class ChatMessage(BaseModel):
    # L'historique renvoye par le serveur contient aussi les `tool_calls` de
    # l'assistant et les messages `role="tool"` : `extra="allow"` les conserve
    # quand le client les renvoie au tour suivant (sinon Pydantic les jetterait).
    model_config = ConfigDict(extra="allow")

    role: str
    content: str = ""


class ChatRequest(BaseModel):
    messages: List[ChatMessage] = Field(default_factory=list)
    max_messages: int = Field(20, ge=1, le=100)
    # « global » : assistant musical ; « profile » : assistant dedie aux gouts.
    scope: Literal["global", "profile"] = "global"


# --------------------------- Transfert mobile ----------------------------------
class TransferRequest(BaseModel):
    """Playlist a transferer vers le telephone (le bureau ouvre la session)."""

    playlist_id: str = Field(..., description="Identifiant ou nom de la playlist")
    mode: str = Field(
        "",
        description="« emulateur » pour que le code porte l'adresse vue depuis "
        "l'émulateur Android (10.0.2.2) plutôt que celle du réseau local",
    )

