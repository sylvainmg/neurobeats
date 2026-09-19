"""NeuroBeats - point d'entree du backend FastAPI.

Monte les routers (recherche, lecture, reco, streaming, playlists, chat, stats)
et gere le cycle de vie (migration, cache, threads mpv/probe/warm-up).
Le moteur est dans services/ ; le CLI de reference dans tests/.

Lancement : python backend/main.py   (port NEUROBEATS_PORT, defaut 8000)
           uvicorn backend.main:app  (depuis la racine)
"""
import os
import sys
import threading
from contextlib import asynccontextmanager

# Rendre backend/ importable (core.*, services.*, routers.*) quel que soit le cwd.
HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from routers import (
    chat, health, playback, playlists, recommendation, search, stats, streaming,
)
from services.audio import (
    _ipc_event_loop, _load_stream_cache, _shutdown_daemon, _stop_player,
)
from services.db_access import _migrate_json_to_db
from services.network import net_probe
from services.recommendation import _cold_start_warmup
from services import state

_bootstrapped = False


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Initialise le moteur au demarrage et l'arrete proprement a l'extinction."""
    global _bootstrapped
    if not _bootstrapped:
        _migrate_json_to_db()
        _load_stream_cache()
        threading.Thread(target=_ipc_event_loop, daemon=True).start()
        threading.Thread(target=net_probe, daemon=True).start()
        threading.Thread(target=_cold_start_warmup, daemon=True).start()
        _bootstrapped = True
    port = os.environ.get("NEUROBEATS_PORT", "8000")
    print(f"[API] NeuroBeats backend prêt sur http://0.0.0.0:{port}", flush=True)
    yield
    state.STREAMING_MODE = False
    state.STREAMING_SKIP.set()
    _stop_player()
    _shutdown_daemon()


app = FastAPI(title="NeuroBeats API", version="1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)

for _router in (health, search, playback, recommendation, streaming,
                playlists, chat, stats):
    app.include_router(_router.router)


@app.exception_handler(Exception)
async def unhandled(_request: Request, exc: Exception):
    """Renvoie une erreur 500 normalisee au format de l'API."""
    return JSONResponse(status_code=500, content={
        "status": "error", "error": f"{type(exc).__name__}: {exc}", "data": None})


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("NEUROBEATS_PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port, reload=False)
