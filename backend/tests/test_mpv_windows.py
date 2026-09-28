"""Le chemin Windows du moteur audio : la ou l'application ne demarre pas du tout.

Contexte observe sur Windows (capture de l'utilisateur, 2026-09-27) :

    File "...\\resources\\bac...\\audio.py", line 214, in _ipc_send
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    AttributeError: module 'socket' has no attribute 'AF_UNIX'
    ERROR:  Application startup failed. Exiting.

Windows n'a pas de socket AF_UNIX : mpv y expose son IPC par un **named pipe**.
Trois adaptations sont necessaires, et chacune est verifiee ici sans Windows ni
mpv : le chemin du canal, le transport d'envoi, et le binaire a lancer
(`mpv.exe` est un binaire GUI qui detache stdout, donc muet pour la progression).

Ce que ce test ne peut pas faire : prouver que le named pipe repond reellement.
Cela demande mpv sur Windows. Il verifie que le code y arrive, et que rien n'y
repose encore sur une hypothese Unix.

Script autonome, meme style que les autres tests du dossier. Sort en code 1 si
un cas echoue.

Usage: backend/.venv/bin/python backend/tests/test_mpv_windows.py
"""
import builtins
import json
import os
import sys
import tempfile
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))

# Fixe AVANT l'import : `state` lit le port une seule fois, au chargement.
PORT = "8041"
os.environ["NEUROBEATS_PORT"] = PORT

from core import config  # noqa: E402
from services import audio, state  # noqa: E402

CHECKS = []

# Prefixe du named pipe, ecrit par concatenation : une chaine brute ne peut pas
# finir par une barre oblique, ce que rend le chemin de Windows.
PIPE = "\\\\" + "."
PIPE_PREFIX = PIPE + "\\pipe" + "\\"
TRIPLE_DOUBLE = chr(34) * 3
TRIPLE_SIMPLE = chr(39) * 3


def check(name, ok, detail=""):
    CHECKS.append(bool(ok))
    print(f"  {'OK   ' if ok else 'ECHEC'} {name}" + (f"  [{detail}]" if detail else ""))


def en_os(nom, fn):
    """Execute `fn` en faisant croire a `os.name` la valeur demandee."""
    vrai = os.name
    os.name = nom
    try:
        return fn()
    finally:
        os.name = vrai


class FauxPipe:
    """Faux named pipe : enregistre ce qu'on ecrit, sert les reponses en attente.

    mpv est en JSON delimite par des sauts de ligne : c'est ce que reproduit
    `read` ici, en rendant un morceau a la fois.
    """

    def __init__(self, *messages: bytes):
        self.encours = list(messages)
        self.ecrit = b""
        self.ferme = False

    def write(self, donnees):
        self.ecrit += donnees
        return len(donnees)

    def read(self, taille=-1):
        if self.ferme or not self.encours:
            return b""
        # mpv delimite chaque message par un saut de ligne, et un pipe est un
        # flux d'octets : une lecture rend tout ce qui est deja arrive, souvent
        # les deux messages d'un coup. Servir un message par lecture rendait le
        # test incapable de reproduire le cas qu'il pretend verifier.
        return b"".join(msg + b"\n" for msg in self.encours)

    def close(self):
        self.ferme = True


# --- 1. Le chemin du canal ---------------------------------------------------

print("1. Chemin du canal IPC")

unix = en_os("posix", state._mpv_ipc_path)
windows = en_os("nt", state._mpv_ipc_path)

check("Unix : socket dans le repertoire temporaire",
      unix == os.path.join(tempfile.gettempdir(), f"neurobeats-mpv-{PORT}.sock"), unix)
check("Windows : named pipe, pas un chemin de fichier",
      windows == PIPE_PREFIX + f"neurobeats-mpv-{PORT}", windows)
check("les deux canaux sont distincts (deux backends ne se volent pas le canal)",
      unix != windows)
# Piège Windows : un named pipe n'est pas un chemin de systeme de fichiers, donc
# `os.path.exists` y renvoie toujours False — on croit le canal libre alors
# qu'un mpv orphelin le tient encore.
check("le chemin Windows n'est pas un chemin de fichier exploitable",
      not windows.startswith("/") and not os.path.isabs(windows))

