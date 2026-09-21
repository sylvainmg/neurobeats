"""Streaming continu infini : file pre-calculee -> lecture -> enchainement gapless."""
import json
import threading
import time

from services import audiocache, state
from services.audio import (
    _ipc_send, _prefetch, _resolve_audio_url, _stop_player, is_idle, is_paused,
    play_music,
)
from services.db_access import _db_ready, hist_read
from services import queue as play_queue
from services.state import TIMER_MSGS, _tprint

# Titre en cours, conserve pour le mode repeat "one" (rejeu a la fin du morceau).
_CURRENT: dict | None = None
# Si True, la boucle attend la fin du titre deja en lecture avant de puiser dans
# la file (lancé par autostart_stream : le titre choisi par l'utilisateur doit
# finir avant l'enchainement infini).
_WAIT_CURRENT: bool = False
# Serialise les autostarts (desormais lances en arriere-plan) : deux lectures
# manuelles rapprochees ne doivent pas demarrer deux flux en parallele.
_AUTOSTART_LOCK = threading.Lock()


def _stream_title_done() -> bool:
    """True si le titre en cours est fini : plus rien de charge, fin atteinte, ou
    moins de 1,5 s de reste.

    Le premier cas est celui qui compte en pratique, et il manquait : a la fin
    d'un titre mpv **decharge** le fichier, et `eof-reached`, `time-pos` et
    `duration` deviennent alors indisponibles (`pause` restant faux). Sans ce
    test, la fin n'etait jamais vue : la boucle tombait sur sa garde de duree max
    (10 min), la lecture s'arretait net file pleine, et les boutons de transport
    se desactivaient cote client (`playing` faux).

    Les sondes sont volontairement courtes : elles sont locales, et surtout une
    sonde lente ferait rater la fenetre de 1,5 s qui precede la fin.
    """
    try:
        if is_idle():
            return True
        r = _ipc_send(["get_property", "eof-reached"], timeout=1.0)
        if r and r.get("error") == "success" and r.get("data") is True:
            return True
        pos = _ipc_send(["get_property", "time-pos"], timeout=1.0)
        dur = _ipc_send(["get_property", "duration"], timeout=1.0)
        p = pos.get("data") if pos and pos.get("error") == "success" else None
        d = dur.get("data") if dur and dur.get("error") == "success" else None
        if isinstance(p, (int, float)) and isinstance(d, (int, float)) and d > 0 and p >= d - 1.5:
            return True
    except Exception:
        pass
    return False


def prefetch_upcoming(count: int = 2):
    """Pre-resout l'URL des `count` prochains titres de la file (masque la latence).

    Resoudre 2 titres d'avance couvre un "Suivant" clique plus vite que la
    resolution yt-dlp (~2s). Passe par `_prefetch` (et non un appel direct) pour
    enregistrer un future : sinon play_music relancerait une resolution complete.
    Appele depuis la boucle (hors pool) : pas de soumission imbriquee.
    """
    for track in play_queue.queue_peek_many(count):
        vid = track.get("video_id")
        if vid:
            _prefetch(vid)


