"""Pochettes HQ : generation, cache, eviction et contrat d'identite.

Script autonome (meme style que test_queue_skip.py) : il sort en code 1 si un cas
echoue. Le cache et la base sont rediriges vers un dossier temporaire, donc la
bibliotheque de pochettes reelle n'est jamais touchee.

Les cas qui ont besoin du reseau (yt-dlp, Deezer, YouTube) sont signales **SKIP**
s'ils echouent : tout le reste doit passer hors ligne.

Usage: backend/.venv/bin/python backend/tests/test_covers.py
"""
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

from core import config
from core import db as engine_db
from services import coverart, covers, frame

CHECKS = []
SKIPPED = []

# Video sans vignette HD chez YouTube (maxresdefault et hq720 -> 404, l'og:image
# publie est hqdefault) : c'est le cas qui justifie tout le mecanisme.
NO_HD_VIDEO = "X-Z9GsLsksQ"
HD_VIDEO = "6swmTBVI83k"


def check(name, ok, detail=""):
    CHECKS.append(bool(ok))
    print(f"  {'OK   ' if ok else 'ECHEC'} {name}" + (f"  [{detail}]" if detail else ""))


def skip(name, why=""):
    SKIPPED.append(name)
    print(f"  SKIP  {name}" + (f"  [{why}]" if why else ""))


def top_luma(path):
    """Luminosite moyenne de la bande superieure d'une image (0 = noir)."""
    probe = shutil.which("ffprobe")
    if not probe:
        return -1.0
    res = subprocess.run(
        [probe, "-v", "error", "-f", "lavfi",
         "-i", f"movie={path},crop=iw:ih/10:0:0,signalstats",
         "-show_entries", "frame_tags=lavfi.signalstats.YAVG", "-of", "csv=p=0"],
        capture_output=True, text=True)
    try:
        return float(res.stdout.strip().splitlines()[0])
    except (ValueError, IndexError):
        return -1.0


# --- Bac a sable : ni la base ni les pochettes reelles ne sont touchees -------
SANDBOX = tempfile.mkdtemp(prefix="covers-test-")
engine_db.DB_PATH = os.path.join(SANDBOX, "test.db")
engine_db.db_init()
covers.COVERS_DIR = os.path.join(SANDBOX, "covers")
covers.warm()

print("\n[1] Rapprochement d'album : normalisation et seuil")
check("les mentions YouTube sont retirees",
      coverart._normalize("Lil Nas X - MONTERO (Official Video)") == "lil nas x montero",
      coverart._normalize("Lil Nas X - MONTERO (Official Video)"))
check("artiste deduit du libelle",
      coverart._split_artist("Lomepal - Evidemment (lyrics video)", "Lomepal")[0] == "Lomepal")
check("artiste deduit de la chaine sans separateur",
      coverart._split_artist("Evidemment", "Lomepal") == ("Lomepal", "Evidemment"))
good = coverart._score("Lil Nas X", "MONTERO (Call Me By Your Name)", 137,
                       {"title": "MONTERO (Call Me By Your Name)",
                        "artist": "Lil Nas X", "duration": 138})
wrong = coverart._score("Lil Nas X", "MONTERO (Call Me By Your Name)", 137,
                        {"title": "Another Love", "artist": "Tom Odell", "duration": 250})
check("un bon candidat depasse le seuil", good >= config.COVERS_MATCH_MIN, f"{good:.2f}")
check("un mauvais candidat est rejete", wrong < config.COVERS_MATCH_MIN, f"{wrong:.2f}")
check("une duree incoherente fait chuter le score",
      coverart._score("Lil Nas X", "MONTERO", 137,
                      {"title": "MONTERO", "artist": "Lil Nas X",
                       "duration": 420}) < good)

