"""Enchainement du flux infini : la fin d'un titre ne doit jamais figer la boucle.

Reproduit l'etat reellement observe en fin de titre : mpv **decharge** le fichier,
donc `eof-reached`, `time-pos` et `duration` deviennent *indisponibles* alors que
`pause` reste faux. Avant correctif, la boucle ne voyait jamais cette fin : elle
tombait sur sa garde de duree max (10 minutes), la lecture s'arretait net avec une
file pleine, et les boutons de transport se desactivaient cote client.

Script autonome (meme style que test_queue_skip.py). Aucun son n'est joue : l'IPC
mpv est remplace par un faux, et `play_music` ne lance rien. Sort en code 1 si un
cas echoue.

Usage: backend/.venv/bin/python backend/tests/test_streaming_chain.py
"""
import json
import sys
import threading
import time
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))

from services import audio, queue as play_queue, state, streaming

CHECKS = []


def check(name, ok, detail=""):
    CHECKS.append(bool(ok))
    print(f"  {'OK   ' if ok else 'ECHEC'} {name}" + (f"  [{detail}]" if detail else ""))


# --- Faux mpv : rejoue les reponses IPC exactes du vrai ----------------------
REPONSES = {}


def faux_ipc(cmd, timeout=5.0):
    return REPONSES.get(tuple(cmd))


audio._ipc_send = faux_ipc
streaming._ipc_send = faux_ipc
# Ce processus ne lance aucun daemon : sans cela `is_idle` court-circuiterait la
# sonde (daemon injoignable = inactif) et le faux IPC ne serait jamais lu.
audio._mpv_ready = lambda: True


def mpv_idle():
    """Etat observe apres la fin d'un titre : plus rien de charge."""
    REPONSES.clear()
    REPONSES[("get_property", "idle-active")] = {"error": "success", "data": True}
    for prop in ("eof-reached", "time-pos", "duration"):
        REPONSES[("get_property", prop)] = {"error": "property unavailable"}
    REPONSES[("get_property", "pause")] = {"error": "success", "data": False}


def mpv_joue(position: float, duree: float):
    """Etat observe pendant la lecture : media charge, position connue."""
    REPONSES.clear()
    REPONSES[("get_property", "idle-active")] = {"error": "success", "data": False}
    REPONSES[("get_property", "eof-reached")] = {"error": "success", "data": False}
    REPONSES[("get_property", "time-pos")] = {"error": "success", "data": position}
    REPONSES[("get_property", "duration")] = {"error": "success", "data": duree}


print("\n[1] mpv a vide : le titre est fini")
mpv_idle()
check("l'inactivite de mpv est reconnue", audio.is_idle() is True)
check("la fin est vue, meme sans eof/position/duree disponibles",
      streaming._stream_title_done() is True)

print("\n[2] lecture en cours : aucun enchainement intempestif")
mpv_joue(40.0, 180.0)
check("un media charge n'est pas vu comme inactif", audio.is_idle() is False)
check("au milieu du titre, il n'est pas fini", streaming._stream_title_done() is False)
mpv_joue(179.0, 180.0)
check("dans la derniere seconde, il est fini", streaming._stream_title_done() is True)

print("\n[3] reponse IPC illisible : on n'avance pas sur un doute")
REPONSES.clear()
REPONSES[("get_property", "idle-active")] = {"error": "property unavailable"}
check("daemon vivant mais reponse illisible -> pas d'avance", audio.is_idle() is False)

print("\n[4] la boucle enchaine toute seule quand mpv se vide")
REPONSES.clear()  # aucune propriete IPC : le seul signal est l'inactivite de mpv

joues = []
charge = {"actif": False}


def faux_play_music(video_id, *args, **kwargs):
    joues.append(video_id)
    charge["actif"] = True  # le vrai play_music confirme le demarrage avant de rendre la main
    return json.dumps({"status": "playing"}, ensure_ascii=False)


titres = [{"video_id": "aaaaaaaaaaa", "title": "A", "channel": "C"},
          {"video_id": "bbbbbbbbbbb", "title": "B", "channel": "C"}]

