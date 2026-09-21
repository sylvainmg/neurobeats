"""File de lecture pre-calculee (N titres) et rechargement anticipe.

La file est construite par lots via le moteur de recommandation, puis rechargée
en arriere-plan quand elle approche de la fin. Le contexte (mood) derive
progressivement : chaque nouveau lot est calcule a partir de la file courante et
du dernier titre joue, ce qui affine les recos au fil de l'usage.

Le rechargement est pilote par un surveillant (start_watchdog) qui verifie en
continu la taille de la file, plutot que par le seul evenement "pop".

Etat en RAM seule (perdu au redemarrage, comme le streaming).
"""
import json
import random
import threading
import time

from services import state
from services.state import _tprint

# File : titres a venir (le titre en cours de lecture n'y figure pas).
_QUEUE: list = []
_POSITION: int = 0            # nombre de titres deja consommes depuis la construction
_MOOD: str = ""
_FORCE_GENRE: bool = True
_LOCK = threading.Lock()
_REFILLING: bool = False
_FILL_STARTED: float = 0.0
# Date du dernier remplissage revenu vide (ou en echec) : sert de delai de
# respiration pour ne pas relancer YouTube/Ollama toutes les 5 s quand la reco
# ne trouve rien.
_FILL_LAST_FAILED: float = 0.0
# Jeton generationnel : chaque remplissage increment _FILL_GEN et ne peut ecrire
# dans la file que si son `gen` est encore le courant. Remplace l'ancien Event
# partage, dont le signal etait efface avant que le worker en cours ne le voie.
_FILL_GEN: int = 0
# Au-dela, un remplissage est considere perdu (worker disparu ou appel externe
# sans timeout) : on autorise un nouveau remplissage plutot que de rester fige.
FILL_TIMEOUT = 120.0
_WATCHDOG: threading.Thread | None = None
# Titres sortis de la file mais pas encore garantis dans l'historique. Le
# rechargement anticipe est declenche au pop, donc avant que play_music n'ait
# loggue le titre : sans ca, la reco pourrait le re-proposer et il figurerait a
# la fois "en cours" et "a venir" dans la file.
_RECENT: list = []
RECENT_KEEP = 5
# Pile des titres joues pendant la session (ordre chronologique), pour le bouton
# "Previous". Alimentee par play_music via record_played.
_HISTORY: list = []
HISTORY_KEEP = 50

QUEUE_TARGET = 10    # nombre de titres vises dans la file
QUEUE_REFILL_AT = 3  # seuil bas : recharge des qu'il reste <= ce nombre de titres
# Periode du surveillant : assez courte pour reagir vite, assez longue pour ne
# pas boucler sur la reco si un rechargement echoue instantanement (_REFILLING
# empeche deja deux rechargements concurrents).
WATCH_INTERVAL = 5
_FILL_MIN_INTERVAL = 3.0  # delai minimum entre deux remplissages
_FILL_BACKOFF = 30.0      # apres un remplissage vide/en echec, on laisse respirer
_BATCH = 5           # titres demandes par tour de reco (10 titres = 2 tours)
# Fenetre d'exclusion volontairement courte : le moteur de reco limite deja son
# propre "recent" a 20 titres. Exclure davantage vide la file quand la reco
# retombe sur l'historique (mode hors-ligne) -> plus rien a jouer, flux bloque.
EXCLUDE_RECENT = 20


_TIMELINE_PLAYED_MAX = 50  # bornage du prefixe "joue" expose a l'UI


def _say(msg: str):
    """Evenement de file visible sans TIMING.

    La construction de la file est un travail de fond, mais son *resultat*
    regarde l'utilisateur (« pourquoi un seul titre ? ») : on l'affiche donc
    toujours, contrairement aux details de progression. La duree depuis le debut
    du remplissage est jointe : sans elle, diagnostiquer « la file est lente »
    demandait d'instrumenter a la main.
    """
    dt = (time.time() - _FILL_STARTED) if _FILL_STARTED else 0.0
    suffix = f"  ({dt:.1f}s)" if dt else ""
    print(f"  [queue] {msg}{suffix}", flush=True)


