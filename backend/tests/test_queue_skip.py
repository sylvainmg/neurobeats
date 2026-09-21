"""Bouton « Suivant » et file de lecture hors flux infini : verification.

Aucun son n'est joue : `play_music`, `_restart_loop`, `_prefetch` et `queue_fill`
sont remplaces par des espions, et l'ecriture en base est coupee. Le script est
autonome (meme style que test_recommendation.py) et sort en code 1 si un cas
echoue.

Usage: backend/.venv/bin/python backend/tests/test_queue_skip.py
"""
import inspect
import json
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))

from services import audio, queue as play_queue, recommendation, state, streaming

CHECKS = []


def check(name, ok, detail=""):
    CHECKS.append(bool(ok))
    print(f"  {'OK   ' if ok else 'ECHEC'} {name}" + (f"  [{detail}]" if detail else ""))


# --- Espions -----------------------------------------------------------------
_played = []
_restarted = []
_filled = []


def _fake_play_music(video_id, *args, **kwargs):
    _played.append(video_id)
    return json.dumps({"status": "playing", "video_id": video_id,
                       "title": f"T-{video_id}", "channel": "C"}, ensure_ascii=False)


def _fake_restart_loop(wait_current=True):
    _restarted.append(wait_current)


def _fake_queue_fill(mood="", force_genre=True, rebuild=True):
    _filled.append((mood, force_genre, rebuild))
    return True


streaming.play_music = _fake_play_music
streaming._restart_loop = _fake_restart_loop
# Pas d'ecriture en base depuis un test (le vrai `_log_skip` insererait un skip).
streaming._db_ready = lambda: False
play_queue.queue_fill = _fake_queue_fill
play_queue.start_watchdog = lambda: None
audio._prefetch = lambda video_id: None
streaming._prefetch = lambda *a, **kw: None


def setup(n_tracks=3, playing=True, streaming_mode=False):
    """File de `n_tracks` titres + session chargee, sans flux infini."""
    play_queue._QUEUE = [{"video_id": f"q{i}", "title": f"Q{i}", "channel": "C"}
                         for i in range(n_tracks)]
    play_queue._POSITION = 0
    play_queue._HISTORY = []
    play_queue._REFILLING = False
    play_queue._FILL_LAST_FAILED = 0.0
    play_queue._MOOD = "rap fr"
    play_queue._FORCE_GENRE = True
    state.STREAMING_MODE = streaming_mode
    state.STREAMING_SKIP.clear()
    state._now_playing = playing
    _played.clear()
    _restarted.clear()
    _filled.clear()


print("\n[1] « Suivant » SANS flux infini (le cas qui ne faisait rien)")
setup(3)
res = json.loads(streaming.skip_streaming())
check("statut 'skipped' (plus de 400)", res.get("status") == "skipped", str(res)[:110])
check("le titre de tete de file est joue", _played == ["q0"], str(_played))
check("l'enchainement est relance", _restarted == [True], str(_restarted))
check("la file a avance", play_queue.queue_remaining() == 2,
      str(play_queue.queue_remaining()))

print("\n[2] « Suivant » avec file vide (ne doit jamais etre une erreur)")
setup(0)
res = json.loads(streaming.skip_streaming())
check("aucune erreur renvoyee", "error" not in res, str(res)[:110])
check("statut 'queue_filling'", res.get("status") == "queue_filling")
check("un remplissage est demande", len(_filled) >= 1, str(_filled))
check("aucun titre lance", not _played, str(_played))

print("\n[3] « Suivant » pendant le flux infini (comportement conserve)")
setup(3, streaming_mode=True)
res = json.loads(streaming.skip_streaming())
check("statut 'skipped'", res.get("status") == "skipped")
check("signal de skip pose a la boucle", state.STREAMING_SKIP.is_set())
check("aucun lancement direct (c'est la boucle qui enchaine)", not _played, str(_played))
state.STREAMING_MODE = False
state.STREAMING_SKIP.clear()

print("\n[4] File entretenue hors flux (titre charge, meme en pause)")
setup(2, streaming_mode=False)
play_queue._maybe_refill()
check("rechargement lance hors flux", len(_filled) == 1, str(_filled))
setup(2, playing=False, streaming_mode=False)
play_queue._maybe_refill()
check("aucun rechargement sans session", not _filled, str(_filled))

