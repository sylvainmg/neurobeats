"""Preparation des titres : tags, pochette jointe, et surtout aucun reencodage.

Script autonome (meme style que test_covers.py) : sort en code 1 si un cas echoue.

Aucun acces reseau : la source est fabriquee par ffmpeg (une sinusoide de 2 s) et
la pochette aussi. Le cache de preparation est redirige vers un dossier temporaire,
donc la bibliotheque reelle n'est jamais touchee.

Usage: backend/.venv/bin/python backend/tests/test_preparation.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))

TMP = tempfile.mkdtemp(prefix="neurobeats-preparation-")
os.environ["NEUROBEATS_PREPARED_DIR"] = TMP  # avant l'import : le module lit l'env

from core.config import FFMPEG  # noqa: E402
from services import preparation as prep  # noqa: E402

CHECKS = []


def check(name, ok, detail=""):
    CHECKS.append(bool(ok))
    print(f"  {'OK   ' if ok else 'ECHEC'} {name}" + (f"  [{detail}]" if detail else ""))


def ffprobe(chemin: str) -> dict:
    sonde = os.path.join(os.path.dirname(FFMPEG), "ffprobe")
    if not os.path.exists(sonde):
        sonde = shutil.which("ffprobe") or ""
    sortie = subprocess.run(
        [sonde, "-v", "error", "-show_format", "-show_streams", "-of", "json", chemin],
        capture_output=True, text=True, timeout=60)
    return json.loads(sortie.stdout or "{}")


def piste(info: dict, type_piste: str, attachee=False) -> dict:
    for flux in info.get("streams", []):
        if flux.get("codec_type") != type_piste:
            continue
        if attachee and (flux.get("disposition") or {}).get("attached_pic") != 1:
            continue
        return flux
    return {}


def fixture_source() -> str:
    """Sinusoide AAC de 2 s : le cas favorable (donc celui qu'on etiquette)."""
    chemin = os.path.join(TMP, "fixture-source.m4a")
    subprocess.run(
        [FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
         "-c:a", "aac", "-b:a", "96k", chemin],
        capture_output=True, timeout=120)
    return chemin


def fixture_webm() -> str:
    """Opus dans un webm : le cas defavorable, qui doit rester intact."""
    chemin = os.path.join(TMP, "fixture-source.webm")
    subprocess.run(
        [FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
         "-c:a", "libopus", "-b:a", "64k", chemin],
        capture_output=True, timeout=120)
    return chemin


def fixture_pochette() -> bytes:
    chemin = os.path.join(TMP, "fixture-pochette.jpg")
    subprocess.run(
        [FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", "color=c=0x0066FF:s=300x300", "-frames:v", "1", chemin],
        capture_output=True, timeout=120)
    try:
        with open(chemin, "rb") as handle:
            return handle.read()
    except OSError:
        return b""


META = {"titre": "Titre de test", "chaine": "Chaine de test",
        "album": "Album de test", "annee": "2026"}


def cas_nominal(source: str, pochette: bytes):
    """Un titre AAC prepare : etiquete, pochette jointe, audio copie."""
    reference = piste(ffprobe(source), "audio")
    resultat = prep.remuxer(source, "TestVideo01", META, pochette)
    check("remuxage reussi", resultat.get("ok"), resultat.get("erreur", ""))
    if not resultat.get("ok"):
        return None
    sortie = resultat["chemin"]
    check("sortie en .m4a", sortie.endswith(".m4a"), os.path.basename(sortie))
    info = ffprobe(sortie)
    audio = piste(info, "audio")
    check("codec audio conserve", audio.get("codec_name") == reference.get("codec_name"),
          f"{reference.get('codec_name')} -> {audio.get('codec_name')}")

    def seconde(valeur):
        try:
            return float(valeur)
        except (TypeError, ValueError):
            return -1.0

    duree_source = seconde(reference.get("duration"))
    duree_sortie = seconde(audio.get("duration"))
    check("duree inchangee", abs(duree_source - duree_sortie) < 0.05,
          f"{duree_source} s -> {duree_sortie} s")
    check("debit inchange (donc pas de reencodage)",
          reference.get("bit_rate") == audio.get("bit_rate"),
          f"{reference.get('bit_rate')} -> {audio.get('bit_rate')}")

    tags = (info.get("format") or {}).get("tags") or {}
    tags = {cle.lower(): valeur for cle, valeur in tags.items()}
    check("titre ecrit", tags.get("title") == META["titre"], tags.get("title", ""))
    check("artiste ecrit", tags.get("artist") == META["chaine"], tags.get("artist", ""))
    check("album ecrit", tags.get("album") == META["album"], tags.get("album", ""))
    check("annee ecrite", tags.get("date") == META["annee"], tags.get("date", ""))

    image = piste(info, "video", attachee=True)
    check("pochette jointe", bool(image), image.get("codec_name", ""))
    check("taille rapportee", resultat.get("taille") == os.path.getsize(sortie),
          f"{resultat.get('taille')} octets")
    return resultat


def cas_sans_pochette(source: str):
    """Sans pochette disponible, on etiquete quand meme, sans piste image."""
    resultat = prep.remuxer(source, "TestVideo02", META, None)
    check("remuxage sans pochette", resultat.get("ok"), resultat.get("erreur", ""))
    if not resultat.get("ok"):
        return
    info = ffprobe(resultat["chemin"])
    check("aucune piste image", not piste(info, "video"), "")
    tags = {cle.lower(): valeur
            for cle, valeur in ((info.get("format") or {}).get("tags") or {}).items()}
    check("titre ecrit malgre tout", tags.get("title") == META["titre"], "")


def cas_source_introuvable():
    resultat = prep.remuxer(os.path.join(TMP, "absent.m4a"), "TestVideo03", META, None)
    check("source absente : echec propre",
          resultat.get("ok") is False and bool(resultat.get("erreur")),
          resultat.get("erreur", ""))


def cas_flux_non_aac(source_webm: str):
    """Un flux non-AAC est copie tel quel : aucun reencodage, aucune perte."""
    if not os.path.exists(source_webm) or os.path.getsize(source_webm) == 0:
        print("  SKIP  flux non-AAC (libopus indisponible dans ce ffmpeg)")
        return
    resultat = prep.remuxer(source_webm, "TestVideo04", META, None)
    check("flux non-AAC conserve", resultat.get("ok"), resultat.get("erreur", ""))
    if not resultat.get("ok"):
        return
    check("format declare opus", resultat.get("format") == "opus", resultat.get("format", ""))
    with open(source_webm, "rb") as handle:
        avant = handle.read()
    with open(resultat["chemin"], "rb") as handle:
        apres = handle.read()
    check("octets identiques (copie, pas de reencodage)", avant == apres,
          f"{len(avant)} -> {len(apres)} octets")


def cas_etats():
    """Les etats exposes au manifeste : absent, puis pret avec sa taille."""
    check("etat initial", prep.etat("TestVideo01") == "absent", prep.etat("TestVideo01"))
    resultat = prep.remuxer(os.path.join(TMP, "fixture-source.m4a"), "TestVideo01",
                            META, None)
    if not resultat.get("ok"):
        check("preparation pour l'etat", False, resultat.get("erreur", ""))
        return
    prep._ecrire_sidecar("TestVideo01", resultat)
    check("etat pret", prep.etat("TestVideo01") == "pret", prep.etat("TestVideo01"))
    check("taille disponible", prep.taille("TestVideo01") == resultat["taille"], "")
    check("chemin servi", bool(prep.chemin("TestVideo01")), "")
    check("stats coherentes", prep.stats()["octets"] >= resultat["taille"],
          str(prep.stats()["octets"]))
    check("oubli effectif", prep.oublier("TestVideo01") and prep.etat("TestVideo01") == "absent",
          "")


def cas_duree():
    """La duree du titre prepare est lue (ffprobe) puis portee par le sidecar."""
    if not os.path.exists(os.path.join(TMP, "fixture-source.m4a")):
        print("  SKIP  duree (fixture absente)")
        return
    resultat = prep.remuxer(os.path.join(TMP, "fixture-source.m4a"), "TestVideo05",
                            META, None)
    if not resultat.get("ok"):
        check("preparation pour la duree", False, resultat.get("erreur", ""))
        return
    duree = prep._duree_fichier(resultat["chemin"])
    check("duree lue par ffprobe", isinstance(duree, int) and duree > 0, duree)
    prep._ecrire_sidecar("TestVideo05", {**resultat, "duree": duree})
    check("duree servie au manifeste", prep.duree("TestVideo05") == duree,
          prep.duree("TestVideo05"))
    check("duree sans preparation", prep.duree("JamaisPrepare") is None, "")
    check("oubli de la duree", prep.oublier("TestVideo05") and prep.duree("TestVideo05") is None,
          "")


def cas_echecs_plafonnes():
    """Une source morte ne se relance pas en boucle (cap ECHECS_MAX)."""
    video = "TestEchecX"
    with prep._lock:
        prep._echecs[video] = (time.time() - 1, "source morte", prep.ECHECS_MAX)
    check("cap atteint -> erreur, sans relance",
          prep.demander(video) == "erreur" and video not in prep._en_cours,
          prep.demander(video))
    check("attente reste en erreur", prep.attente(video, 0.05) == "erreur", "")
    with prep._lock:
        prep._echecs[video] = (time.time() - 1, "source morte", prep.ECHECS_MAX - 1)
    submis = []

    class FauxPool:
        def submit(self, fonction, *args, **kwargs):
            submis.append(args)
            return None

    ancien_executeur, prep._executeur = prep._executeur, lambda: FauxPool()
    try:
        res = prep.demander(video)
    finally:
        prep._executeur = ancien_executeur
        with prep._lock:
            prep._en_cours.pop(video, None)
            prep._echecs.pop(video, None)
    check("re-tentative autorisee sous le cap", res == "preparation", res)
    check("compte d'essai porte au worker",
          len(submis) == 1 and submis[0][2] == prep.ECHECS_MAX - 1, str(submis))


def main() -> int:
    print("Preparation des titres pour le transfert")
    if not FFMPEG:
        print("  SKIP  ffmpeg introuvable : rien a tester")
        return 0
    source = fixture_source()
    if not os.path.exists(source):
        print("  ECHEC fixture audio non fabriquee (ffmpeg)")
        return 1
    print(f"  dossier de cache : {TMP}")

    cas_nominal(source, fixture_pochette())
    cas_sans_pochette(source)
    cas_source_introuvable()
    cas_flux_non_aac(fixture_webm())
    cas_etats()
    cas_duree()
    cas_echecs_plafonnes()

    total = len(CHECKS)
    reussis = sum(CHECKS)
    print(f"\n{reussis}/{total} cas passent")
    return 0 if reussis == total else 1


if __name__ == "__main__":
    try:
        code = main()
    finally:
        shutil.rmtree(TMP, ignore_errors=True)
    sys.exit(code)