def _note_fill_failed():
    """Marque un remplissage vide/en echec : le surveillant observe un delai."""
    global _FILL_LAST_FAILED
    with _LOCK:
        _FILL_LAST_FAILED = time.time()


def _timeline_played(hist: list) -> list:
    """Prefixe "joue" tel que l'UI le voit (borne a `_TIMELINE_PLAYED_MAX`)."""
    return hist[:-1][-_TIMELINE_PLAYED_MAX:]


def queue_snapshot() -> dict:
    """Timeline lineaire : titres joues + courant + titres a venir.

    `tracks` est la sequence complete (le titre en cours y figure, a l'index
    `current_index`) : l'UI n'a plus a recomposer courant + file, elle rend la
    timeline telle quelle. `remaining` reste le nombre de titres a venir.
    """
    with _LOCK:
        hist = [dict(t) for t in _HISTORY]
        upcoming = [dict(t) for t in _QUEUE]
        mood, force_genre, position, filling = _MOOD, _FORCE_GENRE, _POSITION, _REFILLING
    played = _timeline_played(hist)
    current = hist[-1] if hist else None
    tracks = played + ([current] if current else []) + upcoming
    return {
        "mood": mood,
        "force_genre": force_genre,
        "shuffle": state.SHUFFLE,
        "repeat": state.REPEAT_MODE,
        "remaining": len(upcoming),
        "position": position,
        "tracks": tracks,
        "current_index": (len(played) if current else -1),
        "filling": filling,
    }


def session_reset():
    """Nouvelle playlist : vide la file ET l'historique de session.

    Appele quand l'utilisateur lance un titre sans flux actif : la timeline
    repart de zero (aucun titre "joue" avant le nouveau), contrairement a une
    insertion en cours de lecture qui conserve le prefixe joue.
    """
    global _QUEUE, _POSITION, _MOOD, _FORCE_GENRE, _REFILLING, _RECENT, _HISTORY, _FILL_GEN
    with _LOCK:
        _FILL_GEN += 1          # invalide tout remplissage en vol
        _QUEUE = []
        _POSITION = 0
        _MOOD = ""
        _FORCE_GENRE = True
        _REFILLING = False
        _RECENT = []
        _HISTORY = []


def note_current(title: str):
    """Met a jour le contexte de derive apres une insertion manuelle.

    Le prochain refill s'appuiera sur le titre insere plutot que sur l'ancien.
    """
    global _MOOD
    with _LOCK:
        if title:
            _MOOD = title


def drop_from_timeline(video_id: str):
    """Retire un titre de la timeline avant de le (re)jouer.

    Evite les doublons quand un titre insere figure deja dans les titres a
    venir ou dans le prefixe joue.
    """
    if not video_id:
        return
    with _LOCK:
        _QUEUE[:] = [t for t in _QUEUE if t.get("video_id") != video_id]
        _HISTORY[:] = [t for t in _HISTORY if t.get("video_id") != video_id]


def queue_remaining() -> int:
    with _LOCK:
        return len(_QUEUE)


def current_mood() -> tuple[str, bool]:
    """Contexte de construction de la file courante : (mood, filtre genre dur).

    Distinct du mood du flux (`state.STREAMING_MOOD`) : une file construite hors
    flux infini doit pouvoir etre rechargee dans son propre contexte, sinon le
    rechargement repartirait sur l'historique brut et perdrait le genre.
    """
    with _LOCK:
        return _MOOD, _FORCE_GENRE


def current_track() -> dict | None:
    """Titre courant de la timeline (dernier joue), ou None.

    Source de verite du "courant", independante de l'origine (file, insertion
    manuelle, saut...) : sert au repeat "one" et a l'affichage.
    """
    with _LOCK:
        return dict(_HISTORY[-1]) if _HISTORY else None


def queue_apply_shuffle():
    """Materialise l'ordre aleatoire dans la file : l'affichage = la lecture.

    Melange les titres a venir ; le prefixe joue et le courant (dans `_HISTORY`)
    ne bougent pas. Une fois permutee, `queue_pop_next` avance lineairement, donc
    la file affichee correspond exactement a l'ordre joue.
    """
    with _LOCK:
        random.shuffle(_QUEUE)


