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
    """Reglages IA : selection unique + blocs par provider (secrets inclus).

    ``selection`` est la source de verite du choix (``{"kind", "model"?}``) :
    l'enregistrer propage le choix partout et desélectionne tout le reste.
    ``provider`` reste accepte pour compatibilite (equivalent a
    ``selection.kind``). `api_key` absent (None) = conserve l'existante ; `""` =
    l'efface.
    """
    selection: Optional[dict] = None
    provider: Optional[str] = None
    ollama: Optional[dict] = None
    lmstudio: Optional[dict] = None
    openai: Optional[dict] = None
    anthropic: Optional[dict] = None
    embedded: Optional[dict] = None


class ModelDownloadRequest(BaseModel):
    """Demande de telechargement d'un modele local.

    Deux formes : ``model_id`` (id du catalogue cure), ou ``repo`` + ``filename``
    pour un modele choisi sur Hugging Face (hors catalogue).
    """
    model_id: str = Field("", description="Id du modele dans le catalogue (ex. qwen3-8b)")
    repo: Optional[str] = Field(None, description="Depot Hugging Face (ex. bartowski/Qwen3-4B-GGUF)")
    filename: Optional[str] = Field(None, description="Fichier GGUF du depot")
    size_bytes: Optional[int] = Field(None, description="Taille annoncee (jauge et espace disque)")


class ModelDownloadJob(BaseModel):
    """Constat public d'un job, partage par REST et SSE.

    ``paused`` est un etat stable : le client peut consulter le job ou le
    reprendre plus tard sans considerer le flux SSE comme termine.
    """
    job_id: str
    model_id: str
    status: str
    received: int = 0
    total: int = 0
    pct: float = 0.0
    speed_mbps: float = 0.0
    error: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    staging_path: Optional[str] = None


class ModelDownloadList(BaseModel):
    """Liste des jobs de telechargement, exposee sous ``data.jobs``."""
    jobs: List[ModelDownloadJob] = Field(default_factory=list)


class EmbeddedStartRequest(BaseModel):
    """Demande de demarrage du serveur d'inference local sur un modele telecharge."""
    model_id: str = Field(..., description="Id du modele telecharge a charger")


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


class PlaylistLocalDownloadRequest(BaseModel):
    """Cibles d'un telechargement local ; vide = toute la playlist."""

    video_ids: list[str] = Field(default_factory=list,
                                description="Titres a telecharger (vide = tous)")


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

