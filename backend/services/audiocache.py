"""Cache audio EN RAM des titres repetes : aucun fichier, aucun disque.

Un titre que l'utilisateur repete est telecharge **une fois** dans un tampon
memoire, puis rejoue depuis un endpoint localhost au lieu d'etre re-telecharge
de YouTube a chaque passage (mpv fait un `loadfile replace` par passage, ce qui
relance tout le transfert).

Le cache ne grossit pas sans fin : trois plafonds s'appliquent — budget en
octets, nombre de titres, et duree d'inactivite (TTL). Au-dela, on evince les
entrees les moins recemment utilisees (LRU). Rien n'est ecrit sur disque et rien
ne survit au redemarrage du processus.
"""
import os
import threading
import time
import urllib.request
from collections import OrderedDict

from core.config import AUDIO_RAM_BUDGET_MB

# Plafonds appliques ensemble : le plus contraignant gagne.
BUDGET_BYTES = AUDIO_RAM_BUDGET_MB * 1024 * 1024
MAX_TRACKS = 40
IDLE_TTL = 3600.0  # 1 h sans rejeu : l'entree quitte le cache
# 1 Mio par requete : YouTube bride un GET continu (~30-50 Ko/s) alors que des
# requetes `Range` successives repartent a plein debit (meme parade que yt-dlp).
CHUNK = 1024 * 1024
DOWNLOAD_TIMEOUT = 15.0  # par requete ; le decoupage borne l'attente totale
CONTENT_TYPE = "audio/webm"  # itag 251 (Opus) : ce que sert YouTube en bestaudio

PORT = os.environ.get("NEUROBEATS_PORT", "8000")
_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) NeuroBeats/1.0"

_lock = threading.RLock()
# video_id -> {"data": bytearray, "used": float, "complete": bool} ; ordre = LRU.
_entries: "OrderedDict[str, dict]" = OrderedDict()
_filling: set = set()
_bytes_total = 0


def _enabled() -> bool:
    return BUDGET_BYTES > 0


def local_url(video_id: str) -> str:
    """URL localhost servie par notre endpoint (source de relecture)."""
    return f"http://127.0.0.1:{PORT}/api/audio/{video_id}"


def has(video_id: str) -> bool:
    """True si le titre est entierement disponible en RAM."""
    if not video_id or not _enabled():
        return False
    with _lock:
        entry = _entries.get(video_id)
        return bool(entry and entry.get("complete"))


def touch(video_id: str):
    """Marque le titre comme recemment utilise (LRU)."""
    with _lock:
        entry = _entries.get(video_id)
        if entry is not None:
            entry["used"] = time.time()
            _entries.move_to_end(video_id)


def read(video_id: str, start: int, end: int):
    """Plage [start, end] du titre : (octets, total, start, end) ou None si absent."""
    with _lock:
        entry = _entries.get(video_id)
        if not entry or not entry.get("complete"):
            return None
        data = entry["data"]
        total = len(data)
        entry["used"] = time.time()
        _entries.move_to_end(video_id)
    last = max(total - 1, 0)
    lo = max(0, min(int(start), last))
    hi = max(lo, min(int(end), last))
    return bytes(data[lo:hi + 1]), total, lo, hi


def stats() -> dict:
    with _lock:
        return {
            "tracks": len(_entries),
            "bytes": _bytes_total,
            "budget_bytes": BUDGET_BYTES,
            "max_tracks": MAX_TRACKS,
            "filling": len(_filling),
        }


def clear():
    """Vide le cache (aucune ressource externe a liberer)."""
    global _bytes_total
    with _lock:
        _entries.clear()
        _bytes_total = 0


def _log(msg: str):
    """Journal du cache : visible sans TIMING (mise en cache = evenement notable)."""
    print(f"  [audiocache] {msg}", flush=True)


def _evict_locked(now: float, keep: str = ""):
    """Applique TTL, nombre de titres et budget, du plus ancien au plus recent."""
    global _bytes_total

    def _drop(video_id: str):
        global _bytes_total
        _bytes_total -= len(_entries.pop(video_id)["data"])

    for video_id in [v for v, e in _entries.items()
                     if v != keep and now - e.get("used", 0) > IDLE_TTL]:
        _drop(video_id)
    while _entries and (len(_entries) > MAX_TRACKS or _bytes_total > BUDGET_BYTES):
        oldest = next(iter(_entries))
        if oldest == keep and len(_entries) > 1:
            # On garde l'entree courante tant qu'une autre peut partir.
            oldest = next(v for v in _entries if v != keep)
        _drop(oldest)


def _publish(video_id: str, data: bytearray):
    """Publie un titre complet (si sa taille tient dans le budget)."""
    global _bytes_total
    with _lock:
        old = _entries.pop(video_id, None)
        if old is not None:
            _bytes_total -= len(old["data"])
        if len(data) > BUDGET_BYTES:
            _log(f"{video_id} ({len(data) // 1024} Ko) depasse le budget, non cache")
            return
        _entries[video_id] = {"data": data, "used": time.time(), "complete": True}
        _bytes_total += len(data)
        _evict_locked(time.time(), keep=video_id)
        _log(f"{video_id} en RAM ({len(data) // 1024} Ko, total "
             f"{_bytes_total // 1024} Ko / {len(_entries)} titre(s))")


def _download(video_id: str, url: str):
    """Telecharge le flux audio en memoire, par morceaux (jamais sur disque)."""
    buf = bytearray()
    offset = 0
    try:
        while True:
            request = urllib.request.Request(url, headers={
                "User-Agent": _USER_AGENT,
                "Range": f"bytes={offset}-{offset + CHUNK - 1}",
            })
            with urllib.request.urlopen(request, timeout=DOWNLOAD_TIMEOUT) as response:
                piece = response.read()
            if not piece:
                break
            buf.extend(piece)
            offset += len(piece)
            if len(buf) > BUDGET_BYTES:
                _log(f"{video_id} trop volumineux, abandon")
                return
            if len(piece) < CHUNK:
                break
    except Exception as exc:
        _log(f"telechargement {video_id} echoue : {type(exc).__name__}: {exc}")
        return
    if buf:
        _publish(video_id, buf)


def ensure_async(video_id: str, url: str) -> bool:
    """Met le titre en cache RAM en tache de fond. Idempotent.

    Returns:
        True si un telechargement a ete lance, False si deja cache ou en cours.
    """
    if not video_id or not url or not _enabled():
        return False
    with _lock:
        entry = _entries.get(video_id)
        if entry and entry.get("complete"):
            entry["used"] = time.time()
            _entries.move_to_end(video_id)
            return False
        if video_id in _filling:
            return False
        _filling.add(video_id)
        _evict_locked(time.time())

    def _run():
        try:
            _download(video_id, url)
        finally:
            with _lock:
                _filling.discard(video_id)

    threading.Thread(target=_run, daemon=True, name="audiocache").start()
    return True