# --- 2. Le transport d'envoi -------------------------------------------------

print("2. Transport de l'envoi")

# Le canal utilise par `_ipc_send_windows` est force sur la forme Windows : la
# variable du module a ete fixee a l'import, sur la plate-forme hote.
vrai_sock = state._MPV_SOCK
state._MPV_SOCK = PIPE_PREFIX + f"neurobeats-mpv-{PORT}"


def envoyer(faux, rid=7, timeout=2.0):
    """Fait passer une commande par `_ipc_send_windows`, via un faux pipe."""
    capture = {}

    def faux_open(chemin, mode, buffering=0):
        capture["chemin"] = chemin
        capture["mode"] = mode
        return faux

    vrai_open = builtins.open
    builtins.open = faux_open
    try:
        msg = audio._ipc_send_windows(
            json.dumps({"command": ["get_property", "idle-active"], "request_id": rid}) + "\n",
            rid, timeout,
        )
    finally:
        builtins.open = vrai_open
    return capture, msg


faux = FauxPipe(json.dumps({"error": "success", "data": True, "request_id": 7}).encode())
capture, msg = envoyer(faux)
check("ouvre le canal declare en lecture/ecriture",
      capture.get("chemin") == state._MPV_SOCK and "r" in capture.get("mode", "")
      and "b" in capture.get("mode", ""), f"{capture.get('mode')} {capture.get('chemin')}")
check("la commande part sur une ligne terminee par un saut",
      faux.ecrit.endswith(b"\n") and b"idle-active" in faux.ecrit)
check("la reponse JSON est rendue",
      isinstance(msg, dict) and msg.get("data") is True, json.dumps(msg or {}))

# mpv melange ses propres evenements dans le meme flux : un evenement sans notre
# request_id doit etre ignore, sinon la reponse de `set_property` serait lue
# comme un echec de la commande precedente.
faux = FauxPipe(
    json.dumps({"event": "playback-restart"}).encode(),
    json.dumps({"error": "success", "data": 42, "request_id": 7}).encode(),
)
_, msg = envoyer(faux)
check("un evenement sans request_id est ignore",
      isinstance(msg, dict) and msg.get("data") == 42, json.dumps(msg or {}))

# Pipe ferme immediatement (daemon mort) : None tout de suite, sans attendre.
faux = FauxPipe()
_, msg = envoyer(faux)
check("un pipe ferme rend None sans planter", msg is None)


def open_qui_echoue(*a, **k):
    raise FileNotFoundError("pipe absent")


vrai_open = builtins.open
builtins.open = open_qui_echoue
try:
    msg = audio._ipc_send_windows('{"request_id": 1}\n', 1, 1.0)
finally:
    builtins.open = vrai_open
check("un pipe absent rend None au lieu de lever", msg is None)
state._MPV_SOCK = vrai_sock

# --- 3. Le binaire lance -----------------------------------------------------

print("3. Binaire mpv lance")

vrai_which = config.shutil.which


def which_de(chemins):
    return lambda nom: chemins.get(nom)


config.shutil.which = which_de({"mpv.com": "C:\\app\\bin\\mpv.com", "mpv.exe": "C:\\app\\bin\\mpv.exe"})
try:
    choisi = en_os("nt", config._mpv_executable)
    check("Windows : mpv.com est prefere a mpv.exe", choisi.endswith("mpv.com"), choisi)
finally:
    config.shutil.which = vrai_which

# Cas reel du packaging : `mpv.com` n'est pas dans le PATH, mais il est pose a
# cote de `mpv.exe`, qui y est (c'est lui que le parent y ajoute).
with tempfile.TemporaryDirectory() as td:
    (Path(td) / "mpv.exe").write_text("x")
    (Path(td) / "mpv.com").write_text("x")
    config.shutil.which = which_de({"mpv.exe": str(Path(td) / "mpv.exe")})
    try:
        choisi = en_os("nt", config._mpv_executable)
        check("Windows : mpv.com retrouve a cote de mpv.exe",
              choisi == str(Path(td) / "mpv.com"), choisi)
    finally:
        config.shutil.which = vrai_which