print("\n[2] Choix de la vignette publiee")
# Les dimensions sont absentes chez yt-dlp : le tri doit se faire sur les noms.
urls = covers._thumb_urls({"thumbnails": [
    {"url": "https://x/scene-mq1.jpg", "width": None, "height": None},
    {"url": "https://x/sddefault.jpg", "width": None, "height": None},
    {"url": "https://x/maxresdefault.jpg", "width": None, "height": None},
    {"url": "https://x/hq720.jpg", "width": None, "height": None},
    {"url": "https://x/scene2.jpg", "width": 160, "height": 120},
]}, "abcdefghijk")
check("les plans de storyboard sont ecartes",
      all("scene" not in url for url in urls), str(urls))
check("les vignettes publiees sont classees de la meilleure a la moins bonne",
      urls[:3] == ["https://x/maxresdefault.jpg", "https://x/hq720.jpg",
                   "https://x/sddefault.jpg"], str(urls[:3]))
check("l'echelle du client complete derriere",
      urls[3:] == [f"https://i.ytimg.com/vi/abcdefghijk/{quality}.jpg"
                   for quality in covers._THUMB_QUALITIES], str(urls[3:]))

print("\n[3] Recadrage carre d'une vignette letterboxee (sans reseau)")
if not frame.available():
    skip("recadrage carre", "ffmpeg absent")
else:
    letterboxed = os.path.join(SANDBOX, "letterboxed.png")
    subprocess.run([config.FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
                    "-f", "lavfi", "-i", "color=c=red:s=640x360", "-frames:v", "1",
                    "-vf", "pad=640:480:0:60:black", letterboxed], check=True)
    squared = os.path.join(SANDBOX, "squared.webp")
    check("le webp carre est produit",
          frame.square_webp(letterboxed, squared, 512, letterbox=True)
          and os.path.exists(squared))
    dimensions = frame.size(squared)
    check("il est carre", bool(dimensions) and dimensions[0] == dimensions[1], str(dimensions))
    check("il n'est pas agrandi au-dela du contenu source",
          bool(dimensions) and dimensions[0] <= 360, str(dimensions))
    check("les bandes noires ont disparu", top_luma(squared) > 40,
          f"YAVG haut={top_luma(squared):.0f}")

print("\n[3b] Garde-fou d'identite du palier frame (SSIM)")
if not frame.available():
    skip("comparaison de frames", "ffmpeg absent")
else:
    stream = frame.video_url(HD_VIDEO)
    duration = frame.metadata(HD_VIDEO).get("duration") or 0
    if not stream or duration < 60:
        skip("comparaison de frames", "flux video ou duree indisponible")
    else:
        moment = duration * 0.3
        same_a = os.path.join(SANDBOX, "same-a.png")
        same_b = os.path.join(SANDBOX, "same-b.png")
        elsewhere = os.path.join(SANDBOX, "elsewhere.png")
        if not (frame.grab(stream, moment, same_a, 160)
                and frame.grab(stream, moment, same_b, 160)
                and frame.grab(stream, duration * 0.9, elsewhere, 160)):
            skip("comparaison de frames", "extraction impossible")
        else:
            identical = frame.ssim(same_a, same_b)
            other = frame.ssim(same_a, elsewhere)
            check("deux extractions du meme instant sont reconnues identiques",
                  identical is not None and identical >= 0.95, str(identical))
            check("un autre moment passe sous le seuil d'identite",
                  other is not None and other < config.COVERS_SSIM_MIN,
                  f"meme instant={identical} autre={other}")

print("\n[4] Generation reelle d'une video sans vignette HD")
provenance = {}
try:
    provenance = covers._generate(NO_HD_VIDEO, "DREAMBOY", "Lil Nas X", None)
except Exception as exc:
    print(f"  (erreur reseau : {type(exc).__name__}: {exc})")
if not provenance:
    skip("generation reelle", "reseau, yt-dlp ou source indisponible")