def _streaming_loop():
    """Boucle infini : consomme la file pre-calculee -> joue -> attend fin/skip -> replace."""
    global _CURRENT, _WAIT_CURRENT
    if _WAIT_CURRENT:
        _WAIT_CURRENT = False
        # Le titre lance manuellement joue deja : on le laisse finir avant
        # d'enchainer sur la file (un skip force quand meme le suivant).
        TIMER_MSGS.put("  [STREAMING] attente de la fin du titre en cours…")
        while state.STREAMING_MODE and not state.STREAMING_SKIP.is_set():
            if not state._now_playing or _stream_title_done():
                break
            state.STREAMING_SKIP.wait(1.0)
        if state.STREAMING_SKIP.is_set():
            # Skip pendant l'attente : on force le titre suivant, on ne rejoue pas
            # le courant (meme en repeat "one").
            _CURRENT = None
        state.STREAMING_SKIP.clear()
    while state.STREAMING_MODE:
        # Repeat "one" : on rejoue le titre courant tant qu'il n'a pas ete skippe.
        if state.REPEAT_MODE == "one" and _CURRENT is not None:
            nxt = _CURRENT
        else:
            nxt = play_queue.queue_pop_next()
            if not nxt:
                # File vide : le remplissage tourne en arriere-plan (queue_fill est
                # idempotent, il ne lance rien si un remplissage est deja en cours).
                # La boucle attend qu'il alimente la file, sans rien bloquer d'autre.
                play_queue.queue_fill(state.STREAMING_MOOD, state.STREAMING_FORCE_GENRE,
                                      rebuild=False)
                _tprint("[streaming] file en preparation…")
                # Attendre plus longtemps (10s) pour laisser le temps a la reco
                # de revenir ; le stream continue sans interruption s'il y a un
                # titre en cours, sinon il patiente jusqu'a la prochaine iteration.
                state.STREAMING_SKIP.wait(10.0)
                continue
            _CURRENT = nxt
        # Pre-resout l'URL du titre a suivre pendant la lecture en cours.
        try:
            state._prefetch_exec.submit(prefetch_upcoming)
        except Exception:
            pass
        res = json.loads(play_music(nxt["video_id"]))
        if res.get("status") != "playing":
            TIMER_MSGS.put(f"  [STREAMING] echec lecture ({res.get('error', '?')}), suivant…")
            _CURRENT = None  # ne pas reboucler sur un titre qui ne demarre pas
            # Retire explicitement le titre de la timeline : sinon il disparait
            # silencieusement (ni joue, ni dans la file) et laisse un trou.
            play_queue.drop_from_timeline(nxt["video_id"])
            continue
        state.STREAMING_COUNT += 1
        t_title0 = time.perf_counter()
        TIMER_MSGS.put(f"  [STREAMING] Titre {state.STREAMING_COUNT}/∞ — {nxt.get('title', '')} — {nxt.get('channel', '')}")
        while state.STREAMING_MODE and not state.STREAMING_SKIP.is_set():
            if _stream_title_done():
                break
            # En pause, la garde de duree (horloge murale) ne doit pas faire avancer le flux.
            if not is_paused() and time.perf_counter() - t_title0 > state.STREAMING_MAX_TITLE_SECS:
                _tprint("streaming : duree max atteinte, suivant")
                break
            # Attente reveillable : un "Suivant" (STREAMING_SKIP) sort immediatement
            # au lieu d'attendre la fin du tick de 1s.
            state.STREAMING_SKIP.wait(1.0)
        skipped = state.STREAMING_SKIP.is_set()
        state.STREAMING_SKIP.clear()
        if skipped:
            _CURRENT = None  # un skip force le titre suivant, meme en repeat "one"
    TIMER_MSGS.put("  [STREAMING] arrêté.")


def autostart_stream(title: str, channel: str) -> str:
    """Demarre le flux infini dans le genre du titre qui vient d'etre lance.

    Appele par les points d'entree utilisateur (play_now/play_choice/POST play),
    jamais par le thread de streaming (zero recursion). Le genre est infere par
    Ollama (ou le mapping cure / le cache), puis passe en mood avec filtrage dur.

    Returns:
        JSON de start_streaming, ou {'status': 'no_genre'} si genre indetermine.
    """
    from services.genres import GENRE_LABELS, infer_genre_ollama
    with _AUTOSTART_LOCK:
        # Remplace tout flux en cours (nouvelle lecture = nouveau flux).
        # play_music a deja mis STREAMING_MODE=False : on force l'arret + join pour
        # eviter que l'ancien thread ne lance un titre apres notre demarrage.
        state.STREAMING_MODE = False
        state.STREAMING_SKIP.set()
        if state.STREAMING_THREAD is not None and state.STREAMING_THREAD.is_alive():
            state.STREAMING_THREAD.join(timeout=3)
        state.STREAMING_SKIP.clear()
        genre = infer_genre_ollama(title or "", channel or "")
        if genre not in GENRE_LABELS or genre == "autre":
            # Genre inconnu : flux sur l'historique, sans filtrage dur.
            return start_streaming(mood="", force_genre=False, wait_current=True)
        _tprint(f"[autostart] flux infini '{genre}' (depuis {title[:35]!r})")
        return start_streaming(mood=genre, force_genre=True, wait_current=True)


