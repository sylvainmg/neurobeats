"""Configuration et constantes du moteur NeuroBeats."""
import os
import shutil

# Racine du code livree dans le bundle et racine des donnees ecritures.
# Les donnees ne doivent jamais retomber dans le code en production : un
# un backend web et une AppImage lances sur la même machine partageaient alors
# leur historique, leurs caches et leurs reglages. Le desktop fournit toujours
# NEUROBEATS_DATA_DIR ; ce default sert aux lancements CLI/web directs.
CODE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _default_data_root() -> str:
    profile = (os.environ.get("NEUROBEATS_PROFILE") or "web").strip() or "web"
    profile = "".join(char for char in profile if char.isalnum() or char in "-_")[:32] or "web"
    system = os.name
    if system == "nt":
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
    elif system == "posix" and os.uname().sysname == "Darwin":
        base = os.path.join(os.path.expanduser("~"), "Library", "Application Support")
    else:
        base = os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share")
    return os.path.abspath(os.path.join(base, "neurobeats", profile))


DATA_ROOT = os.path.abspath(os.path.expanduser(os.environ.get("NEUROBEATS_DATA_DIR") or _default_data_root()))
BASE = DATA_ROOT
os.makedirs(DATA_ROOT, exist_ok=True)

MODEL = "qwen2.5:7b"
TIMING = os.environ.get("NEUROBEATS_TIMING") == "1"  # affiche les temps par etape

# Recherche YouTube (flat, IPv4 force pour la latence).
# socket_timeout borne les recherches : sans lui, une connexion qui stalle peut
# bloquer indefiniment la reco (donc le remplissage de file).
YDL_OPTS = {
    "quiet": True, "no_warnings": True, "noplaylist": True,
    "extract_flat": "in_playlist", "source_address": "0.0.0.0",
    "socket_timeout": 15, "retries": 2,
}

# Qualite audio adaptative : probe reseau -> format + clients dynamiques.
# Seuils : high >= 5 Mbps (opus 251), mid (aac <=128k), low < 1.5 Mbps (aac <=64k).
# skip=hls conserve partout (HLS = live/latence, pas d'adaptatif utile ici). Pas de ffmpeg :
# mpv decode deja opus/vorbis/aac nativement, transcoder = CPU + latence + perte.
NET_QUALITY: str = "high"  # high | mid | low, mesure au demarrage (RAM)
YDL_AUDIO_FORMATS = {
    "high": "bestaudio/best",
    "mid": "bestaudio[abr<=128]/bestaudio/best",
    "low": "bestaudio[abr<=64]/bestaudio/best",
}
# Clients tentes EN ORDRE (3 configs) : mediaconnect, default,-web, +web
YDL_CLIENT_SETS = [
    ["mediaconnect", "default", "-web"],
    ["default", "-web"],
    ["default", "-web", "web"],
]
PROBE_URL = "https://ash-speed.hetzner.com/100MB.bin"  # gros fichier : mesure honnete
PROBE_BYTES = 10 * 1024 * 1024  # 10 Mo sur connexion unique (pas de re-handshake)

YDL_AUDIO_OPTS = {
    "quiet": True, "no_warnings": True, "noplaylist": True,
    "format": "bestaudio/best",  # opus 251 prioritaire : pas de cap abr (qualite max)
    "source_address": "0.0.0.0",
    "socket_timeout": 10,
    "retries": 3,
    # Clients rapides verifies (opus 251 conserve, ~2.3s vs 4.3s base).
    # skip=hls : ignore les manifests live, garde le DASH (itag 140/251).
    "extractor_args": {"youtube": {"player_client": ["mediaconnect", "default", "-web"], "skip": ["hls"]}},
}

# Cache disque des URLs audio (googlevideo expire en ~5-6h)
STREAM_CACHE_PATH = f"{BASE}/stream_cache.json"
STREAM_CACHE_TTL = 5 * 3600

# Cache audio EN RAM des titres repetes (jamais sur disque) : plafond total en Mo.
# Volontairement modeste : ~4.6 Mo par titre, donc ~40 titres a 192 Mo.
def _ram_budget_mb() -> int:
    try:
        return max(16, int(os.environ.get("NEUROBEATS_AUDIO_RAM_MB", "192")))
    except (TypeError, ValueError):
        return 192


AUDIO_RAM_BUDGET_MB = _ram_budget_mb()


