"""NeuroBeats - point d'entree du backend FastAPI.

Monte les routers (recherche, lecture, reco, streaming, playlists, chat, stats)
et gere le cycle de vie (migration, cache, threads mpv/probe/warm-up).
Le moteur est dans services/ ; le CLI de reference dans tests/.

Lancement : python backend/main.py   (port NEUROBEATS_PORT, defaut 8000)
           uvicorn backend.main:app  (depuis la racine)
"""
import asyncio
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
    chat, discover, health, lyrics, playback, playlists, profile, realtime,
    recommendation, search, stats, streaming, transfer,
)
# Alias : `covers` designe deja le service (pochettes HQ) plus bas dans ce module.
from routers import covers as covers_router
from services.audio import (
    _ensure_daemon, _ipc_event_loop, _load_stream_cache, _prefill_queue,
    _shutdown_daemon, _stop_player,
)
from services.db_access import _migrate_json_to_db
from services.embeddings import warm_reco_model
from services.home import warm_home
from services.network import net_probe
from services.recommendation import _cold_start_warmup
from services import covers, llm, models as model_service, state

_bootstrapped = False


def _boot_warmups():
    """Warm-ups de fond, en serie : file de lecture, affinites, reseau.

    En serie volontairement : la file est ce que l'utilisateur voit, elle passe
    donc en premier, et les etapes suivantes ne viennent pas lui prendre son CPU
    et sa bande passante.
    """
    for step in (_prefill_queue, _cold_start_warmup, net_probe):
        try:
            step()
        except Exception as exc:
            print(f"  [boot] warm-up {step.__name__} echoue : {exc}", flush=True)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Initialise le moteur au demarrage et l'arrete proprement a l'extinction."""
    global _bootstrapped
    if not _bootstrapped:
        # Les jobs de modèles sont durables : un worker disparu est mis en
        # pause et ses fragments restent disponibles pour la reprise.
        try:
            model_service.reconcile_download_jobs()
        except Exception as exc:
            print(f"  [boot] registre des modèles illisible : {exc}", flush=True)
        # Le choix IA a une seule forme persistée (`selection`) : on migre
        # l'ancien format, puis on aligne le moteur sur le modèle choisi (le
        # chargement se poursuit en fond, l'UI en affiche la progression).
        try:
            llm.migrate_ai_selection()
            llm.align_engine()
        except Exception as exc:
            print(f"  [boot] choix IA indisponible : {exc}", flush=True)
        _migrate_json_to_db()
        _load_stream_cache()
        # Lecteur singleton : on etablit le daemon mpv immediatement au boot
        # (et on purge les orphelins d'une session precedente) pour qu'aucune
        # lecture ne soit jamais confiee a un process hors du daemon.
        if not _ensure_daemon():
            print("  [boot] avertissement : daemon mpv injoignable au demarrage "
                  "(sera relance a la premiere lecture)", flush=True)
        # Pochettes HQ : reconstruit l'index disque (et purge ce qui est perime)
        # avant que le client ne demande la moindre image.
        covers.warm()
        threading.Thread(target=_ipc_event_loop, daemon=True).start()
        # Modele d'embeddings charge en premier : sans cela, la premiere
        # construction de file (et le warm-up de reco) l'attendait ~10 s.
        threading.Thread(target=warm_reco_model, daemon=True, name="warm-model").start()
        # Warm-ups de fond ENCHAINES : la file de lecture d'abord (elle est
        # visible a l'ecran), le reste ensuite. Lances en parallele, ils se
        # disputaient CPU et reseau, ce qui allongeait nettement la file.
        threading.Thread(target=_boot_warmups, daemon=True, name="boot-warmup").start()
        # Contenu d'accueil (recos + habillage LLM) pret des l'ouverture du client.
        warm_home()
        # Diffusion temps reel + presence client (arret du flux si plus personne).
        realtime.start(asyncio.get_running_loop())
        _bootstrapped = True
    port = os.environ.get("NEUROBEATS_PORT", "8000")
    print(f"[API] NeuroBeats backend prêt sur http://0.0.0.0:{port}", flush=True)
    yield
    try:
        state.STREAMING_MODE = False
        state.STREAMING_SKIP.set()
        _stop_player()
    finally:
        # Le serveur llama est un enfant du backend : le stopper ici couvre
        # aussi les lancements hors Electron et libère sa mémoire.
        try:
            model_service.stop_embedded()
        except Exception as exc:
            print(f"  [shutdown] serveur local : {exc}", flush=True)
        finally:
            # Le groupe de processus Electron tue aussi les workers orphelins
            # apres un SIGKILL ; ce chemin propre laisse leurs fragments et
            # marque les jobs actifs comme paused avant la fermeture.
            try:
                model_service.shutdown_downloads()
            except Exception as exc:
                print(f"  [shutdown] workers de modèles : {exc}", flush=True)
            finally:
                _shutdown_daemon()


app = FastAPI(title="NeuroBeats API", version="1.0", lifespan=lifespan)


def _health_identity_fields() -> dict:
    """Retourne les marqueurs d'instance attendus par le lanceur desktop."""
    raw_port = os.environ.get("NEUROBEATS_PORT", "8000")
    try:
        port = int(raw_port)
    except (TypeError, ValueError):
        port = 0
    return {
        "service": "neurobeats-backend",
        "instance_id": os.environ.get("NEUROBEATS_INSTANCE_ID", ""),
        "profile": os.environ.get("NEUROBEATS_PROFILE", "web"),
        "port": port,
        "runtime_port": port,
    }


@app.get("/api/health", include_in_schema=False)
async def health_with_instance_identity():
    """Étiquette le backend sans supprimer les champs de santé existants.

    La route est déclarée avant l'inclusion du router historique afin de
    conserver son enveloppe et son comportement tout en ajoutant l'identité
    d'instance attendue par le lanceur desktop.
    """
    payload = await health.health()
    data = dict(payload.get("data") or {})
    data.update(_health_identity_fields())
    return {"status": payload.get("status", "ok"), "data": data,
            "error": payload.get("error")}


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)

for _router in (health, search, playback, recommendation, streaming,
                playlists, discover, profile, chat, stats, realtime,
                covers_router, transfer, lyrics):
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
