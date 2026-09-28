"""Etats partages et helpers transverses du moteur NeuroBeats.

Regroupe les caches/verrous globaux et les petites fonctions utilitaires
utilisees par plusieurs services (audio, streaming, recommendation...).
"""
import json
import os
import queue
import re
import subprocess
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from core import config
from core.config import (
    BASE, MODEL, NET_QUALITY, TIMING, YDL_AUDIO_FORMATS, YDL_AUDIO_OPTS,
    YDL_CLIENT_SETS, YDL_OPTS, VIDEO_ID_RE, STOPWORDS,
    STREAM_CACHE_PATH, STREAM_CACHE_TTL, PROBE_URL, PROBE_BYTES,
)

# --- Caches/metadonnees ---
KNOWN: dict = {}          # video_id -> {title, channel}
STREAM_CACHE: dict = {}   # video_id -> stream_url
LAST_SEARCH: dict = {}    # derniere recherche (video_id -> meta)

# --- mpv daemon : UN SEUL mpv, persistant (lecteur singleton) ---
# Socket dans le temp dir de la plateforme (Windows vit sans /tmp). Le nom
# reste stable par utilisateur/machine : c'est "notre" socket, et le reaping
# des orphelins s'appuie dessus (`--input-ipc-server=...` en marqueur).
# Socket IPC du daemon mpv, SCOPÉ PAR PORT : chaque backend (dev 8040, app 8041,
# autre instance NEUROBEATS_PORT=...) a son propre daemon mpv — deux backends
# peuvent tourner côte à côte sans se voler le socket, et le reaping d'orphelins
# (audio._reap_orphan_mpv) ne touche que les mpv liés à NOTRE socket.
def _mpv_ipc_path() -> str:
    """Chemin du canal IPC de mpv, adapte a la plate-forme.

    mpv n'expose son canal que sous deux formes : un socket Unix, ou un **named
    pipe** sous Windows. Ce dernier n'est pas un chemin de systeme de fichiers :
    `os.path.exists` y renvoie toujours False et il ne se supprime pas avec
    `unlink`. Un seul format ne peut donc pas servir les deux — et
    `socket.AF_UNIX` n'existe pas sur Windows, ou le backend demarre en echouant.

    Le nom reste derive du port, pour la meme raison qu'ailleurs : deux backends
    doivent avoir deux canaux distincts.
    """
    nom = f"neurobeats-mpv-{os.environ.get('NEUROBEATS_PORT', '8000')}"
    if os.name == "nt":
        return rf"\\.\pipe\{nom}"
    return os.path.join(tempfile.gettempdir(), f"{nom}.sock")


_MPV_SOCK = _mpv_ipc_path()
_mpv_daemon: subprocess.Popen | None = None
_mpv_ipc_lock = threading.Lock()
_mpv_ipc_seq = 1
_mpv_timing = {"gen": 0, "t_mpv": 0.0, "t_stream": 0.0, "resolve": 0.0, "found": True}
_now_playing = False
_cache_lock = threading.Lock()

# --- Messages du thread timer (affiches hors input() cote CLI) ---
TIMER_MSGS: "queue.Queue[str]" = queue.Queue()

# --- Prefetch (resolution d'URL audio) ---
_prefetch_exec = ThreadPoolExecutor(max_workers=2, thread_name_prefix="prefetch")
_prefetch_cache: dict = {}

# --- Streaming continu infini ---
STREAMING_MODE: bool = False
STREAMING_MOOD: str = ""
STREAMING_FORCE_GENRE: bool = True
STREAMING_COUNT: int = 0
STREAMING_THREAD: threading.Thread | None = None
STREAMING_SKIP = threading.Event()
STREAMING_MAX_TITLE_SECS = 10 * 60

# --- Modes de lecture (file d'attente) ---
SHUFFLE: bool = False       # ordre aleatoire des titres de la file
REPEAT_MODE: str = "off"    # off | all | one ("one" = rejouer le titre courant)

# --- Qualite reseau (mutable, partagee) ---
NET_QUALITY = NET_QUALITY


def _tprint(msg):
    if TIMING:
        print(f"  [t] {msg}", flush=True)


def _tokens(text):
    return [t for t in re.findall(r"[a-z0-9]+", text.lower()) if t not in STOPWORDS]


def _match_score(query, title, channel=""):
    """(score, nb_tokens) : recouvrement des mots significatifs de query dans title+channel."""
    qtokens = _tokens(query)
    if not qtokens:
        return 0.0, 0
    hay = set(_tokens(f"{title} {channel}"))
    hits = sum(1 for t in qtokens if t in hay)
    return hits / len(qtokens), len(qtokens)


def load_json(path, default):
    """Lit un fichier JSON ; retourne `default` s'il est absent ou invalide."""
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path, data):
    """Ecrit `data` en JSON lisible (UTF-8, indente)."""
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _now_ms() -> float:
    return time.perf_counter()


def _drain_timer_msgs():
    """Affiche les messages du thread timer (a appeler hors input() pour ne pas polluer la saisie)."""
    try:
        while True:
            print(TIMER_MSGS.get_nowait(), flush=True)
    except queue.Empty:
        pass


def _remember(video_id, title="", channel=""):
    if video_id:
        KNOWN[video_id] = {"title": title, "channel": channel}