# --- Pochettes HQ -----------------------------------------------------------
# Trois sources, essayees dans cet ordre : jaquette d'album reelle (carree, donc
# aucun pixel perdu au recadrage), frame HD extraite de la video (choisie pour
# correspondre a la vignette officielle), puis la vignette YouTube publiee.
#
# Raison d'etre : YouTube ne publie jamais plus de 1280x720 en 16/9 et, pour une
# partie des videos (y compris disponibles en 4K), aucune vignette HD n'existe.
# Or une carte carree de ~300 px reclame 614 px de haut en DPR 2 et 921 px en
# DPR 3 : le plafond publie ne suffit pas, il faut generer la pochette.
def _int_env(name: str, default: int, minimum: int = 0) -> int:
    """Entier d'environnement borne au minimum (valeur illisible -> defaut)."""
    try:
        return max(minimum, int(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


COVERS_DIR = f"{BASE}/covers"
COVERS_ENABLED = os.environ.get("NEUROBEATS_COVERS", "1") != "0"
COVERS_TARGET_PX = _int_env("NEUROBEATS_COVERS_PX", 1024, 128)
COVERS_BUDGET_MB = _int_env("NEUROBEATS_COVERS_MB", 256)
COVERS_TTL_DAYS = _int_env("NEUROBEATS_COVERS_TTL_DAYS", 90, 1)
COVERS_MAX_WORKERS = _int_env("NEUROBEATS_COVERS_WORKERS", 2, 1)
COVERS_FRAME_CAP = _int_env("NEUROBEATS_COVERS_FRAME_HEIGHT", 1080, 240)
# Attente d'une generation deja en cours avant de repondre « pas prete » : le
# client affiche la vignette YouTube entre-temps, l'attente est donc invisible.
COVERS_WAIT_SECS = 2.0
# Un echec (video privee, geo-bloquee, sans source) n'est pas retente avant ca.
COVERS_MISS_TTL = 7 * 24 * 3600
# Confiance minimale du rapprochement album/titre, et similarite minimale entre
# une frame candidate et la vignette officielle. En dessous : palier suivant.
COVERS_MATCH_MIN = 0.80
COVERS_SSIM_MIN = 0.55
FFMPEG = shutil.which("ffmpeg") or ""

# --- Paroles -----------------------------------------------------------------
# Deux delais de patience distincts : une paroles trouvee ne change quasi jamais
# (TTL long), alors qu'une absence est temporaire le plus souvent (LRCLIB enrichi,
# titre sorti d'une vagues de saisie) — le cache negatif reste donc court. Sans
# cache, chaque titre rejoue chercherait les memes sources gratuites : un hit
# reseau existe, LRCLIB impose un rate-limit genereux mais un.
def _lyrics_ttl_days() -> int:
    try:
        return max(1, int(os.environ.get("NEUROBEATS_LYRICS_TTL_DAYS", 30)))
    except (TypeError, ValueError):
        return 30


def _lyrics_miss_ttl_days() -> int:
    try:
        return max(1, int(os.environ.get("NEUROBEATS_LYRICS_MISS_TTL_DAYS", 7)))
    except (TypeError, ValueError):
        return 7


# Paroles : sources gratuites (LRCLIB puis Genius), sans cle d'API.
# NEUROBEATS_LYRICS=0 coupe tout (l'UI affiche alors le repli « aucune parole »).
LYRICS_ENABLED = os.environ.get("NEUROBEATS_LYRICS", "1") != "0"
LYRICS_TTL_DAYS = _lyrics_ttl_days()
LYRICS_MISS_TTL_DAYS = _lyrics_miss_ttl_days()
# Borne volontairement courte : une source lente ne doit pas retarder le panneau
# ; le repli Genius est alors skippe plutot que d'attendre son tour.
LYRICS_TIMEOUT = _int_env("NEUROBEATS_LYRICS_TIMEOUT", 12, 3)
# Confiance minimale du rapprochement paroles <-> titre (LRCLIB search, Genius).
# Plus souple que COVERS_MATCH_MIN : les bases de paroles ecrivent les titres
# autrement (feat., ponctuation), et une paroles rattachee au bon artiste reste
# acceptable meme si le titre differe legerement.
LYRICS_MATCH_MIN = 0.55

# Metadonnees completes d'une video (PAS extract_flat : on veut les vignettes
# publiees, la duree et les formats). Sert au choix de la source des pochettes.
YDL_INFO_OPTS = {
    "quiet": True, "no_warnings": True, "noplaylist": True,
    "skip_download": True, "source_address": "0.0.0.0",
    "socket_timeout": 10, "retries": 2,
}

# Flux VIDEO, uniquement pour extraire une frame : borne en hauteur pour ne pas
# tirer de la 4K destinee a une image de 1024 px.
YDL_VIDEO_OPTS = {
    "quiet": True, "no_warnings": True, "noplaylist": True,
    "format": (f"bestvideo[height<={COVERS_FRAME_CAP}][ext=mp4]/"
               f"bestvideo[height<={COVERS_FRAME_CAP}]/"
               f"best[height<={COVERS_FRAME_CAP}]"),
    "source_address": "0.0.0.0", "socket_timeout": 10, "retries": 3,
    "extractor_args": {"youtube": {"player_client": list(YDL_CLIENT_SETS[0]),
                                   "skip": ["hls"]}},
}

MPV_BASE_ARGS = [
    "mpv", "--no-video", "--vid=no", "--audio-display=no", "--really-quiet",
    "--msg-level=all=status",  # garde "A: 00:00:xx" sur stdout malgre --really-quiet
    "--profile=low-latency",
    "--demuxer-readahead-secs=1", "--demuxer-max-bytes=4MiB",
    "--cache-secs=3", "--cache-pause-wait=0.3", "--audio-buffer=0.7",
]

# Recherche de titres YouTube (ytsearch)
VIDEO_ID_RE = __import__("re").compile(r"^[A-Za-z0-9_-]{11}$")
STOPWORDS = {
    "de", "du", "des", "le", "la", "les", "un", "une", "et", "the", "a", "an",
    "of", "to", "in", "on", "and", "or", "for", "with", "par", "feat", "ft",
    "qui", "pour", "avec", "sur", "dans", "est", "sont", "plus", "mon", "ma",
    "mes", "ton", "ta", "tes", "son", "sa", "ses", "notre", "votre", "leur",
    "is", "are", "it", "this", "that", "my", "your",
    "lance", "lancer", "lancez", "joue", "jouer", "jouez", "mets", "mettre",
    "mettez", "ecoute", "ecouter", "ecoutez", "demarre", "demarrer",
    "demarrez", "play", "musique", "chanson", "titre", "morceau", "video",
    "stp", "svp", "plait", "veux", "voudrais", "moi", "nous", "donne",
    "donnez", "remets", "relance", "rejoue",
}