print("\n[5] Anti-martellement apres un remplissage vide")
setup(2)
play_queue._note_fill_failed()
play_queue._maybe_refill()
check("pas de relance immediate (backoff)", not _filled, str(_filled))

print("\n[6] Pre-remplissage au demarrage : aucun son")
audio.infer_genre_ollama = lambda title, channel: "rap fr"
audio.hist_read = lambda count: [{"video_id": "last", "title": "T", "channel": "C"}]
audio._meta = lambda video_id: {"title": "T", "channel": "C"}
setup(0, playing=False)
_filled.clear()
_played.clear()
audio._prefill_queue()
check("construction de file planifiee", _filled and _filled[0][0] == "rap fr", str(_filled))
check("aucune lecture declenchee", not _played, str(_played))
check("flux infini non demarre", state.STREAMING_MODE is False)

print("\n[7] Publication progressive de la file (2 tours pour 10 titres)")
_recos = [{"video_id": f"v{i}", "title": f"T{i}", "channel": "C"} for i in range(10)]
_round = {"n": 0}
_sizes = []


def _fake_get_recommendation(query="", force_genre_filter=False, count=3):
    _sizes.append(play_queue.queue_remaining())  # taille publiee AVANT ce tour
    start = _round["n"]
    _round["n"] += 1
    return json.dumps({"recommendations": _recos[start * count:(start + 1) * count]})


recommendation.get_recommendation = _fake_get_recommendation
setup(0, playing=True)
play_queue._FILL_GEN += 1
play_queue._REFILLING = True
play_queue.queue_build(play_queue._FILL_GEN, "rap fr", True, target=10)
check("file complete a 10 titres", play_queue.queue_remaining() == 10,
      str(play_queue.queue_remaining()))
check("2 tours de reco ont suffi", _round["n"] == 2, f"{_round['n']} tours")
check("file publiee au 1er lot (progressive)", _sizes[:2] == [0, 5], str(_sizes))

print("\n[8] Contrat de l'API de reco (retrocompatibilite)")
sig = inspect.signature(recommendation.get_recommendation)
check("parametre 'count' disponible", "count" in sig.parameters)
check("defaut a 3 (chat/API inchanges)", sig.parameters["count"].default == 3)

print("\n[9] Clic sur un titre de la file : les sautes ne sont plus ecrases")
setup(5)
play_queue._HISTORY = [{"video_id": "prev", "title": "Precedent",
                        "channel": "C", "genre": "autre"}]
target = play_queue.queue_jump(3)
check("le 3e titre de la file est joue", bool(target) and target["video_id"] == "q2",
      str(target and target.get("video_id")))
check("la file ne garde que les suivants",
      [t["video_id"] for t in play_queue.queue_peek_many(5)] == ["q3", "q4"],
      str([t["video_id"] for t in play_queue.queue_peek_many(5)]))
# Ce que fait play_music au demarrage du titre : il empile le titre joue.
play_queue.record_played(target)
snap = play_queue.queue_snapshot()
check("les titres sautes restent dans la timeline",
      [t["video_id"] for t in snap["tracks"]] == ["prev", "q0", "q1", "q2", "q3", "q4"],
      str([t["video_id"] for t in snap["tracks"]]))
check("le titre courant est celui clique", snap["current_index"] == 3,
      str(snap["current_index"]))
check("l'index hors file ne casse rien", play_queue.queue_jump(99) is None)

print("\n[10] Curseur en arriere : ce qui suivait redevient a venir")
setup(3)
play_queue._HISTORY = [
    {"video_id": "prev2", "title": "Avant-dernier", "channel": "C", "genre": "rap fr"},
    {"video_id": "old", "title": "Vieux", "channel": "C", "genre": "rap fr"},
    {"video_id": "cur", "title": "Courant", "channel": "C", "genre": "rap fr"},
]
back = play_queue.queue_jump(-1)
check("le titre clique est bien celui vise",
      bool(back) and back["video_id"] == "old", str(back and back.get("video_id")))
check("le curseur s'arrete sur le titre clique",
      [t["video_id"] for t in play_queue._HISTORY] == ["prev2", "old"],
      str([t["video_id"] for t in play_queue._HISTORY]))
check("le titre ecarte repasse en tete de file, dans l'ordre",
      [t["video_id"] for t in play_queue.queue_peek_many(4)] == ["cur", "q0", "q1", "q2"],
      str([t["video_id"] for t in play_queue.queue_peek_many(4)]))
