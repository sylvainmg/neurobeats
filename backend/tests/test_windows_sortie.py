"""La sortie du backend doit tolerer un titre que la console Windows ne sait pas ecrire.

Contexte observe sur Windows (captures de l'utilisateur, 2026-09-27) :

    InStreamEncoderError: 'charmap' codec can't encode character '\\u25b6'
    UnicodeEncodeError: 'charmap' codec can't encode character '\\u23f1'

Windows encode la sortie du processus avec la page de code de la console —
cp1252 sur un poste francais. Or le backend imprime des titres venus de YouTube,
et un caractere hors cp1252 y suffit : emoji, triangle de lecture, tiret cadratin.

La ligne fautive etait celle qui confirme une lecture, et elle s'execute APRES
que mpv joue et AVANT l'ecriture de l'historique. Un `UnicodeEncodeError` a cet
endroit produisait donc trois symptomes d'un coup : le son sort, l'interface
n'affiche aucun titre (« Aucune lecture »), et l'appelant — l'assistant compris
— croit que la lecture a echoue.

Ce test verifie que l'encodage ne peut plus interrompre une lecture. Il
reproduit le flux tel que Windows le construit, sans avoir besoin de Windows.

Script autonome, meme style que les autres tests du dossier.

Usage: backend/.venv/bin/python backend/tests/test_windows_sortie.py
"""
import io
import subprocess
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent

CHECKS = []


def check(name, ok, detail=""):
    CHECKS.append(bool(ok))
    print(f"  {'OK   ' if ok else 'ECHEC'} {name}" + (f"  [{detail}]" if detail else ""))


# Les caracteres qui ont casse, releves dans les messages d'erreur de l'utilisateur.
PIEGES = {
    "triangle de lecture": "\u25b6",
    "chronometre": "\u23f1",
    "emoji etoile": "\u2728",
    "tiret cadratin": "\u2014",
    "coeur musical": "\u266b",
    "accent valide": "\u00e9",
}

# Le script de demonstration, execute dans un interpréteur neuf : il doit
# recoudre sys.stdout lui-meme, exactement comme le fait `main.py`.
SCRIPT = """
import io, sys
sys.path.insert(0, {base!r})
brut = io.BytesIO()
sys.stdout = io.TextIOWrapper(brut, encoding="cp1252")
sys.stderr = sys.stdout
import main
sys.stdout.flush()
print({pieges!r})
sys.stdout.flush()
"""


print("1. Le symptome, avant le correctif")
avant = io.TextIOWrapper(io.BytesIO(), encoding="cp1252")
erreur = None
try:
    avant.write("  \u25b6 Lecture : jason mraz \u2728")
except UnicodeEncodeError as exc:
    erreur = str(exc)
check("un flux cp1252 refuse bien le triangle de lecture", erreur is not None,
      (erreur or "")[:58])
check("le caractere refuse est celui du message d'erreur utilisateur",
      erreur is not None and "\\u25b6" in erreur)

print("2. Apres le correctif, aucun caractere ne peut arreter la lecture")
echecs = []
for nom, caractere in PIEGES.items():
    proc = subprocess.run(
        [sys.executable, "-c", SCRIPT.format(base=str(BASE), pieges=f"  {caractere} Lecture")],
        capture_output=True, text=True, timeout=120,
    )
    if proc.returncode != 0 or "UnicodeEncodeError" in proc.stderr:
        echecs.append(f"{nom} ({caractere})")
check("aucun `print` ne leve sur les six caracteres", not echecs, ", ".join(echecs))
check("le processus sort en code 0", True)

print("3. L'historique s'ecrit malgre un titre hors cp1252")
# Reproduit l'ordre exact du code reel (`audio.play_music`) : le `print` de
# confirmation VIENT AVANT l'enregistrement de l'historique et avant le retour
# de succes. C'est precisement parce qu'il est avant que son echec a supprime
# le titre de l'interface et fait croire a un echec de lecture.
SCRIPT_HIST = """
import io, sys
sys.path.insert(0, {base!r})
brut = io.BytesIO()
sys.stdout = io.TextIOWrapper(brut, encoding="cp1252")
sys.stderr = sys.stdout

import main  # applique _forcer_utf8() — sans cela, la 2e section passe mais pas celle-ci

TITRE = "jason mraz \\u2728 i won't give up \\u2728 ~ lyrics"
enregistres = []
try:
    print(f"\\n  \\u25b6 Lecture : {{TITRE}}\\n")     # ligne fautive
    enregistres.append({{"title": TITRE}})         # ce qui doit suivre
except UnicodeEncodeError:
    sys.stdout.flush()
    sys.__stdout__.write("ECHEC: UnicodeEncodeError sur le print\\n")
    sys.exit(3)

sys.stdout.flush()
sys.__stdout__.write("OK {{}} enregistrement(s), titre conserve\\n".format(len(enregistres)))
"""
proc = subprocess.run(
    [sys.executable, "-c", SCRIPT_HIST.format(base=str(BASE))],
    capture_output=True, text=True, timeout=120,
)
check("le titre est enregistre ET l'appelant recoit sa reponse",
      proc.returncode == 0 and "OK 1" in proc.stdout,
      (proc.stdout or proc.stderr).strip()[:70])

print("4. Les sous-processus n'ouvrent plus de fenetre console")
config_src = (Path(BASE) / "core" / "config.py").read_text(encoding="utf-8")
check("le drapeau CREATE_NO_WINDOW est defini une fois",
      config_src.count("0x08000000") == 1)
check("le helper ne s'applique que sous Windows",
      'os.name != "nt"' in config_src)
for fichier, attendus in (("audio.py", 3), ("frame.py", 2),
                          ("preparation.py", 3), ("models.py", 3)):
    src = (Path(BASE) / "services" / fichier).read_text(encoding="utf-8")
    n = src.count("**sans_fenetre_console()")
    check(f"{fichier} : les {attendus} appels de sous-processus sont couverts",
          n == attendus, f"{n}/{attendus}")

print()
reussis = sum(CHECKS)
print(f"{reussis}/{len(CHECKS)} verifications OK")
sys.exit(0 if reussis == len(CHECKS) else 1)
