"""Temps reel : push de l'etat au client web + presence (arret du flux).

Le moteur audio tourne cote serveur : sans client connecte, le flux infini
continuerait indefiniment pour personne. Ce module tient un WebSocket unique par
client, pousse un instantane (lecture + file) environ 1x/s au lieu de laisser le
front poller, et arrete le flux quand le dernier client est parti (apres un delai
de grace, pour ne pas couper la musique sur un simple rechargement).

Les commandes (play/pause/skip/...) restent en REST : le WS ne sert qu'a l'etat
et a la presence.
"""
import asyncio
import json
import threading
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from services import state
from services.audio import playback_state
from services.playlists import playlists_rev
from services.queue import queue_snapshot
from services.state import _tprint
from services.streaming import stop_streaming

router = APIRouter(tags=["realtime"])

CLIENT_GRACE_SECS = 10.0  # tolere un reload : le client se reconnecte bien avant
# ~4 Hz : la barre de progression et le retour apres une commande restent fluides.
# Cout modeste (3 lectures mpv IPC + copie de file) et mutualise pour tous les
# clients — mieux que le polling 1 Hz par onglet qu'il remplace.
SNAPSHOT_INTERVAL = 0.25
QUEUE_EVERY = 4           # la file change rarement : incluse ~1x/s

_CLIENTS: set = set()
_LOOP: asyncio.AbstractEventLoop | None = None
# Horodatage du passage a zero client. None = aucun client n'est parti, donc
# aucune raison d'arreter (un flux lance en API/curl sans navigateur doit vivre).
_GRACE_STARTED: float | None = None
_LOCK = threading.Lock()
_STARTED = False


def _revisions() -> dict:
    """Revisions des donnees (la base est la source de verite) : le client s'en
    sert pour se resynchroniser des qu'elles bougent."""
    try:
        from core import db as _db
        return {"stats_rev": _db.stats_rev(), "profile_rev": _db.profile_rev()}
    except Exception:
        return {"stats_rev": 0, "profile_rev": 0}


def _snapshot(include_queue: bool = True) -> dict:
    """Instantane pousse aux clients : etat de lecture (+ file) + etat du flux."""
    try:
        now = json.loads(playback_state())
    except Exception:
        now = None
    snap = {"type": "snapshot", "now": now,
            "server": {"streaming": bool(state.STREAMING_MODE)},
            "playlists_rev": playlists_rev()}
    snap.update(_revisions())
    if include_queue:
        try:
            snap["queue"] = queue_snapshot()
        except Exception:
            snap["queue"] = None
    return snap


async def _send(ws: WebSocket, payload: dict) -> bool:
    """Envoie un message ; False si le client est mort."""
    try:
        await ws.send_text(json.dumps(payload, ensure_ascii=False))
        return True
    except Exception:
        return False


async def _broadcast(payload: dict):
    """Diffuse a tous les clients, en retirant ceux dont l'envoi echoue."""
    dead = [ws for ws in list(_CLIENTS) if not await _send(ws, payload)]
    for ws in dead:
        _CLIENTS.discard(ws)


def _prepare():
    """Prepare la lecture pour un client qui arrive (dernier titre en pause + file)."""
    try:
        from services.audio import prepare_playback
        _tprint(f"[ws] preparation : {prepare_playback()[:110]}")
    except Exception as exc:
        _tprint(f"[ws] preparation echec : {exc}")


@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    """Connexion temps reel d'un client web (etat pousse ~1x/s)."""
    global _GRACE_STARTED
    await ws.accept()
    _CLIENTS.add(ws)
    if _GRACE_STARTED is not None:
        # Un client est revenu (reload) : on annule la fenetre d'arret.
        _GRACE_STARTED = None
        _tprint("[ws] client revenu, arret annule")
    _tprint(f"[ws] client connecte ({len(_CLIENTS)})")
    # Instantane immediat : l'UI est a jour sans attendre le premier tick.
    await _send(ws, _snapshot())
    # Rien de charge : on prepare le dernier titre (EN PAUSE, effet voulu) et la
    # file, pour que le client puisse reprendre ou passer au suivant sans chercher.
    if not state._now_playing:
        threading.Thread(target=_prepare, daemon=True, name="prepare").start()
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if isinstance(msg, dict) and msg.get("type") == "ping":
                await _send(ws, {"type": "pong"})
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        _CLIENTS.discard(ws)
        if not _CLIENTS:
            _GRACE_STARTED = time.time()
        _tprint(f"[ws] client deconnecte ({len(_CLIENTS)})")


def _realtime_loop():
    """Thread de fond : diffusion de l'etat + arret du flux si plus aucun client."""
    global _GRACE_STARTED
    tick = 0
    while True:
        time.sleep(SNAPSHOT_INTERVAL)
        tick += 1
        if _CLIENTS:
            # Rien a calculer s'il n'y a personne a servir (cout nul sans client).
            if _LOOP is not None:
                try:
                    snap = _snapshot(include_queue=(tick % QUEUE_EVERY == 0))
                    asyncio.run_coroutine_threadsafe(_broadcast(snap), _LOOP)
                except Exception as exc:
                    _tprint(f"[ws] diffusion echec : {exc}")
            continue
        with _LOCK:
            started = _GRACE_STARTED
        if started is None or time.time() - started < CLIENT_GRACE_SECS:
            continue
        if not state.STREAMING_MODE:
            with _LOCK:
                _GRACE_STARTED = None
            continue
        _tprint("[ws] plus aucun client, arret du flux")
        try:
            stop_streaming()
        except Exception as exc:
            _tprint(f"[ws] arret du flux echec : {exc}")
        with _LOCK:
            _GRACE_STARTED = None


def start(loop: asyncio.AbstractEventLoop) -> None:
    """Demarre le thread de diffusion (idempotent). Appele au lifespan."""
    global _LOOP, _STARTED
    if _STARTED:
        return
    _LOOP = loop
    threading.Thread(target=_realtime_loop, daemon=True, name="realtime").start()
    _STARTED = True
    _tprint("[ws] diffusion temps reel demarree")


def clients_count() -> int:
    """Nombre de clients temps reel connectes (observabilite /api/health)."""
    return len(_CLIENTS)