snap = play_queue.queue_snapshot()
check("la timeline replace le curseur sur le titre clique",
      snap["current_index"] == 1
      and [t["video_id"] for t in snap["tracks"]] == ["prev2", "old", "cur", "q0", "q1", "q2"],
      f"index={snap['current_index']} {[t['video_id'] for t in snap['tracks']]}")
check("aucune copie dans la timeline",
      len({t["video_id"] for t in snap["tracks"]}) == len(snap["tracks"]),
      str([t["video_id"] for t in snap["tracks"]]))
encore = play_queue.queue_jump(-1)
check("on peut reculer encore d'un cran",
      bool(encore) and encore["video_id"] == "prev2", str(encore and encore.get("video_id")))
check("tout debut de session : reculer ne casse rien",
      play_queue.queue_jump(-1) is None)
check("trop loin en arriere ne casse rien", play_queue.queue_jump(-99) is None)

print("\n[11] Rejeu hors file : pas de doublon dans la timeline")
setup(3)
play_queue._HISTORY = []
play_queue.record_played({"video_id": "a", "title": "A", "channel": "C"})
play_queue.record_played({"video_id": "b", "title": "B", "channel": "C"})
play_queue.record_played({"video_id": "a", "title": "A", "channel": "C"})
check("le titre relance remonte en courant, sans doublon",
      [t["video_id"] for t in play_queue.queue_snapshot()["tracks"]][:2] == ["b", "a"],
      str([t["video_id"] for t in play_queue.queue_snapshot()["tracks"]]))

print("\n[12] Saut par-dessus un titre deja joue : pas de doublon non plus")
setup(3)
play_queue._HISTORY = [{"video_id": "cur", "title": "Courant", "channel": "C", "genre": "autre"}]
play_queue._QUEUE = [
    {"video_id": "x", "title": "X", "channel": "C", "genre": "autre"},
    {"video_id": "cur", "title": "Courant", "channel": "C", "genre": "autre"},
    {"video_id": "y", "title": "Y", "channel": "C", "genre": "autre"},
]
target = play_queue.queue_jump(3)
tracks = [t["video_id"] for t in play_queue.queue_snapshot()["tracks"]]
check("le titre deja joue ne se duplique pas", tracks.count("cur") == 1, str(tracks))
check("le titre vise est bien joue", bool(target) and target["video_id"] == "y",
      str(target and target.get("video_id")))

print("\n[13] Jouer un titre deja programme ne le laisse pas en double")
setup(3)
play_queue._HISTORY = []
play_queue.record_played({"video_id": "q1", "title": "Q1", "channel": "C",
                          "genre": "autre"})
check("le titre joue n'est plus aussi a venir",
      [t["video_id"] for t in play_queue.queue_snapshot()["tracks"]].count("q1") == 1,
      str([t["video_id"] for t in play_queue.queue_snapshot()["tracks"]]))
check("la file garde son ordre",
      [t["video_id"] for t in play_queue.queue_peek_many(3)] == ["q0", "q2"],
      str([t["video_id"] for t in play_queue.queue_peek_many(3)]))

print("\n[14] Saut en avant : le titre ne quitte jamais la timeline")
setup(3)
play_queue._HISTORY = [{"video_id": "prev", "title": "Precedent", "channel": "C",
                        "genre": "autre"}]
target = play_queue.queue_jump(2)
snap = play_queue.queue_snapshot()
ids = [t["video_id"] for t in snap["tracks"]]
check("le titre clique est deja dans la timeline (aucun trou pendant le chargement)",
      "q1" in ids, str(ids))
check("il y est deja comme titre courant", snap["current_index"] == 2,
      f"index={snap['current_index']} {ids}")
# Ce que fait play_music en demarrant le son : il empile le titre joue.
play_queue.record_played(target)
snap = play_queue.queue_snapshot()
ids = [t["video_id"] for t in snap["tracks"]]
check("play_music ne le re-empile pas (toujours une seule occurrence)",
      ids.count("q1") == 1 and snap["current_index"] == 2,
      f"index={snap['current_index']} {ids}")
# Flux refuse par mpv : le curseur ne doit pas rester sur un titre que rien ne joue.
play_queue.undo_jump(target)
snap = play_queue.queue_snapshot()
ids = [t["video_id"] for t in snap["tracks"]]
check("un saut qui echoue remet le titre en file",
      [t["video_id"] for t in play_queue.queue_peek_many(1)] == ["q1"],
      str([t["video_id"] for t in play_queue.queue_peek_many(1)]))