def queue_clear_for_rebuild():
    """Vide la file et indique 'en construction' pour le skeleton UI.

    Appele synchronement quand l'utilisateur lance un nouveau titre :
    la file est videe et passe en filling=true immédiatement (<100ms).
    Le remplissage en arriere-plan (appele ensuite par start_streaming)
    repopule la file au fur et a mesure.
    """
    global _QUEUE, _POSITION, _REFILLING, _FILL_STARTED, _FILL_GEN
    with _LOCK:
        _FILL_GEN += 1          # invalide tout remplissage en vol (ancien contexte)
        _QUEUE = []
        _POSITION = 0
        _REFILLING = True
        _FILL_STARTED = time.time()


def _push_played(track: dict):
    """Ajoute un titre a la timeline de session (appelant : `_LOCK` tenu).

    Un titre ne figure qu'une fois dans la timeline : son occurrence precedente
    est retiree pour qu'il occupe sa *derniere* position de lecture. Sans cela,
    rejouer un titre — ou sauter par-dessus un titre deja joue — l'afficherait en
    double, une copie a cote du titre courant. Un doublon *consecutif* est ignore.
    """
    vid = (track or {}).get("video_id")
    if not vid:
        return
    if _HISTORY and _HISTORY[-1].get("video_id") == vid:
        return
    # Mutation en place : un reassignement creerait une variable locale.
    _HISTORY[:] = [t for t in _HISTORY if t.get("video_id") != vid]
    _HISTORY.append({"video_id": vid, "title": track.get("title", ""),
                     "channel": track.get("channel", ""),
                     "genre": track.get("genre", "autre")})
    del _HISTORY[:-HISTORY_KEEP]
    # Un titre qui vient d'etre joue n'a plus a rester programme : sans cela il
    # apparaitrait deux fois dans la timeline, joue *et* a venir.
    _QUEUE[:] = [t for t in _QUEUE if t.get("video_id") != vid]


def record_played(track: dict):
    """Empile un titre joue (session) pour le bouton "Previous" et la timeline."""
    if not (track or {}).get("video_id"):
        return
    with _LOCK:
        _push_played(track)


def queue_peek_history(count: int = 10) -> list:
    """Derniers titres joues, du plus recent au plus ancien (observabilite)."""
    with _LOCK:
        return [dict(t) for t in reversed(_HISTORY[-count:])]


def _consume_locked() -> dict | None:
    """Consomme le prochain titre et pose le curseur dessus (`_LOCK` tenu).

    Le retrait de la file et l'entree dans l'historique sont une seule operation :
    sinon le titre n'est ni joue ni a venir pendant la resolution de l'URL (~0.5s)
    et un instantane diffuse dans cet intervalle le fait disparaitre de la
    timeline — le saut visuel que l'on voit en sautant d'un titre a l'autre.
    """
    global _POSITION, _MOOD
    if not _QUEUE:
        return None
    track = _QUEUE.pop(0)
    _POSITION += 1
    # Derive progressive : le prochain lot s'appuiera sur ce titre.
    if track.get("title"):
        _MOOD = track["title"]
    if track.get("video_id"):
        _RECENT.append(track["video_id"])
        del _RECENT[:-RECENT_KEEP]
    _push_played(track)
    return track


def queue_pop_next() -> dict | None:
    """Retire et retourne le prochain titre, ou None si la file est vide.

    Met a jour le mood de derive (dernier titre joue) et declenche un
    rechargement anticipe si le seuil est atteint.
    """
    _maybe_refill()
    with _LOCK:
        track = _consume_locked()
    _maybe_refill()
    return track


