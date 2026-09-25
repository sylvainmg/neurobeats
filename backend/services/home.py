"""Contenu de la page d'accueil : recommandations + habillage redige par le LLM.

Le moteur met du temps a produire des recommandations (RAG + Markov + ytsearch :
20-60s) et un appel LLM ajoute quelques secondes. Pour ne jamais faire attendre
le client, tout est calcule **en arriere-plan** et servi depuis un cache RAM :
une requete repond toujours immediatement, et un rafraichissement se declenche
quand le cache est vide ou perime.

Le LLM ne choisit pas les titres (c'est le moteur de reco) : il redige le titre
de section et la phrase d'accroche a partir de la selection. Si Ollama est
indisponible, un texte neutre prend le relais (la page reste utile).
"""
import json
import threading
import time

from services import covers
from services.db_access import hist_read, recent_genre
from services.editorial import FALLBACK_INTRO, FALLBACK_TITLE, llm_copy
from services.genres import COLD_START_GENRES
from services.recommendation import get_recommendation
from services.state import _tprint

HOME_TTL = 900  # 15 min : une selection d'accueil ne bouge pas vite

# Amorce de premier lancement : sans historique ni note, l'accueil n'a aucun
# signal. On interroge le moteur avec un genre large (contexte explicite) et on
# garde le premier qui rend des titres — plutot que de laisser la page vide.
COLD_START_TITLE = "À découvrir"
COLD_START_INTRO = ("Une sélection pour démarrer : lance un titre, l'IA affinera "
                    "au fil de tes écoutes.")

_LOCK = threading.Lock()
_CACHE: dict = {}
_BUILDING = False


def _resume_track() -> dict | None:
    """Dernier titre ecoute, pour le bloc « Reprendre l'écoute »."""
    last = hist_read(1)
    if not last:
        return None
    row = last[0]
    if not row.get("video_id"):
        return None
    return {
        "video_id": row.get("video_id", ""),
        "title": row.get("title", ""),
        "channel": row.get("channel", ""),
        "genre": row.get("genre", ""),
    }


def _gather(genre: str, want: int = 4) -> list:
    """Recolte des titres pour l'accueil : filtre genre dur, puis elargi.

    Une seule passe peut ne renvoyer qu'un titre (le vivier d'un genre est
    irregulier). On complete avec une seconde passe sans filtre dur, meme theme,
    et on deduplique — l'accueil a ainsi une selection presentable.
    """
    picked, seen = [], set()

    def absorb(query: str, hard: bool):
        try:
            data = json.loads(get_recommendation(query, force_genre_filter=hard))
        except Exception as exc:
            _tprint(f"[home] reco echec ({query!r}, hard={hard}) : {exc}")
            return
        if not isinstance(data, dict):
            return
        for track in data.get("recommendations", []) or []:
            video_id = track.get("video_id")
            if not video_id or video_id in seen:
                continue
            seen.add(video_id)
            picked.append(track)

    absorb(genre, bool(genre))
    if len(picked) < want and genre:
        absorb(genre, False)
    return picked[:want]


def _cold_start_tracks(want: int = 4) -> tuple[list, str]:
    """Selection de premier lancement (aucun historique, aucun signal).

    Le moteur de reco refuse de tourner sans contexte : on lui en donne un
    explicite (genre large) et on garde le premier genre qui rend des titres.
    """
    for genre in COLD_START_GENRES:
        try:
            data = json.loads(get_recommendation(genre, force_genre_filter=True))
        except Exception as exc:
            _tprint(f"[home] amorce {genre!r} echec : {exc}")
            continue
        picked, seen = [], set()
        for track in (data.get("recommendations") if isinstance(data, dict) else None) or []:
            video_id = track.get("video_id")
            if not video_id or video_id in seen:
                continue
            seen.add(video_id)
            picked.append(track)
            if len(picked) >= want:
                break
        if picked:
            _tprint(f"[home] amorce premier lancement : {len(picked)} titres ({genre})")
            return picked, genre
    return [], ""


def _build():
    """Construit le contenu d'accueil (recos + habillage) et remplace le cache."""
    global _CACHE, _BUILDING
    try:
        resume = _resume_track()
        # Semer sur le genre recent (pas sur le titre exact) : selection
        # pertinente + filtrage qualite du moteur de reco.
        genre = recent_genre()
        cold = not resume and not genre
        recos = [] if cold else _gather(genre)
        if cold:
            recos, genre = _cold_start_tracks()
        if recos:
            headline, intro = llm_copy(recos, genre)
        elif cold:
            headline, intro = COLD_START_TITLE, COLD_START_INTRO
        else:
            headline, intro = FALLBACK_TITLE, FALLBACK_INTRO
        payload = {
            # La construction a abouti : le client quitte les squelettes meme si
            # la selection est vide (il affiche alors une invite a demarrer).
            "ready": True,
            "headline": headline,
            "intro": intro,
            "genre": genre,
            "resume": resume,
            "tracks": [
                {"video_id": t.get("video_id", ""), "title": t.get("title", ""),
                 "channel": t.get("channel", ""), "genre": t.get("genre", "")}
                for t in recos
            ],
            "generated_at": int(time.time()),
        }
        with _LOCK:
            _CACHE = payload
        _tprint(f"[home] contenu pret : {len(payload['tracks'])} titres, "
                f"resume={bool(resume)}")
        _warm_covers(payload)
    except Exception as exc:
        _tprint(f"[home] construction echec : {exc}")
    finally:
        with _LOCK:
            _BUILDING = False


def _warm_covers(payload: dict):
    """Prepare les pochettes HQ des titres affiches (tache de fond, non bloquant).

    Lance pendant la construction, pas a l'affichage : le client repolle jusqu'a
    `ready`, les images sont donc le plus souvent deja pretes quand l'accueil
    apparait — sinon la vignette YouTube fait l'affaire en attendant.
    """
    for track in [payload.get("resume"), *(payload.get("tracks") or [])]:
        video_id = (track or {}).get("video_id")
        if video_id:
            covers.ensure_async(video_id, track.get("title", ""),
                                track.get("channel", ""))


def _ensure_fresh(force: bool = False):
    """Lance une construction en fond si le cache est vide ou perime."""
    global _BUILDING
    with _LOCK:
        age = time.time() - _CACHE.get("generated_at", 0) if _CACHE else None
        fresh = age is not None and age < HOME_TTL
        if _BUILDING or (fresh and not force):
            return
        _BUILDING = True
    threading.Thread(target=_build, daemon=True, name="home").start()


def get_home() -> str:
    """Contenu d'accueil depuis le cache ; programme un rafraichissement si besoin.

    Ne bloque jamais : ni la reco ni le LLM ne sont attendus ici. Tant que le
    contenu n'est pas pret, `ready` est False et le client repasse plus tard.
    """
    _ensure_fresh()
    with _LOCK:
        payload = dict(_CACHE) if _CACHE else {
            "ready": False, "headline": "", "intro": "",
            "genre": "", "resume": None, "tracks": [],
        }
        payload["building"] = _BUILDING
    return json.dumps(payload, ensure_ascii=False)


def warm_home():
    """Pre-chauffe le contenu d'accueil (appele au demarrage du serveur)."""
    _ensure_fresh()