check("et la timeline ne garde pas de courant fantome",
      snap["current_index"] == 1 and ids[:2] == ["prev", "q0"],
      f"index={snap['current_index']} {ids}")

print("\n[15] Suivant (bouton ou flux) : meme garantie, aucun trou")
setup(3)
play_queue._HISTORY = [{"video_id": "prev", "title": "Precedent", "channel": "C",
                        "genre": "autre"}]
nxt = play_queue.queue_pop_next()
snap = play_queue.queue_snapshot()
ids = [t["video_id"] for t in snap["tracks"]]
check("le titre consomme est deja le courant (aucun trou pendant le chargement)",
      snap["current_index"] == 1 and ids[1] == "q0", f"index={snap['current_index']} {ids}")
check("il n'y figure qu'une fois", ids.count("q0") == 1, str(ids))
# Flux refuse par mpv : ce que fait la boucle de streaming.
play_queue.drop_from_timeline(nxt["video_id"])
snap = play_queue.queue_snapshot()
ids = [t["video_id"] for t in snap["tracks"]]
check("un titre qui ne demarre pas ne reste pas en courant fantome",
      snap["current_index"] == 0 and "q0" not in ids,
      f"index={snap['current_index']} {ids}")

print("\n[16] Retirer un titre a venir de la file")
setup(3)
# On neutralise la completion de fond : ce test isole le retrait lui-meme.
fills = []
real_fill = play_queue.queue_fill
play_queue.queue_fill = lambda *a, **k: fills.append(k.get("rebuild")) or True
try:
    removed = play_queue.queue_remove(2)
    check("le 2e titre a venir est retire", bool(removed) and removed["video_id"] == "q1",
          str(removed and removed.get("video_id")))
    ids = [t["video_id"] for t in play_queue.queue_peek_many(3)]
    check("la file garde son ordre sans lui",
          ids[:2] == ["q0", "q2"] and "q1" not in ids, str(ids))
    check("il n'est pas repropose par la recolte suivante",
          "q1" in play_queue._excluded_ids(), str(sorted(play_queue._excluded_ids())))
    check("un index hors file ne casse rien", play_queue.queue_remove(99) is None)
    check("un index nul non plus", play_queue.queue_remove(0) is None)
    check("le retrait demande la completion jusqu'a la cible (sans reconstruction)",
          fills == [False], str(fills))
finally:
    play_queue.queue_fill = real_fill

print("\n[17] Refill : vivier de genre epuise -> bascule sans filtre (generation continue)")
setup(0)
seen_filters = []
real_reco = recommendation.get_recommendation
real_warm = play_queue._warm_urls
play_queue._warm_urls = lambda tracks: None


def fake_reco(query="", force_genre_filter=False, count=5):
    seen_filters.append(force_genre_filter)
    if force_genre_filter:
        # Vivier dur epuise : la reco ne ressort que du deja-ecarte.
        return json.dumps({"recommendations": [{"video_id": "q0", "title": "ecarte",
                                                "channel": "c", "genre": "pop"}]})
    return json.dumps({"recommendations": [
        {"video_id": f"fresh{i}", "title": f"F{i}", "channel": "c", "genre": "pop"}
        for i in range(3)]})


recommendation.get_recommendation = fake_reco
try:
    with play_queue._LOCK:
        play_queue._RECENT[:] = ["q0"]
        play_queue._FORCE_GENRE = True
        play_queue._FILL_GEN += 1
        gen = play_queue._FILL_GEN
    play_queue._do_refill(gen)
    ids = [t["video_id"] for t in play_queue.queue_peek_many(10)]
    check("le filtre dur stérile bascule en sans-filtre", seen_filters[:2] == [True, False],
          str(seen_filters))
    check("la file n'est plus vide", sorted(ids) == ["fresh0", "fresh1", "fresh2"], str(ids))
    check("le mode degrade est retenu pour la suite",
          play_queue._FORCE_GENRE is False, str(play_queue._FORCE_GENRE))
finally:
    recommendation.get_recommendation = real_reco
    play_queue._warm_urls = real_warm

failures = CHECKS.count(False)
print(f"\n{len(CHECKS) - failures}/{len(CHECKS)} cas OK")
sys.exit(1 if failures else 0)