def queue_jump(index: int) -> dict | None:
    """Deplace le curseur de lecture dans la timeline de session.

    index > 0 : le `index`-ieme titre a venir de la file (1-based). Les titres
    franchis deviennent "joues" : ils restent visibles au-dessus du curseur.

    index < 0 : `-index` pas en arriere, dans les titres deja joues. Le curseur
    recule sur le titre vise et **tout ce qui suivait redevient a venir**, dans
    l'ordre : rien n'est perdu, la lecture reprend depuis ce point.

    Retourne None si l'index ne correspond a aucun titre.
    """
    global _POSITION, _MOOD
    if index < 0:
        with _LOCK:
            # Meme timeline que celle affichee par l'UI (prefixe "joue" borne) :
            # sans cela un clic profond se decale quand l'historique la depasse.
            hist = [dict(t) for t in _HISTORY]
            timeline = _timeline_played(hist) + ([hist[-1]] if hist else [])
            position = len(timeline) - 1 + index
            if position < 0:
                return None
            target = dict(timeline[position])
            vid = target.get("video_id")
            # Un titre ne figure qu'une fois : l'occurrence est retrouvee par son
            # identifiant, pas par un index qui pourrait avoir bouge.
            at = next((i for i, t in enumerate(_HISTORY)
                       if t.get("video_id") == vid), None)
            if at is None:
                return None
            released = [dict(t) for t in _HISTORY[at + 1:]]
            del _HISTORY[at + 1:]
            released_ids = {t.get("video_id") for t in released}
            _QUEUE[:] = released + [t for t in _QUEUE
                                    if t.get("video_id") not in released_ids]
            # Ces titres ne sont plus consommes : le compteur redescend d'autant.
            _POSITION = max(0, _POSITION - len(released))
            if target.get("title"):
                _MOOD = target["title"]
        # play_music empilera ce titre : il est deja en fin d'historique, le
        # doublon consecutif est ignore et le curseur reste donc sur place.
        return target
    with _LOCK:
        if index < 1 or index > len(_QUEUE):
            return None
        # Chaque titre franchi passe par la meme consommation que la file : il
        # quitte la file et prend la place de "courant" dans la meme operation,
        # la timeline ne connait donc jamais de trou. Les titres franchis restent
        # affiches au-dessus du titre clique.
        target = None
        for _ in range(index):
            target = _consume_locked()
            if target is None:
                return None
    _maybe_refill()
    return target


def undo_jump(track: dict) -> None:
    """Annule un saut dont la lecture a echoue.

    Le curseur avance avant le demarrage du son : si mpv refuse le flux, le titre
    repasse en tete de file pour rester visible, au lieu de rester un "courant"
    que rien ne joue.
    """
    vid = (track or {}).get("video_id")
    if not vid:
        return
    with _LOCK:
        _HISTORY[:] = [t for t in _HISTORY if t.get("video_id") != vid]
        _QUEUE[:] = [t for t in _QUEUE if t.get("video_id") != vid]
        _QUEUE.insert(0, dict(track))


def queue_remove(index: int) -> dict | None:
    """Retire un titre a venir de la file (1-based), None si l'index est hors file.

    Le titre part aussi dans `_RECENT` : sans cela, la recolte suivante pourrait
    le reproposer aussitot — exactement ce que l'utilisateur vient d'ecarter.
    Le titre en lecture et les titres deja joues ne sont jamais touches : ils ne
    font pas partie de la file.

    La file est ensuite completee jusqu'a sa cible : le retrait se compense en
    arriere-plan (le nombre de titres presents fait foi), donc l'utilisateur
    garde le meme nombre de titres a venir sans attendre le seuil bas.
    """
    with _LOCK:
        if index < 1 or index > len(_QUEUE):
            return None
        track = _QUEUE.pop(index - 1)
        if track.get("video_id"):
            _RECENT.append(track["video_id"])
            del _RECENT[:-RECENT_KEEP]
    _maybe_refill(top_up=True)
    return track


def queue_peek_next() -> dict | None:
    """Prochain titre qui sera joue, sans le retirer (tete de file)."""
    with _LOCK:
        if not _QUEUE:
            return None
        return dict(_QUEUE[0])


def queue_peek_many(count: int = 2) -> list:
    """Les `count` premiers titres de la file, sans les retirer.

    Sert au prechargement : resoudre 2 URLs d'avance couvre un "Suivant" clique
    plus vite que la resolution yt-dlp (~2s). Sert aussi de garde-fou si le
    flux est en mode aleatoire (l'ordre ici n'est qu'indicatif).
    """
    with _LOCK:
        return [dict(t) for t in _QUEUE[:max(0, count)]]


