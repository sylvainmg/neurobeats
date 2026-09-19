"""Configuration et constantes du moteur NeuroBeats."""
import os

# Dossier backend/ (code + donnees partagees avec l'API)
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MODEL = "qwen2.5:7b"
TIMING = os.environ.get("NEUROBEATS_TIMING") == "1"  # affiche les temps par etape

# Recherche YouTube (flat, IPv4 force pour la latence)
YDL_OPTS = {
    "quiet": True, "no_warnings": True, "noplaylist": True,
    "extract_flat": "in_playlist", "source_address": "0.0.0.0",
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
