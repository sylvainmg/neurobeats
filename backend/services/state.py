"""Etats partages et helpers transverses du moteur NeuroBeats.

Regroupe les caches/verrous globaux et les petites fonctions utilitaires
utilisees par plusieurs services (audio, streaming, recommendation...).
"""
import json
import os
import queue
import re
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from core import config
from core.config import (
    BASE, MODEL, NET_QUALITY, TIMING, YDL_AUDIO_FORMATS, YDL_AUDIO_OPTS,
    YDL_CLIENT_SETS, YDL_OPTS, MPV_BASE_ARGS, VIDEO_ID_RE, STOPWORDS,
    STREAM_CACHE_PATH, STREAM_CACHE_TTL, PROBE_URL, PROBE_BYTES,
)

# --- Caches/metadonnees ---
KNOWN: dict = {}          # video_id -> {title, channel}
STREAM_CACHE: dict = {}   # video_id -> stream_url
LAST_SEARCH: dict = {}    # derniere recherche (video_id -> meta)

# --- mpv process/daemon ---
_player: subprocess.Popen | None = None
_player_t0: float = 0.0
_MPV_SOCK = "/tmp/neurobeats-mpv.sock"
_mpv_daemon: subprocess.Popen | None = None
_mpv_ipc_lock = threading.Lock()
_mpv_ipc_seq = 1
_mpv_timing = {"gen": 0, "t_mpv": 0.0, "t_stream": 0.0, "resolve": 0.0, "found": True}
_now_playing = False
_FIRST_PAT = re.compile(r"A: 00:00:0[1-9]|A: 00:00:[1-9]")
_cache_lock = threading.Lock()

# --- Messages du thread timer (affiches hors input() cote CLI) ---
TIMER_MSGS: "queue.Queue[str]" = queue.Queue()

# --- Prefetch ---
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


def _watch_first_second(proc, t_mpv_start, t_stream_start=None, resolve_dur=0.0):
    """Thread permanent : detecte le demarrage reel (A: 00:00:00) puis le 1er son confirme (A: 00:00:01).
    mpv separe ses statuts par \\r, donc on lit par blocs et on decoupe sur \\r et \\n.
    Affiche TOUJOURS le chrono total : appel streaming -> premier son audible.
    Apres detection, continue de drainer le pipe (sinon mpv bloque quand le buffer est plein)."""
    import re as _re
    start_pat = _re.compile(rb"A: 00:00:00")
    first_pat = _re.compile(r"A: 00:00:0[1-9]|A: 00:00:[1-9]")
    read = getattr(proc, "read", None)
    if read is None:
        print(f"  ⏱ debug mpv indisponible (stdout non pipe, mpv exit={proc.poll()})", flush=True)
        return
    if t_stream_start is None:
        t_stream_start = t_mpv_start
    started = found = False
    try:
        buf = b""
        for chunk in iter(lambda: read(1024), b""):
            if not chunk:
                break
            buf += chunk
            *lines, buf = _re.split(rb"[\r\n]", buf)
            for line in lines:
                if not started and start_pat.search(line):
                    started = True
                    _tprint(f"demarrage decodeur : {time.perf_counter() - t_mpv_start:.1f}s depuis lancement mpv")
                if not found and first_pat.search(line.decode(errors="replace")):
                    found = True
                    now = time.perf_counter()
                    total = now - t_stream_start
                    mpv_to_sound = now - t_mpv_start
                    TIMER_MSGS.put(
                        f"  ⏱ Premier son audible en {total:.1f}s "
                        f"(résolution {resolve_dur:.1f}s + mpv→son {mpv_to_sound:.1f}s)")
            if proc.poll() is not None and not chunk:
                break
    except Exception:
        pass
    if not found:
        now = time.perf_counter()
        TIMER_MSGS.put(f"  ⏱ Aucun son détecté après {now - t_stream_start:.1f}s (mpv exit={proc.poll()})")


def _remember(video_id, title="", channel=""):
    if video_id:
        KNOWN[video_id] = {"title": title, "channel": channel}