def _excluded_ids() -> set:
    """video_ids a exclure d'une nouvelle recolte.

    On exclut tout ce qui figure DEJA dans la timeline affichee : titres a venir
    (`_QUEUE`), prefixe joue + courant (`_HISTORY`) et derniers titres sortis
    (`_RECENT`), plus la fenetre d'historique en base. Sans `_HISTORY`, un titre
    joue au-dela de la fenetre DB (20) pouvait etre re-propose et apparaitre deux
    fois dans la timeline (une fois "joue", une fois "a venir").
    """
    from services.db_access import hist_read
    try:
        recent = {h.get("video_id") for h in hist_read(EXCLUDE_RECENT)}
    except Exception:
        recent = set()
    with _LOCK:
        recent |= {t.get("video_id") for t in _QUEUE}
        recent |= {t.get("video_id") for t in _HISTORY}
        recent |= set(_RECENT)
    recent.discard(None)
    return recent


def _collect(gen: int, target: int, force_genre: bool, publish=None, base=None) -> list:
    """Recolte jusqu'a `target` titres via get_recommendation, sans doublons.

    Verifie le jeton de generation entre chaque round de reco : si un
    remplissage plus recent a demarre, on s'arrete. Les titres deja recoltes
    sont conserves (pas de perte).

    Args:
        gen: Jeton de generation du remplissage appelant.
        target: Nombre total de titres vises (base comprise).
        force_genre: Filtre genre dur transmis a la reco.
        publish: Rappel appele apres chaque round avec les titres accumules :
            la file se remplit au fur et a mesure au lieu d'attendre la fin.
        base: Titres deja recoltes que l'on poursuit (elargissement du vivier).
    """
    from services.recommendation import get_recommendation
    picked = list(base) if base else []
    seen = _excluded_ids() | {t.get("video_id") for t in picked}
    seen.discard(None)
    rounds = 0
    while len(picked) < target and rounds < target:
        if gen != _FILL_GEN:
            _tprint("[queue] reco arretee : generation remplacee")
            break
        rounds += 1
        # Un tour demande plusieurs titres : chaque tour a son propre cout fixe
        # (SQLite, Markov, RAG), donc moins de tours = file bien plus rapide.
        want = min(target - len(picked), _BATCH)
        try:
            data = json.loads(get_recommendation(_MOOD, force_genre_filter=force_genre,
                                                 count=want))
        except Exception as exc:
            _tprint(f"[queue] reco echec : {exc}")
            break
        recos = data.get("recommendations", []) if isinstance(data, dict) else []
        if not recos:
            break
        added = False
        for r in recos:
            vid = r.get("video_id")
            if not vid or vid in seen:
                continue
            seen.add(vid)
            picked.append({"video_id": vid, "title": r.get("title", ""),
                           "channel": r.get("channel", ""), "genre": r.get("genre", "autre")})
            added = True
            if len(picked) >= target:
                break
        if added and publish:
            publish(list(picked))
        if not added:
            break
    return picked


def _warm_urls(tracks: list):
    """Pre-resout en arriere-plan les URLs audio des titres de la file.

    On connait deja les titres a venir : autant resoudre leur URL tout de suite
    pour que `play_music` la trouve en cache (RAM + disque) quand le flux y
    arrive -> enchainement instantane, y compris sur un "Suivant" repete.

    Non bloquant : les resolutions partent sur le pool de prefetch (2 a la fois),
    le serveur travaille en fond sans retarder la lecture ni la reponse API.
    """
    from services.audio import _prefetch
    count = 0
    for track in tracks:
        vid = track.get("video_id")
        if not vid:
            continue
        try:
            _prefetch(vid)
            count += 1
        except Exception as exc:
            _tprint(f"[queue] warm url echec ({vid}) : {exc}")
    if count:
        _tprint(f"[queue] prechauffage de {count} URL(s) en arriere-plan")