config.shutil.which = which_de({})
try:
    check("Windows : a defaut de mpv.com, on ne lance pas mpv.exe en silence",
          en_os("nt", config._mpv_executable).endswith("mpv.exe"))
finally:
    config.shutil.which = vrai_which

check("Unix : le binaire s'appelle mpv", en_os("posix", config._mpv_executable) == "mpv")

# --- 4. Plus aucune hypothese Unix sur le chemin critique --------------------

print("4. Plus d'hypothese Unix sur le chemin de demarrage")

source = Path(BASE, "services", "audio.py").read_text(encoding="utf-8")
lignes = source.splitlines()


def code_seul(source: str) -> str:
    """Le code, sans commentaires ni chaines.

    Indispensable ici : les commentaires expliquent *pourquoi* on evite
    `AF_UNIX` et `SIGKILL` sous Windows, donc une simple recherche de texte
    trouverait ces mots dans les justifications et conclurait a tort que le
    chemin Windows en depend.
    """
    import io
    import tokenize

    garder = []
    try:
        for jeton in tokenize.generate_tokens(io.StringIO(source).readline):
            if jeton.type == tokenize.COMMENT:
                continue
            if jeton.type == tokenize.STRING:
                litteral = jeton.string.lstrip("rRbBuUfF")
                # Seules les chaines triplement quotees sont des docstrings.
                # "taskkill" ou "nt" sont du CODE : les supprimer ferait
                # echouer les verifications a raison.
                if litteral.startswith(TRIPLE_SIMPLE) or litteral.startswith(TRIPLE_DOUBLE):
                    continue
            garder.append(jeton.string)
    except tokenize.TokenError:
        return source
    return " ".join(garder)


def corps(fonction: str) -> str:
    """Le corps d'une fonction, de sa definition a la suivante de meme indent."""
    debut = next(i for i, l in enumerate(lignes) if l.startswith(f"def {fonction}("))
    for i in range(debut + 1, len(lignes)):
        if lignes[i].startswith("def "):
            return code_seul("\n".join(lignes[debut:i]))
    return code_seul("\n".join(lignes[debut:]))


def dense(texte: str) -> str:
    """Le code sans espaces : insensible a la mise en forme du tokeniseur."""
    return "".join(texte.split())


check("le transport Windows ne touche pas AF_UNIX",
      "AF_UNIX" not in corps("_ipc_send_windows"))
check("le transport Windows ne touche pas /proc",
      "/proc" not in corps("_ipc_send_windows"))
check("`_ipc_send` choisit le transport selon la plate-forme",
      'os.name=="nt"' in dense(corps("_ipc_send"))
      and "_ipc_send_windows" in corps("_ipc_send"))
check("`signal.SIGKILL` est absent du reeur Windows (le module ne le definit pas)",
      "SIGKILL" not in corps("_reap_orphan_mpv_windows"))
check("le reeur Windows passe par taskkill", "taskkill" in corps("_reap_orphan_mpv_windows"))
check("le reeur Unix garde sa lecture de /proc", "/proc" in corps("_reap_orphan_mpv"))
# Une seule occurrence dans le CODE : l'autre mention est un commentaire.
# Le vrai enjeu est qu'aucun chemin Windows n'aille chercher `os.kill`, dont
# `signal.SIGKILL` n'existe pas la-bas.
check("`taskkill` n'apparait que dans le reeur Windows",
      code_seul(source).count("taskkill") == 1,
      f"{code_seul(source).count('taskkill')} occurrences dans le code")
check("`os.kill` n'apparait que dans le reeur Unix",
      dense(code_seul(source)).count("os.kill") == 2,
      f"{dense(code_seul(source)).count('os.kill')} occurrences dans le code")

print()
reussis = sum(CHECKS)
print(f"{reussis}/{len(CHECKS)} verifications OK")
sys.exit(0 if reussis == len(CHECKS) else 1)
