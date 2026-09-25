"""Accueil : amorcage du premier lancement (profil vierge).

Aucun test n'atteint le reseau : le moteur de reco de l'accueil est remplace par
un double, et la base vise un repertoire temporaire. Le script suit le style
autonome des autres tests du backend (code non nul si une verification echoue).

Usage: backend/.venv/bin/python backend/tests/test_home_cold_start.py
"""
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
_TEMP_DATA = tempfile.mkdtemp(prefix="neurobeats-home-")

# Doit preceder l'import : core.config fige DATA_ROOT a la lecture.
os.environ["NEUROBEATS_DATA_DIR"] = _TEMP_DATA
os.environ["NEUROBEATS_PROFILE"] = "hometest"

if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))

from services import home  # noqa: E402
from services import recommendation  # noqa: E402

CHECKS = []
_OLD_RECO = home.get_recommendation


def check(name: str, condition: bool, detail: str = "") -> None:
    CHECKS.append(bool(condition))
    suffix = f"  [{detail}]" if detail else ""
    print(f"  {'OK   ' if condition else 'ECHEC'} {name}{suffix}")


def _stub(payloads: dict):
    """Double du moteur : repond par requete, sinon un resultat vide."""
    def fake_reco(query: str = "", force_genre_filter: bool = False, count: int = 3) -> str:
        del force_genre_filter, count
        return json.dumps(payloads.get(query, {"error": "rien"}))
    return fake_reco


def _track(video_id: str, genre: str = "pop us") -> dict:
    return {"video_id": video_id, "title": f"Titre {video_id}",
            "channel": f"Chaine {video_id}", "genre": genre}


def cas_amorce_genre():
    """L'amorce prend le premier genre de la liste qui rend des titres."""
    home.get_recommendation = _stub({
        "rap fr": {"recommendations": [_track("a", "rap fr")]},
    })
    tracks, genre = home._cold_start_tracks(4)
    check("amorce : premier genre non vide retenu",
          genre == "rap fr" and len(tracks) == 1, f"{genre} {tracks}")
    check("amorce : genre cherche dans l'ordre des amorces",
          home.COLD_START_GENRES[0] != "rap fr", str(home.COLD_START_GENRES[:2]))


def cas_amorce_vide():
    """Sans aucun titre, l'amorce ne fabrique rien."""
    home.get_recommendation = _stub({})
    tracks, genre = home._cold_start_tracks(4)
    check("amorce : rien trouve -> aucun titre", tracks == [] and genre == "", str(tracks))


def cas_build_premier_lancement():
    """Profil vierge : l'accueil aboutit (ready) et propose des titres."""
    home.get_recommendation = _stub({
        "pop us": {"recommendations": [_track("v1"), _track("v2")]},
    })
    home._CACHE = {}
    home._build()
    cached = home._CACHE
    check("accueil vierge : ready vrai", cached.get("ready") is True, str(cached.get("ready")))
    check("accueil vierge : titres d'amorce", len(cached.get("tracks") or []) == 2,
          str(len(cached.get("tracks") or [])))
    check("accueil vierge : genre renseigne", cached.get("genre") == "pop us",
          str(cached.get("genre")))


def cas_build_vide_reste_ready():
    """Aucun titre disponible : l'accueil reste pret (pas de squelettes infinis)."""
    home.get_recommendation = _stub({})
    home._CACHE = {}
    home._build()
    cached = home._CACHE
    check("accueil vide : ready vrai", cached.get("ready") is True, str(cached.get("ready")))
    check("accueil vide : invite de demarrage",
          cached.get("headline") == home.COLD_START_TITLE, str(cached.get("headline")))
    check("accueil vide : aucun titre fabrique", (cached.get("tracks") or []) == [])


def cas_garde_fou_reco():
    """Le moteur refuse de tourner sans contexte ni signal d'ecoute."""
    out = json.loads(recommendation.get_recommendation(""))
    check("reco : sans contexte -> erreur explicite",
          "Aucun historique" in (out.get("error") or ""), str(out.get("error"))[:60])


def main() -> int:
    try:
        print("cas 1 : amorce du premier lancement")
        cas_amorce_genre()
        cas_amorce_vide()
        print("cas 2 : l'accueil aboutit sur un profil vierge")
        cas_build_premier_lancement()
        cas_build_vide_reste_ready()
        print("cas 3 : garde-fou du moteur de reco")
        cas_garde_fou_reco()
    finally:
        home.get_recommendation = _OLD_RECO
        shutil.rmtree(_TEMP_DATA, ignore_errors=True)
    ok_count = sum(CHECKS)
    print(f"\n{ok_count}/{len(CHECKS)} verifications OK")
    return 0 if ok_count == len(CHECKS) else 1


if __name__ == "__main__":
    sys.exit(main())