def queue_build(gen: int, mood: str = "", force_genre: bool = True, target: int = QUEUE_TARGET):
    """Construit la file initiale (remplace l'ancienne) dans un contexte donne.

    N'ecrit la file que si `gen` est encore la generation courante : une
    construction remplacee (l'utilisateur a change de titre) est abandonnee sans
    toucher a la file en cours.

    La file est publiee **au fur et a mesure** des lots de reco : l'UI affiche
    les premiers titres sans attendre la fin de la construction.

    Args:
        gen: Jeton de generation du remplissage appelant.
        mood: Contexte de depart (genre connu ou titre). Vide = historique.
        force_genre: Filtrage genre dur si `mood` est un genre connu.
        target: Nombre de titres vises.
    """
    global _QUEUE, _POSITION, _MOOD, _FORCE_GENRE
    with _LOCK:
        if gen != _FILL_GEN:
            return
        _MOOD = (mood or "").strip()
        _FORCE_GENRE = bool(force_genre)

    def _publish(partial: list):
        """Ecrit la file au fur et a mesure : le client voit les titres arriver."""
        global _POSITION
        with _LOCK:
            if gen != _FILL_GEN:
                return
            # Mutation en place (pas de rebinding) : la file est lue en continu
            # par le snapshot pousse au client.
            _QUEUE[:] = partial
            _POSITION = 0
        # Latence percue : c'est ce lot que l'utilisateur voit apparaitre.
        _say(f"publie {len(partial)}/{target} titres")

    tracks = _collect(gen, target, force_genre, publish=_publish)
    if len(tracks) < target and force_genre and gen == _FILL_GEN:
        # Vivier trop maigre POUR CE GENRE : on complete sans filtre dur plutot
        # que de presenter une file a deux titres. Le mode degrade reste visible
        # dans le snapshot (`force_genre`). La recolte reprend sur la base deja
        # trouvee : un seul passage de plus, jamais deux recoltes completes.
        _say(f"vivier maigre en filtre dur ({len(tracks)}/{target}), "
             f"complement sans genre")
        tracks = _collect(gen, target, False, publish=_publish, base=tracks)
        with _LOCK:
            if gen == _FILL_GEN:
                _FORCE_GENRE = False
    with _LOCK:
        if gen != _FILL_GEN:
            _tprint("[queue] construction abandonnee (generation remplacee)")
            return
        _QUEUE = tracks
        _POSITION = 0
        count, force, mood_now = len(tracks), _FORCE_GENRE, _MOOD
    _say(f"file construite : {count}/{target} titres "
         f"(mood={mood_now[:30]!r}, force_genre={force})")
    if not count:
        # Reco muette : on laisse respirer le surveillant au lieu de relancer
        # YouTube/Ollama toutes les 5 s.
        _note_fill_failed()
    # Prechauffe les URLs des titres qu'on connait deja (en arriere-plan).
    _warm_urls(tracks)
    # Une file existe : on s'assure que le surveillant tourne (idempotent).
    start_watchdog()


def start_watchdog():
    """Demarre le surveillant de file (une seule instance, idempotent).

    Le surveillant recharge la file des qu'il reste <= QUEUE_REFILL_AT titres,
    quelle que soit la cause : avancement du flux, saut dans la file, file
    construite courte, mode aleatoire... Y compris file vide (sauter au dernier
    titre la vide : elle doit se recharger sans attendre la fin du morceau).
    """
    global _WATCHDOG
    if _WATCHDOG is not None and _WATCHDOG.is_alive():
        return
    _WATCHDOG = threading.Thread(target=_watchdog_loop, daemon=True,
                                 name="queue-watchdog")
    _WATCHDOG.start()
    _tprint("[queue] surveillant de file demarre")


def watchdog_alive() -> bool:
    """True si le surveillant de file tourne (observabilite /api/health)."""
    return _WATCHDOG is not None and _WATCHDOG.is_alive()


def _watchdog_loop():
    """Entretient la file, et relance l'enchainement s'il s'est arrete.

    Deux roles : recharger la file quand elle est basse, et rattraper une boucle
    de streaming morte alors que le flux est actif. Sans ce second filet, un
    thread disparu laissait la lecture s'arreter a la fin du titre courant —
    definitivement, puisque le mode flux restant vrai, plus rien ne relancait
    l'enchainement (et un nouveau demarrage etait refuse : « deja en streaming »).
    """
    while True:
        time.sleep(WATCH_INTERVAL)
        _maybe_refill()
        _revive_streaming()