else:
    path = covers._path(NO_HD_VIDEO)
    dimensions = frame.size(path)
    check("une pochette est ecrite", os.path.exists(path), path)
    check("elle est carree", bool(dimensions) and dimensions[0] == dimensions[1],
          str(dimensions))
    # Barre = le meilleur contenu 16/9 exploitable pour cette video (sddefault
    # 640x360) : en dessous, c'est qu'on est retombe sur du 320x180.
    check("elle vaut au moins le meilleur contenu publie (360 lignes)",
          bool(dimensions) and dimensions[0] >= 360, str(dimensions))
    check("la provenance est renseignee",
          provenance.get("source") in ("album", "frame", "thumb"), str(provenance))
    if provenance.get("source") == "frame":
        check("l'instant retenu ressemble a la vignette officielle",
              (provenance.get("match_score") or 0) >= config.COVERS_SSIM_MIN,
              f"SSIM={provenance.get('match_score'):.2f} @ {provenance.get('offset'):.0f}s")

print("\n[5] Cache : generation en fond, idempotence, lecture")
started = covers.ensure_async(HD_VIDEO, "Lil Nas X - MONTERO", "Lil Nas X")
if not started:
    skip("cache", "generation non lancee (reseau ou deja en cache)")
else:
    check("une generation est lancee", started)
    check("la generation est signalee en cours", covers.generating(HD_VIDEO))
    check("un second appel ne relance rien", covers.ensure_async(HD_VIDEO) is False)
    data = covers.wait_read(HD_VIDEO, 90)
    if not data:
        skip("lecture de la pochette", "generation non aboutie")
    else:
        check("la pochette est servie", data[:4] == b"RIFF" and data[8:12] == b"WEBP",
              str(data[:12]))
        check("elle est marquee en cache", covers.has(HD_VIDEO))
        check("une pochette en cache n'est pas regeneree",
              covers.ensure_async(HD_VIDEO) is False)
        again = covers.read(HD_VIDEO)
        check("la relecture est identique", again == data)

print("\n[6] Video sans source exploitable : cache negatif")
missing = "aaaaaaaaaaa"
covers.ensure_async(missing, "Inexistant", "Inexistant")
check("aucune pochette produite", covers.wait_read(missing, 90) is None)
check("l'echec est enregistre", covers._recently_failed(missing))
check("il n'est pas retente aussitot", covers.ensure_async(missing) is False)
check("aucun fichier n'est laisse", not os.path.exists(covers._path(missing)))

print("\n[7] Eviction : le budget disque est respecte")
BUDGET_DIR = tempfile.mkdtemp(prefix="covers-budget-")
covers.COVERS_DIR = BUDGET_DIR
covers.COVERS_BUDGET_MB = 1
now = time.time()
for index in range(6):
    path = os.path.join(covers.COVERS_DIR, f"fake{index}.webp")
    with open(path, "wb") as handle:
        handle.write(b"x" * (200 * 1024))
    # Ordre LRU deterministe, et recent : sinon le TTL les emporte tous.
    os.utime(path, (now - (6 - index), now - (6 - index)))
covers.warm()
remaining = sorted(name[:-5] for name in os.listdir(covers.COVERS_DIR))
check("le budget n'est pas depasse",
      covers.stats()["bytes"] <= covers.COVERS_BUDGET_MB * 1024 * 1024,
      f"{covers.stats()['bytes']} octets")
check("le plus ancien est parti en premier", "fake0" not in remaining, str(remaining))
check("le plus recent est conserve", "fake5" in remaining, str(remaining))

print("\n[8] Purge : tout part")
before = covers.stats()["tracks"]
check("des pochettes etaient presentes", before > 0, str(before))
covers.clear()
check("l'index est vide", covers.stats()["tracks"] == 0)
check("les fichiers sont supprimes",
      not [name for name in os.listdir(covers.COVERS_DIR) if name.endswith(".webp")],
      str(os.listdir(covers.COVERS_DIR)))

shutil.rmtree(SANDBOX, ignore_errors=True)
shutil.rmtree(BUDGET_DIR, ignore_errors=True)

failures = CHECKS.count(False)
print(f"\n{len(CHECKS) - failures}/{len(CHECKS)} cas OK"
      + (f", {len(SKIPPED)} ignore(s) : {', '.join(SKIPPED)}" if SKIPPED else ""))
sys.exit(1 if failures else 0)