def _restart_loop(wait_current: bool = True):
    """Relance la boucle de streaming SANS reconstruire la file (saut dans la file).

    La file restante est conservee : le flux reprend la ou l'utilisateur l'a
    laissee. Le surveillant (queue.start_watchdog) la recharge si elle est basse.
    """
    global _CURRENT, _WAIT_CURRENT
    state.STREAMING_MODE = False
    state.STREAMING_SKIP.set()
    if state.STREAMING_THREAD is not None and state.STREAMING_THREAD.is_alive():
        state.STREAMING_THREAD.join(timeout=3)
    state.STREAMING_SKIP.clear()
    # Le titre qui vient d'etre lance (manuel, saute, "Previous") est la source
    # de verite du courant : on le conserve pour que repeat "one" s'applique a lui.
    _CURRENT = play_queue.current_track() if wait_current else None
    _WAIT_CURRENT = wait_current
    # Le flux adopte le contexte de la file (et non l'inverse) : une file
    # construite hors flux garde ainsi son genre si la boucle doit la recharger
    # (file vide) au lieu de repartir sur l'historique brut.
    state.STREAMING_MOOD, state.STREAMING_FORCE_GENRE = play_queue.current_mood()
    state.STREAMING_MODE = True
    state.STREAMING_COUNT = 0
    state.STREAMING_THREAD = threading.Thread(target=_streaming_loop, daemon=True,
                                              name="streaming")
    state.STREAMING_THREAD.start()


def jump_to_queue(index: int) -> str:
    """Joue un titre de la timeline et reprend l'enchainement.

    index > 0 : le `index`-ieme titre de la file (1-based). Les titres qui le
    precedent restent dans la timeline au lieu d'etre effaces.
    index < 0 : un titre deja passe, `-index` pas en arriere ; il est rejoue tout
    de suite et le reste de la file suit.
    Dans les deux cas le reste de la file est conserve (pas de reconstruction).
    Utilise par POST /api/stream/jump.
    """
    track = play_queue.queue_jump(index)
    if not track:
        if index < 0:
            return json.dumps(
                {"error": f"aucun titre a {-index} pas en arriere de l'historique."},
                ensure_ascii=False)
        return json.dumps(
            {"error": f"index {index} hors de la file (1-{play_queue.queue_remaining()})."},
            ensure_ascii=False)
    res = json.loads(play_music(track["video_id"]))
    if res.get("status") != "playing":
        # Le curseur a avance avant le son : si mpv refuse le flux, le titre
        # repasse en file plutot que de rester un "courant" que rien ne joue.
        play_queue.undo_jump(track)
        return json.dumps(res, ensure_ascii=False)
    _restart_loop(wait_current=True)
    return json.dumps(res, ensure_ascii=False)


def remove_queued(index: int) -> str:
    """Retire un titre a venir de la file (l'index est 1-based, cote titres a venir).

    Le titre en lecture et les titres deja joues ne sont jamais retires : la
    timeline ne perd donc aucune ligne avant le curseur.
    """
    nxt = play_queue.queue_remove(index)
    if not nxt:
        return json.dumps(
            {"error": f"index {index} hors de la file (1-{play_queue.queue_remaining()})."},
            ensure_ascii=False)
    return json.dumps({"status": "removed", "video_id": nxt.get("video_id", ""),
                       "title": nxt.get("title", ""),
                       "queue_remaining": play_queue.queue_remaining()}, ensure_ascii=False)


