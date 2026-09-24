"""Manifeste de transfert : erreur non masquée, duree vivante, sans réseau.

Script autonome (meme style que test_preparation.py) : sort en code 1 si un cas
echoue. Le moteur de preparation est stube (aucun worker, aucun acces reseau) :
on verifie comment le manifeste traduit l'etat reel des titres.

Usage: backend/.venv/bin/python backend/tests/test_transfer.py
"""
import os
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))

from services import preparation as prep  # noqa: E402
from services import state, transfer  # noqa: E402

CHECKS = []


def check(name, ok, detail=""):
    CHECKS.append(bool(ok))
    print(f"  {'OK   ' if ok else 'ECHEC'} {name}" + (f"  [{detail}]" if detail else ""))


def cas_relais():
    """Le masque erreur -> pret ne vaut que si une source de relais existe."""
    state.STREAM_CACHE.clear()
    check("aucune source -> pas de relais", transfer._relai_disponible("X") is False, "")
    state.STREAM_CACHE["X"] = {"url": "https://relais", "duration": 42}
    check("source cachee -> relais", transfer._relai_disponible("X") is True, "")
    state.STREAM_CACHE.clear()


def cas_erreur_non_masquee():
    """Preparation en echec : le manifeste dit « erreur », pas une URL morte."""
    video = "ErreurVrai"
    prep.etat = lambda v: "erreur"
    prep.demander = lambda v, meta=None: "erreur"
    prep.chemin = lambda v: None
    prep.taille = lambda v: None
    prep.duree = lambda v: None
    prep._executeur = lambda: None  # jamais appele ici
    state.STREAM_CACHE.clear()

    playlist = {"name": "test", "songs": [{"video_id": video,
                                           "title": "T", "channel": "C"}]}
    titres = transfer._tracks_of(playlist)
    check("un titre attendu", len(titres) == 1, str(len(titres)))
    etat = titres[0]["etat"]
    check("echec annonce, pas masque", etat == "erreur", etat)
    check("pas marque pret", titres[0]["pret"] is False, titres[0]["pret"])

    sortie = {"video_id": video, "titre": "T", "chaine": "C", "album": "test",
              "format": "m4a", "duree": None, "taille": None}
    piste = transfer._piste_en_directe(sortie, "http://h", "http://c", "k")
    check("manifeste en direct : erreur non masquee", piste["etat"] == "erreur",
          piste["etat"])

    state.STREAM_CACHE[video] = {"url": "https://relais", "duration": 42}
    piste = transfer._piste_en_directe(sortie, "http://h", "http://c", "k")
    check("relais present -> servi en webm", piste["etat"] == "pret"
          and piste["format"] == "webm", f"{piste['etat']} {piste['format']}")
    state.STREAM_CACHE.clear()


def cas_duree_vivante():
    """La duree preparee prime sur celle deja connue du titre."""
    video = "DureeVive"
    prep.etat = lambda v: "pret"
    prep.demander = lambda v, meta=None: "pret"
    prep.chemin = lambda v: f"/vide/{video}"
    prep.taille = lambda v: 1000
    prep.duree = lambda v: 197  # ffprobe du bureau
    prep.format_de = lambda v: "m4a"
    prep._executeur = lambda: None
    sortie = {"video_id": video, "titre": "T", "chaine": "C", "album": "test",
              "format": "m4a", "duree": None, "taille": None}
    piste = transfer._piste_en_directe(sortie, "http://h", "http://c", "k")
    check("duree preparee portee au manifeste", piste["duree"] == 197, piste["duree"])
    check("titre pret", piste["etat"] == "pret" and piste["pret"] is True,
          f"{piste['etat']} {piste['pret']}")


def main() -> int:
    print("Manifeste de transfert : erreurs et durees")
    cas_relais()
    cas_erreur_non_masquee()
    cas_duree_vivante()
    total = len(CHECKS)
    reussis = sum(CHECKS)
    print(f"\n{reussis}/{total} cas passent")
    return 0 if reussis == total else 1


if __name__ == "__main__":
    try:
        code = main()
    except Exception as exc:  # ne jamais faire remonter une erreur de test
        print(f"  ECHEC inattendu : {type(exc).__name__}: {exc}")
        code = 1
    finally:
        state.STREAM_CACHE.clear()
    sys.exit(code)