def _revive_streaming():
    """Relance la boucle de streaming si le flux est actif mais la boucle morte."""
    if not state.STREAMING_MODE:
        return
    thread = state.STREAMING_THREAD
    if thread is not None and thread.is_alive():
        return
    # Import local : streaming importe deja queue (cycle, sinon).
    from services.streaming import _restart_loop
    _say("boucle de streaming morte : relance")
    _restart_loop(wait_current=False)


def _maybe_refill(top_up: bool = False):
    """Verifie si la file doit etre rechargée et le lance si necessaire.

    Point d'entree unique appele sur chaque mutation de la file (pop, jump,
    clear, build, retrait manuel). Le garde-fou `_REFILLING` empeche les doublons.

    La file est entretenue des qu'une session existe — un titre est charge, en
    lecture **ou en pause** — et non plus seulement pendant le flux infini :
    hors flux, rien ne la realimentait, donc « Suivant » finissait par trouver
    une file vide et le bouton se desactivait. Si rien n'est charge du tout, le
    rechargement est annule.

    Args:
        top_up: True pour completer jusqu'a QUEUE_TARGET sans attendre le seuil
            bas. C'est le cas apres un retrait manuel : la file doit retrouver
            la taille annoncee, pas rester amputee jusqu'a n'en avoir plus que
            QUEUE_REFILL_AT. Le nombre de titres reellement presents fait foi,
            la generation repart donc de ce qui reste.
    """
    global _REFILLING
    if not (state.STREAMING_MODE or state._now_playing):
        return
    with _LOCK:
        remaining = len(_QUEUE)
        stuck = _REFILLING and (time.time() - _FILL_STARTED) > FILL_TIMEOUT
        cooling = (time.time() - _FILL_LAST_FAILED) < _FILL_BACKOFF
        if stuck:
            # Un remplissage ne s'est pas termine dans les temps : on le considere
            # perdu pour ne pas rester fige (la file ne se rechargerait plus).
            _REFILLING = False
    if stuck:
        _tprint(f"[queue] remplissage bloque depuis > {FILL_TIMEOUT:.0f}s, reprise")
    if cooling:
        # Un remplissage vient d'echouer : inutile de relancer YouTube/Ollama
        # dans la foulee, on laisse respirer (`_FILL_BACKOFF`).
        return
    if top_up or remaining <= QUEUE_REFILL_AT:
        queue_fill(rebuild=False)


def queue_fill(mood: str = "", force_genre: bool = True, rebuild: bool = True) -> bool:
    """Lance en arriere-plan le remplissage de la file.

    Point d'entree unique du remplissage. Chaque appel incremente un jeton de
    generation : tout remplissage anterieur abandonne s'il n'est plus courant
    (annulation reelle, pas de drapeau efface trop tot). En rebuild, la file est
    videe immediatement pour que le skeleton s'affiche sans attendre.

    Args:
        mood: Contexte pour une construction (ignore en rechargement).
        force_genre: Filtre genre dur pour une construction (ignore en rechargement).
        rebuild: True (re)construit la file ; False la complete jusqu'a QUEUE_TARGET.

    Returns:
        True si un remplissage a ete planifie, False si un autre tournait deja
        (auquel cas la file se remplira quand meme).
    """
    global _REFILLING, _FILL_STARTED, _FILL_GEN, _QUEUE, _POSITION
    with _LOCK:
        if _REFILLING and not rebuild:
            return False
        _FILL_GEN += 1
        gen = _FILL_GEN
        _REFILLING = True
        _FILL_STARTED = time.time()
        if rebuild:
            # Vider immediatement : le skeleton s'affiche en <100ms, le
            # remplissage en arriere-plan remplit la file au fur et a mesure.
            _QUEUE = []
            _POSITION = 0
    threading.Thread(target=_fill_worker, args=(gen, mood, force_genre, rebuild),
                     daemon=True, name="queue-fill").start()
    return True