def start_streaming(mood: str = "", force_genre: bool = True,
                    wait_current: bool = False) -> str:
    """Lance le flux infini (thread de fond). Mood en RAM seule.

    Args:
        mood: Contexte (genre connu ou titre). Vide = historique.
        force_genre: Filtre dur par genre si `mood` est un genre connu.
        wait_current: Si True, attend la fin du titre deja en lecture avant de
            puiser dans la file (autostart apres une lecture utilisateur). Si
            False, la file demarre immediatement.
    Construit la file pre-calculee (N titres) avant de demarrer la lecture."""
    global _CURRENT, _WAIT_CURRENT
    mood = (mood or "").strip()
    if state.STREAMING_MODE and state.STREAMING_THREAD is not None and state.STREAMING_THREAD.is_alive():
        return json.dumps({"status": "already_streaming", "mood": state.STREAMING_MOOD,
                           "count": state.STREAMING_COUNT}, ensure_ascii=False)
    _CURRENT = play_queue.current_track() if wait_current else None  # titre deja en lecture
    _WAIT_CURRENT = bool(wait_current)
    # Construction en ARRIERE-PLAN : la reponse API ne l'attend pas. La boucle
    # consommera la file des qu'elle sera prete (ou attendra le titre en cours).
    play_queue.queue_fill(mood, force_genre, rebuild=True)
    state.STREAMING_MODE = True
    state.STREAMING_MOOD = mood
    state.STREAMING_FORCE_GENRE = bool(force_genre)
    state.STREAMING_COUNT = 0
    state.STREAMING_SKIP.clear()
    state.STREAMING_THREAD = threading.Thread(target=_streaming_loop, daemon=True,
                                              name="streaming")
    state.STREAMING_THREAD.start()
    return json.dumps({"status": "streaming_started", "mood": mood,
                       "force_genre": state.STREAMING_FORCE_GENRE,
                       "queue_size": play_queue.queue_remaining(),
                       # La file se construit en arriere-plan : taille encore basse.
                       "filling": play_queue.fill_in_progress()}, ensure_ascii=False)


def stop_streaming() -> str:
    """Stoppe le flux infini + coupe mpv + vide la timeline."""
    global _CURRENT, _WAIT_CURRENT
    was = state.STREAMING_MODE
    state.STREAMING_MODE = False
    state.STREAMING_SKIP.set()  # reveille la boucle d'attente
    _stop_player()
    # Fin de session : la timeline (joues + courant) est videe, l'UI n'affiche
    # plus d'etat fantome.
    play_queue.session_reset()
    _CURRENT = None
    _WAIT_CURRENT = False
    return json.dumps({"status": "streaming_stopped" if was else "not_streaming",
                       "played": state.STREAMING_COUNT}, ensure_ascii=False)


def play_previous() -> str:
    """Recule le curseur d'un cran dans la session, puis reprend l'enchainement.

    Le titre courant repasse "a venir" (un "Suivant" y revient) : c'est le meme
    deplacement de curseur que le clic sur un titre deja joue dans la timeline.
    """
    prev = play_queue.queue_jump(-1)
    if not prev:
        return json.dumps({"error": "Pas de titre precedent dans cette session."},
                          ensure_ascii=False)
    res = json.loads(play_music(prev["video_id"]))
    if res.get("status") != "playing":
        return json.dumps(res, ensure_ascii=False)
    _restart_loop(wait_current=True)
    return json.dumps(res, ensure_ascii=False)


def _log_skip():
    """Enregistre le skip du titre courant (dernier joue, deja sorti de la file)."""
    if not _db_ready():
        return
    from core import db as _db
    try:
        last = _db.db_get_history(1)
        if last:
            _db.db_log_skip(last[0]["video_id"])
    except Exception:
        pass