# Stubs : la boucle ne doit toucher ni mpv, ni une vraie file, ni une vraie reco.
streaming.play_music = faux_play_music
streaming.prefetch_upcoming = lambda count=2: None
streaming.is_idle = lambda: not charge["actif"]
play_queue.queue_pop_next = lambda: titres.pop(0) if titres else None
play_queue.queue_fill = lambda *args, **kwargs: True
play_queue.drop_from_timeline = lambda video_id: None

state.STREAMING_MODE = True
state.STREAMING_SKIP.clear()
state.STREAMING_COUNT = 0
state.STREAMING_MAX_TITLE_SECS = 10_000  # la garde de duree ne doit pas servir ici

boucle = threading.Thread(target=streaming._streaming_loop, daemon=True, name="streaming")
boucle.start()
time.sleep(0.5)  # le titre A est lance, la boucle attend sa fin
check("le premier titre est lance", joues == ["aaaaaaaaaaa"], str(joues))

charge["actif"] = False  # fin du titre : mpv decharge le fichier
time.sleep(0.7)          # la boucle doit avoir vu la fin et enchaine
state.STREAMING_MODE = False
state.STREAMING_SKIP.set()
boucle.join(timeout=3)

check("le titre suivant est enchaine sans attendre la garde de 10 min",
      joues == ["aaaaaaaaaaa", "bbbbbbbbbbb"], str(joues))
check("la boucle s'est arretee proprement", not boucle.is_alive())

# --- [5] Le titre prepare doit avoir l'enchainement arme -----------------------
# Symptome reellement observe : au demarrage, l'app charge le dernier titre en
# pause et remplit la file ; le titre se joue, se termine, et tout s'arrete net
# ("c'est le dernier titre") alors que la file contient des titres. Le seul
# moteur d'enchainement est la boucle de streaming, or ce chemin ne la
# demarrait pas : la file etait donc inerte.
print("\n[5] titre prepare : l'enchainement est arme")
state.STREAMING_MODE = False
state.STREAMING_THREAD = None
mpv_joue(0.0, 180.0)

demarres = []


def faux_start_streaming(mood="", force_genre=True, wait_current=False):
    demarres.append({"mood": mood, "force_genre": force_genre,
                     "wait_current": wait_current})
    state.STREAMING_MODE = True
    state.STREAMING_THREAD = threading.current_thread()
    return json.dumps({"status": "streaming_started"}, ensure_ascii=False)


# `prepare_playback` lit l'historique puis charge le titre ; on court-circuite
# les deux et on n'observe que l'arme du flux.
audio.hist_read = lambda n: ([{"video_id": "aaaaaaaaaaa"}] if n == 1 else [])
audio._ensure_daemon = lambda: True
audio.play_music = lambda video_id, **kw: json.dumps(
    {"status": "playing", "title": "A"}, ensure_ascii=False)
streaming.start_streaming = faux_start_streaming

state._now_playing = False
audio.prepare_playback()
time.sleep(0.3)  # l'arme part dans un thread de fond
check("preparer un titre arme la boucle de streaming", len(demarres) == 1,
      str(demarres))
check("l'arme attend la fin du titre deja charge",
      bool(demarres) and demarres[0]["wait_current"] is True, str(demarres))
check("STREAMING_MODE est vrai apres la preparation",
      state.STREAMING_MODE is True)

# Cas voisin : une interface qui se recharge laisse un titre joue mais aucune
# boucle. `prepare_playback` doit alors armer l'enchainement sans ecraser le
# titre en cours.
print("\n[6] titre deja charge, sans boucle (reload d'interface)")
demarres.clear()
state.STREAMING_MODE = False
state.STREAMING_THREAD = None
state._now_playing = True
res = json.loads(audio.prepare_playback())
time.sleep(0.3)
check("le titre en cours n'est pas ecrase", res.get("status") == "already_loaded",
      str(res))
check("malgre tout, l'enchainement est arme", len(demarres) == 1, str(demarres))

state.STREAMING_MODE = False
state.STREAMING_SKIP.set()

failures = CHECKS.count(False)
print(f"\n{len(CHECKS) - failures}/{len(CHECKS)} cas OK")
sys.exit(1 if failures else 0)