def fill_in_progress() -> bool:
    """True si un remplissage de file est en cours."""
    with _LOCK:
        return _REFILLING


def _fill_worker(gen: int, mood: str, force_genre: bool, rebuild: bool):
    """Travail de fond : (re)construit ou complete la file, puis prechauffe les URLs.

    Le worker porte sa generation : il abandonne ses ecritures si un remplissage
    plus recent l'a remplace, et ne remet `_REFILLING` a False que s'il est
    toujours le remplissage courant (sinon il ecraserait l'etat du nouveau).
    """
    global _REFILLING
    try:
        if gen != _FILL_GEN:
            _tprint("[queue] remplissage abandonne avant demarrage")
            return
        if rebuild:
            queue_build(gen, mood, force_genre)
        else:
            _do_refill(gen)
    except Exception as exc:
        _say(f"remplissage echec : {exc}")
        _note_fill_failed()
    finally:
        with _LOCK:
            if gen == _FILL_GEN:
                _REFILLING = False


def _do_refill(gen: int):
    """Ajoute des titres a la suite de la file jusqu'a QUEUE_TARGET.

    Comme `queue_build`, la file est enrichie au fur et a mesure des lots : les
    nouveaux titres apparaissent sans attendre la fin du rechargement.

    Si le filtre dur ne ramene rien (vivier du genre epuise : la reco ne propose
    plus que des titres deja ecartes), on elargit comme a la construction — la
    file ne doit jamais rester vide.
    """
    global _FORCE_GENRE
    with _LOCK:
        if gen != _FILL_GEN:
            return
        need = QUEUE_TARGET - len(_QUEUE)
        force = _FORCE_GENRE
        before = len(_QUEUE)
    if need <= 0:
        return

    added_tracks: list = []

    def _publish(partial: list):
        """Ajoute les titres pas encore presents (publication progressive)."""
        with _LOCK:
            if gen != _FILL_GEN:
                return
            existing = {t.get("video_id") for t in _QUEUE}
            fresh = [t for t in partial if t.get("video_id") not in existing]
            if not fresh:
                return
            if state.SHUFFLE:
                # Les nouveaux titres suivent l'ordre aleatoire, comme le reste.
                random.shuffle(fresh)
            _QUEUE.extend(fresh)
            added_tracks.extend(fresh)
            total = len(_QUEUE)
        # Latence percue : c'est ce lot que l'utilisateur voit apparaitre.
        _say(f"refill publie {total}/{QUEUE_TARGET} titres")

    tracks = _collect(gen, need, force, publish=_publish)
    with _LOCK:
        if gen != _FILL_GEN:
            _tprint("[queue] refill abandonne (generation remplacee)")
            return
        # La file a pu etre remplie par la publication progressive : on mesure
        # ce qui a reellement ete ajoute, sans reecrire (pas de doublon).
        total = len(_QUEUE)
        added = total - before

    if not added and force:
        # Vivier du genre epuise : la reco ne sait plus proposer que des titres
        # que `_collect` rejette (retires de la file via `_RECENT`, ou deja
        # joues). Sans cette escalade la file resterait vide indefiniment, alors
        # qu'un complement sans filtre dur trouve toujours de quoi la remplir.
        _say(f"vivier epuise en filtre dur ({total}/{QUEUE_TARGET}), "
             f"complement sans genre")
        tracks = _collect(gen, need, False, publish=_publish)
        with _LOCK:
            if gen != _FILL_GEN:
                _tprint("[queue] refill abandonne (generation remplacee)")
                return
            total = len(_QUEUE)
            added = total - before
        if added:
            # Mode degrade assume pour la suite : inutile de repayer a chaque
            # refill un premier passage dur qu'on sait sterile (`force_genre`
            # reste visible dans le snapshot).
            with _LOCK:
                if gen == _FILL_GEN:
                    _FORCE_GENRE = False

    _say(f"refill +{added} -> {total} titres")
    if not added:
        # Reco muette : on laisse respirer le surveillant plutot que de relancer
        # YouTube/Ollama toutes les 5 s.
        _note_fill_failed()
        return
    _warm_urls(added_tracks)  # prechauffe les nouveaux titres