def skip_streaming() -> str:
    """Passe au titre suivant, que le flux infini tourne ou non.

    Avec flux : la boucle coupe le titre courant et enchaine immediatement.
    Sans flux (demarrage a froid, lecture isolee) : la file est la source de
    verite, donc on avance reellement et on relance l'enchainement — sans quoi
    « Suivant » ne ferait rien alors que le bouton est actif. Si la file est
    vide, on demande un remplissage et on le signale (succes, pas une erreur)
    pour que le client patiente le temps qu'elle se construise.
    """
    if state.STREAMING_MODE:
        _log_skip()
        state.STREAMING_SKIP.set()
        return json.dumps({"status": "skipped", "count": state.STREAMING_COUNT,
                           "queue_remaining": play_queue.queue_remaining()}, ensure_ascii=False)
    nxt = play_queue.queue_pop_next()
    if not nxt:
        mood, force = play_queue.current_mood()
        play_queue.queue_fill(mood, force, rebuild=False)
        _tprint("[skip] file vide : remplissage demande, le client patiente")
        return json.dumps({"status": "queue_filling", "queue_remaining": 0,
                           "filling": play_queue.fill_in_progress()}, ensure_ascii=False)
    # Le skip est loggue AVANT de lancer le titre suivant : play_music ecrit
    # l'historique, et c'est bien le titre quitte que l'on veut marquer.
    _log_skip()
    res = json.loads(play_music(nxt["video_id"]))
    if res.get("status") != "playing":
        # Le curseur avait avance avec la consommation : si mpv refuse le flux,
        # le titre repasse en file au lieu de rester un "courant" que rien ne joue.
        play_queue.undo_jump(nxt)
        return json.dumps(res, ensure_ascii=False)
    _restart_loop(wait_current=True)
    return json.dumps({"status": "skipped", "video_id": nxt.get("video_id", ""),
                       "title": nxt.get("title", ""),
                       "queue_remaining": play_queue.queue_remaining()}, ensure_ascii=False)


def set_shuffle(enabled: bool) -> str:
    """Active/desactive l'ordre aleatoire de la file (persiste entre les titres).

    A l'activation, l'ordre est **materialise** dans la file : la sequence
    affichee est exactement celle qui sera jouee ("suivant" avance lineairement).
    """
    state.SHUFFLE = bool(enabled)
    if state.SHUFFLE:
        play_queue.queue_apply_shuffle()
    return json.dumps({"status": "ok", "shuffle": state.SHUFFLE}, ensure_ascii=False)


def _cache_current_for_repeat():
    """Met le titre courant en cache RAM, pour le mode repeat « one ».

    Declenche uniquement ici (et non pour tous les titres) : seuls ceux que
    l'utilisateur repete valent un telechargement en memoire. Le remplissage est
    en tache de fond, donc la lecture en cours n'est pas retardee.
    """
    try:
        video_id = (_CURRENT or {}).get("video_id", "")
        if not video_id:
            # Titre lance hors boucle de flux (lecture manuelle) : on retombe sur
            # la derniere ecoute, qui est justement le titre courant.
            last = hist_read(1)
            video_id = last[0].get("video_id", "") if last else ""
        if not video_id or audiocache.has(video_id):
            return
        url = _resolve_audio_url(video_id)
        if url:
            audiocache.ensure_async(video_id, url)
    except Exception as exc:
        _tprint(f"[audiocache] mise en cache (repeat one) echouee : {exc}")


def set_repeat(mode: str) -> str:
    """Regle le mode de repetition : 'off' | 'all' | 'one'.

    'one' rejoue le titre courant a la fin (un skip force quand meme le suivant).
    Dans ce flux infini, 'all' se comporte comme 'off'.
    """
    if mode not in ("off", "all", "one"):
        return json.dumps({"error": f"mode repeat invalide '{mode}' (off|all|one)."}, ensure_ascii=False)
    state.REPEAT_MODE = mode
    if mode == "one":
        # Le titre va etre rejoue en boucle : on le garde en RAM des maintenant
        # pour que les passages suivants ne retéléchargent plus rien.
        _cache_current_for_repeat()
    return json.dumps({"status": "ok", "repeat": state.REPEAT_MODE}, ensure_ascii=False)
