"""Audio : daemon mpv IPC, resolution d'URL, lecture, prefetch, arret."""
import json
import os
import socket
import subprocess
import threading
import time

from yt_dlp import YoutubeDL

from core.config import (
    TIMING, MPV_BASE_ARGS, STREAM_CACHE_PATH, STREAM_CACHE_TTL,
    YDL_AUDIO_OPTS, YDL_CLIENT_SETS, VIDEO_ID_RE,
)
from services import audiocache, state
from services.db_access import _meta, hist_append, hist_read
from services.genres import _genre_of, infer_genre_ollama
from services.state import (
    _cache_lock, _drain_timer_msgs, _now_ms, _tprint, _watch_first_second,
    load_json, save_json, TIMER_MSGS,
)


# Serialise la preparation (plusieurs clients web peuvent se connecter ensemble).
_PREPARE_LOCK = threading.Lock()

# Borne du cache de resolutions prefetchees (futurs non consommes purges au-dela).
_PREFETCH_CACHE_MAX = 64

# mpv accepte un `loadfile` (reponse "success") puis peut echouer en silence :
# on verifie que la lecture a REELLEMENT demarre avant d'annoncer "playing".
PLAY_START_TIMEOUT = 3.0

# Le genre ne sert qu'a l'historique et aux stats : il ne doit jamais retarder le
# son. On l'inference donc en parallele du demarrage, et on ne l'attend qu'au
# moment de l'ecrire. Passe ce delai (inference anormalement lente), on ecrit un
# genre provisoire et l'inference continue en tache de fond : elle remplira le
# cache pour la prochaine lecture.
GENRE_WAIT_SECS = 2.0


class _GenreJob:
    """Inference du genre lancee en tache de fond (jamais sur le chemin du son).

    Le titre et l'artiste sont connus immediatement ; seul le genre demande un
    appel au modele. On le lance des l'entree dans `play_music` : le temps de
    resolution de l'URL et de demarrage de mpv couvre generalement l'inference,
    donc l'attente finale est nulle. Le repli (`_genre_of`) n'est qu'un filet.
    """

    def __init__(self, title: str, channel: str):
        self._channel = channel
        self._done = threading.Event()
        self._genre = ""
        threading.Thread(target=self._run, args=(title, channel),
                         daemon=True, name="genre").start()

    def _run(self, title: str, channel: str):
        try:
            self._genre = infer_genre_ollama(title, channel)
        except Exception:
            self._genre = ""
        finally:
            self._done.set()

    def genre(self, timeout: float | None = None) -> str:
        """Genre infere, ou repli immediat si l'inference est trop lente."""
        delay = GENRE_WAIT_SECS if timeout is None else timeout
        if not self._done.wait(delay):
            fallback = _genre_of(self._channel)
            _tprint(f"[genre] inference > {delay}s, provisoire '{fallback}' "
                    f"(elle aboutira en tache de fond)")
            return fallback
        return self._genre or _genre_of(self._channel)


def _wait_playback_started(candidate: str, timeout: float = PLAY_START_TIMEOUT) -> bool:
    """True si mpv joue bien le flux demande.

    `loadfile` est asynchrone : il repond "success" meme pour une URL illisible.
    On verifie donc que mpv n'est plus idle, que le media charge correspond bien
    a `candidate` et qu'une duree (ou position) est connue. Sans cela on
    annoncerait un titre fantome (affiche mais jamais joue).
    """
    deadline = time.perf_counter() + timeout
    key = candidate[:120]
    while time.perf_counter() < deadline:
        idle = _ipc_send(["get_property", "idle-active"], timeout=1.0)
        if idle and idle.get("error") == "success" and idle.get("data") is False:
            path = _ipc_send(["get_property", "path"], timeout=1.0)
            loaded = path.get("data") if path and path.get("error") == "success" else None
            if isinstance(loaded, str) and (loaded == candidate or loaded.startswith(key)):
                dur = _ipc_send(["get_property", "duration"], timeout=1.0)
                pos = _ipc_send(["get_property", "time-pos"], timeout=1.0)
                has_dur = bool(dur and dur.get("error") == "success" and dur.get("data"))
                has_pos = bool(pos and pos.get("error") == "success" and pos.get("data") is not None)
                if has_dur or has_pos:
                    return True
        time.sleep(0.1)
    return False


def _load_stream_cache():
    """Charge le cache disque en RAM en ignorant les entrees expirees (TTL 5h)."""
    data = load_json(STREAM_CACHE_PATH, {})
    now = time.time()
    state.STREAM_CACHE = {vid: e for vid, e in data.items()
                          if isinstance(e, dict) and e.get("url") and now - e.get("ts", 0) < STREAM_CACHE_TTL}


def _save_stream_cache():
    save_json(STREAM_CACHE_PATH, state.STREAM_CACHE)


def invalidate_stream_url(video_id: str):
    """Retire une URL du cache (RAM + disque) apres un echec de lecture.

    Les URLs YouTube expirent avant le TTL : sans invalidation, un titre peut
    rester definitivement illisible. Appele quand `loadfile` echoue.
    """
    if not video_id:
        return
    with _cache_lock:
        state.STREAM_CACHE.pop(video_id, None)
    try:
        _save_stream_cache()
    except Exception:
        pass


def _resolve_audio_url(video_id: str) -> str | None:
    """URL audio directe selon classe reseau (D). Tente les jeux de clients en ordre,
    loggue [quality] itag/abr/codec reels. Cache RAM+disque, None si echec."""
    with _cache_lock:
        entry = state.STREAM_CACHE.get(video_id)
        if isinstance(entry, dict) and entry.get("url"):
            return entry["url"]
    url = f"https://www.youtube.com/watch?v={video_id}"
    for clients in YDL_CLIENT_SETS:
        opts = dict(YDL_AUDIO_OPTS)
        opts["extractor_args"] = {"youtube": {"player_client": clients, "skip": ["hls"]}}
        try:
            with YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)
            if info and info.get("url"):
                with _cache_lock:
                    # La duree est mise en cache avec l'URL : elle sert de repli
                    # quand mpv ne la rapporte pas encore (fichier en cours de
                    # chargement), evitant que la barre de progression se recadre.
                    state.STREAM_CACHE[video_id] = {
                        "url": info["url"],
                        "ts": time.time(),
                        "duration": info.get("duration"),
                    }
                try:
                    _save_stream_cache()
                except Exception:
                    pass
                _tprint(f"[quality] {video_id} classe={state.NET_QUALITY} "
                        f"itag={info.get('format_id')} abr={info.get('abr')} "
                        f"codec={info.get('acodec')} ext={info.get('ext')} "
                        f"clients={clients[0]}")
                return info["url"]
        except Exception as exc:
            _tprint(f"[quality] clients={clients[0]} echec : {str(exc)[:100]}")
            continue
    return None


def _prefetch(video_id: str):
    """Pre-resout l'URL audio en arriere-plan (N+1 pendant la lecture de N).

    Le cache de futurs est borne : on purge les resolutions deja terminees et
    jamais consommees (titre finalement non joue) pour eviter l'accumulation.
    """
    cache = state._prefetch_cache
    fut = cache.get(video_id)
    if fut is None or fut.done():
        cache[video_id] = state._prefetch_exec.submit(_resolve_audio_url, video_id)
        if len(cache) > _PREFETCH_CACHE_MAX:
            for vid in [v for v, f in cache.items() if f.done() and v != video_id]:
                cache.pop(vid, None)
                if len(cache) <= _PREFETCH_CACHE_MAX:
                    break


def _take_prefetch(video_id: str, wait: float = 0.0) -> str | None:
    """Recupere l'URL pre-resolue, ou None.

    Args:
        video_id: Titre dont on veut l'URL.
        wait: Si > 0 et que la resolution est encore en cours, l'attend (bornee)
            au lieu de laisser l'appelant en lancer une seconde en parallele.
            C'est ce qui rend un "Suivant" rapide : on recupere la resolution
            deja engagee au lieu de repartir sur ~2s de yt-dlp.
    """
    fut = state._prefetch_cache.pop(video_id, None)
    if fut is None:
        return None
    try:
        return fut.result(timeout=0 if fut.done() else wait)
    except Exception:
        return None


def _ipc_send(cmd: list, timeout: float = 5.0) -> dict | None:
    """Envoie une commande JSON-IPC au daemon mpv, retourne la reponse {error, data, request_id}."""
    with state._mpv_ipc_lock:
        state._mpv_ipc_seq += 1
        rid = state._mpv_ipc_seq
        payload = json.dumps({"command": cmd, "request_id": rid}) + "\n"
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(timeout)
        s.connect(state._MPV_SOCK)
        try:
            s.sendall(payload.encode())
            buf = b""
            while b"\n" not in buf:
                chunk = s.recv(4096)
                if not chunk:
                    break
                buf += chunk
        finally:
            s.close()
        for line in buf.decode(errors="replace").splitlines():
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get("request_id") == rid or "error" in msg:
                return msg
    except (OSError, socket.timeout):
        return None
    return None


def _mpv_ready() -> bool:
    """True si le daemon mpv est vivant (IPC disponible)."""
    return state._mpv_daemon is not None and state._mpv_daemon.poll() is None


def _ensure_daemon() -> bool:
    """Lance le daemon mpv persistant si absent. Retourne True si le socket repond."""
    if state._mpv_daemon is not None and state._mpv_daemon.poll() is None:
        if _ipc_send(["get_property", "mpv-version"], timeout=2.0):
            return True
    _shutdown_daemon()
    try:
        if os.path.exists(state._MPV_SOCK):
            os.unlink(state._MPV_SOCK)
    except OSError:
        pass
    try:
        state._mpv_daemon = subprocess.Popen(
            MPV_BASE_ARGS + ["--idle=yes", f"--input-ipc-server={state._MPV_SOCK}",
                             "--prefetch-playlist=yes", "--gapless-audio=yes"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except FileNotFoundError:
        state._mpv_daemon = None
        return False
    for _ in range(50):  # ~5s max d'attente du socket
        if _ipc_send(["get_property", "mpv-version"], timeout=1.0):
            return True
        if state._mpv_daemon.poll() is not None:
            break
        time.sleep(0.1)
    return False


def _shutdown_daemon():
    old, state._mpv_daemon = state._mpv_daemon, None
    if old is not None and old.poll() is None:
        try:
            _ipc_send(["quit"], timeout=1.0)
        except Exception:
            pass
        try:
            old.wait(timeout=1)
        except subprocess.TimeoutExpired:
            old.kill()


def _ipc_event_loop():
    """Boucle d'events du daemon : detecte le 1er son via property time-pos (poll 100ms).
    Pousse le chrono dans TIMER_MSGS (affiche par _drain_timer_msgs, jamais pendant input())."""
    while True:
        time.sleep(0.1)
        if state._mpv_daemon is None or state._mpv_daemon.poll() is not None:
            return
        if not state._mpv_timing["gen"] or state._mpv_timing["found"] or not state._now_playing:
            continue
        if _now_ms() - state._mpv_timing["t_stream"] > 20:
            state._mpv_timing["found"] = True
            TIMER_MSGS.put("  ⏱ Aucun son détecté après 20s (daemon mpv silencieux)")
            continue
        resp = _ipc_send(["get_property", "time-pos"], timeout=2.0)
        if not resp or resp.get("error") != "success":
            continue
        pos = resp.get("data")
        if isinstance(pos, (int, float)) and pos >= 1.0:
            state._mpv_timing["found"] = True
            total = _now_ms() - state._mpv_timing["t_stream"]
            TIMER_MSGS.put(
                f"  ⏱ Premier son audible en {total:.1f}s "
                f"(résolution {state._mpv_timing['resolve']:.1f}s + mpv→son {total - state._mpv_timing['resolve']:.1f}s)")


def _stop_player():
    state._now_playing = False
    if state._mpv_daemon is not None and state._mpv_daemon.poll() is None:
        _ipc_send(["stop"], timeout=2.0)  # daemon : stop sans tuer (reste chaud)
        return
    old, state._player = state._player, None  # libere la reference : le prochain play ne bloque pas
    if old is not None:
        try:
            if old.poll() is None:
                old.terminate()
                try:
                    old.wait(timeout=1)  # delai court : on ne bloque pas le demarrage
                except subprocess.TimeoutExpired:
                    old.kill()
        finally:
            # Ferme les pipes eventuels (mode TIMING) pour eviter les fd leaks
            for stream in (getattr(old, "stdout", None), getattr(old, "stderr", None)):
                try:
                    if stream is not None:
                        stream.close()
                except Exception:
                    pass


def _cached_candidate(video_id: str, stream_url: str) -> str:
    """URL a donner a mpv : le cache RAM s'il contient le titre, sinon le reseau.

    C'est aussi le moment ou l'on met en cache un titre que l'utilisateur repete
    (repeat « one ») : le telechargement se fait en tache de fond, donc le passage
    en cours n'est pas retarde et le suivant sera servi depuis la RAM.
    """
    if audiocache.has(video_id):
        audiocache.touch(video_id)
        return audiocache.local_url(video_id)
    if state.REPEAT_MODE == "one":
        audiocache.ensure_async(video_id, stream_url)
    return stream_url


def play_music(video_id: str, autoplay: bool = True, log: bool = True) -> str:
    """Joue une video YouTube via le daemon mpv (fallback : process mpv direct).

    Args:
        video_id: Identifiant YouTube (11 caracteres) issu d'un tool du moteur.
        autoplay: False charge le titre dans mpv mais reste EN PAUSE (aucun son
            tant que l'utilisateur n'a pas repris) — utilise par prepare_playback.
        log: False n'ecrit pas d'ecoute dans l'historique (preparation : le titre
            n'a pas vraiment ete ecoute, on ne pollue pas les stats/recos).

    Returns:
        JSON {status: 'playing', paused, video_id, title, channel} ou {error}.

    Notes:
        - Une lecture manuelle pendant un flux infini arrete le flux.
        - Le video_id doit provenir de search_music / get_recommendation ; il est
          jamais invente.
    """
    if not isinstance(video_id, str) or not VIDEO_ID_RE.match(video_id):
        return json.dumps({"error": f"video_id invalide '{video_id}'. Appelle d'abord search_music et utilise un video_id retourne par le tool."}, ensure_ascii=False)
    meta = state.LAST_SEARCH.get(video_id) or _meta(video_id)
    if meta is None:
        return json.dumps({"error": f"video_id '{video_id}' inconnu. Appelle d'abord search_music, n'invente jamais d'ID."}, ensure_ascii=False)
    # Genre en tache de fond : il ne sert qu'a l'historique et aux stats, la
    # lecture ne l'attend donc pas (elle l'aura presque toujours deja, le temps
    # de resoudre l'URL et de demarrer mpv).
    genre_job = _GenreJob(meta.get("title", ""), meta.get("channel", ""))
    if state.STREAMING_MODE and threading.current_thread().name != "streaming":
        # Une lecture manuelle interrompt le flux infini (les deux ne cohabitent pas).
        state.STREAMING_MODE = False
        state.STREAMING_SKIP.set()
        TIMER_MSGS.put("  [STREAMING] interrompu par lecture manuelle.")
    _drain_timer_msgs()
    # Voie rapide : daemon mpv persistant (IPC), AO/TLS deja chauds.
    if _ensure_daemon():
        page_url = f"https://www.youtube.com/watch?v={video_id}"
        print("  … connexion au flux audio", flush=True)
        t_stream_start = _now_ms()
        entry = state.STREAM_CACHE.get(video_id)
        from_cache = isinstance(entry, dict) and bool(entry.get("url"))
        stream_url = _take_prefetch(video_id, wait=1.5) or _resolve_audio_url(video_id) or page_url
        resolve_dur = _now_ms() - t_stream_start
        _tprint(f"resolution flux audio : {resolve_dur:.1f}s{' (cache)' if from_cache and stream_url != page_url else ''}")
        retried = False
        candidate = _cached_candidate(video_id, stream_url)
        resp = None
        if not autoplay:
            # Pause posee AVANT le chargement : mpv conserve la propriete au
            # changement de fichier. Sans cela, un titre prepare s'entendait le
            # temps que la lecture demarre puis qu'on la mette en pause (fenetre
            # audible au demarrage, contraire a un demarrage silencieux).
            _ipc_send(["set_property", "pause", True], timeout=2.0)
        while True:
            print("  … lancement du son", flush=True)
            resp = _ipc_send(["loadfile", candidate, "replace"], timeout=10.0)
            # `loadfile` repond "success" meme si le flux est illisible : on
            # confirme que mpv joue bien CE flux avant d'annoncer "playing".
            if resp and resp.get("error") == "success" and _wait_playback_started(candidate):
                # mpv conserve la propriete "pause" au changement de fichier : on la
                # fixe explicitement (leve pour un nouveau titre a jouer, pose quand
                # on prepare un titre en attente de reprise).
                _ipc_send(["set_property", "pause", not autoplay], timeout=2.0)
                state._mpv_timing.update({"gen": state._mpv_timing["gen"] + 1, "t_mpv": _now_ms(),
                                          "t_stream": t_stream_start, "resolve": resolve_dur, "found": False})
                state._now_playing = True
                state._player_t0 = t_stream_start
                title, channel = meta.get("title", ""), meta.get("channel", "")
                print(f"\n  ▶ {'Préparé (pause)' if not autoplay else 'Lecture'} : {title} — {channel}\n")
                _p_genre = genre_job.genre()
                from services.queue import record_played
                record_played({"video_id": video_id, "title": title,
                               "channel": channel, "genre": _p_genre})
                if log:
                    hist_append(video_id, title, channel, meta.get("duration"), _p_genre)
                _maybe_prefetch_next(video_id)
                return json.dumps({"status": "playing", "paused": not autoplay,
                                   "video_id": video_id, "title": title,
                                   "channel": channel}, ensure_ascii=False)
            # Echec : URL cachee probablement expiree, ou chargement supplante.
            # On invalide et on re-resout une seule fois avant le process direct.
            if retried or candidate == page_url:
                break
            _tprint(f"daemon mpv : flux non demarre ({resp}), nouvelle resolution")
            invalidate_stream_url(video_id)
            retried = True
            fresh = _resolve_audio_url(video_id)
            if not fresh:
                break
            candidate = fresh
        _tprint(f"daemon mpv loadfile echec ({resp}), fallback spawn direct")
    # Repli : un process mpv dedie (si le daemon n'est pas disponible).
    _stop_player()
    page_url = f"https://www.youtube.com/watch?v={video_id}"
    print("  … connexion au flux audio", flush=True)
    t_stream_start = time.perf_counter()
    entry = state.STREAM_CACHE.get(video_id)
    from_cache = isinstance(entry, dict) and bool(entry.get("url"))
    stream_url = _cached_candidate(video_id, _resolve_audio_url(video_id) or page_url)
    resolve_dur = time.perf_counter() - t_stream_start
    _tprint(f"resolution flux audio : {resolve_dur:.1f}s{' (cache)' if from_cache and stream_url != page_url else ''}")
    print("  … lancement du son", flush=True)
    try:
        t_mpv_start = time.perf_counter()
        args = MPV_BASE_ARGS if not TIMING else [a for a in MPV_BASE_ARGS if a != "--really-quiet"]
        if not autoplay:
            args = args + ["--pause=yes"]  # repli : demarre en pause comme le daemon
        state._player = subprocess.Popen(
            args + [stream_url],
            stdout=subprocess.PIPE,  # toujours pipe : le thread timer draine + detecte le 1er son
            stderr=subprocess.STDOUT,  # statuts A:.. sur stdout (--msg-level=all=status garde le silence console)
            text=False,
            bufsize=0,
        )
        state._player_t0 = t_mpv_start
        _tprint(f"mpv demarre en {time.perf_counter() - t_mpv_start:.2f}s — attente du son…")
        if state._player.stdout is not None:
            state._player.read = state._player.stdout.read  # le thread timer lit la sortie mpv via proc.read()
            threading.Thread(target=_watch_first_second,
                             args=(state._player, t_mpv_start, t_stream_start, resolve_dur),
                             daemon=True).start()
    except FileNotFoundError:
        state._player = None
        return json.dumps({"error": "mpv introuvable. Installe mpv pour le streaming audio."}, ensure_ascii=False)
    except Exception as exc:
        state._player = None
        return json.dumps({"error": f"Echec lancement mpv : {exc}"}, ensure_ascii=False)
    title, channel = meta.get("title", ""), meta.get("channel", "")
    print(f"\n  ▶ {'Préparé (pause)' if not autoplay else 'Lecture'} : {title} — {channel}\n")
    _p_genre = genre_job.genre()
    from services.queue import record_played
    record_played({"video_id": video_id, "title": title,
                   "channel": channel, "genre": _p_genre})
    if log:
        hist_append(video_id, title, channel, meta.get("duration"), _p_genre)
    _maybe_prefetch_next(video_id)
    return json.dumps({"status": "playing", "paused": not autoplay,
                       "video_id": video_id, "title": title,
                       "channel": channel}, ensure_ascii=False)


def _maybe_prefetch_next(current_id: str):
    """Prefetch N+1 : dernier resultat de recherche non joue, sinon 1re reco non ecoutee."""
    try:
        for vid in list(state.LAST_SEARCH):
            if vid != current_id:
                _prefetch(vid)
                return
    except Exception:
        pass


def play_choice(index: int) -> str:
    """Joue le N-ieme resultat (1-based) de la derniere recherche LAST_SEARCH.
    A utiliser quand l'utilisateur repond par un numero ('le 1', '2', 'premier'...).
    Demarre ensuite le flux infini (auto-streaming) dans le genre du titre."""
    try:
        idx = int(index) - 1
    except (TypeError, ValueError):
        return json.dumps({"error": f"index '{index}' invalide. Donne un numero entre 1 et {len(state.LAST_SEARCH)}."}, ensure_ascii=False)
    vids = list(state.LAST_SEARCH.keys())
    if not vids:
        return json.dumps({"error": "Aucune recherche recente. Appelle d'abord search_music."}, ensure_ascii=False)
    if idx < 0 or idx >= len(vids):
        return json.dumps({"error": f"index {index} hors limites (1-{len(vids)}).", "options": list(state.LAST_SEARCH.values())}, ensure_ascii=False)
    video_id = vids[idx]
    res = json.loads(play_music(video_id))
    if res.get("status") == "playing":
        _autostart_after_play(res.get("title", ""), res.get("channel", ""))
    return json.dumps(res, ensure_ascii=False)


def _autostart_after_play(title: str, channel: str):
    """Declenche le flux infini en arriere-plan apres une lecture utilisateur.

    L'inference de genre (Ollama) et la construction de la file sont lentes :
    les faire ici evite que POST /api/play (ou /play_now, /play_choice) ne les
    attende. L'utilisateur entend son titre des que mpv l'a charge.

    En cas d'echec (genre indisponible, Ollama down, lock), on force quand meme
    un rebuild de la file pour que les recommendations suivantes changent.
    """
    def _run():
        try:
            from services.streaming import autostart_stream
            _tprint(f"[autostart] {autostart_stream(title, channel)[:80]}")
        except Exception as exc:
            _tprint(f"[autostart] echec : {exc} — fallback rebuild")
            from services import queue as play_queue
            play_queue.queue_fill(state.STREAMING_MOOD or "",
                                  state.STREAMING_FORCE_GENRE, rebuild=True)

    threading.Thread(target=_run, daemon=True, name="autostart").start()


def play_and_stream(video_id: str) -> str:
    """Joue un titre PUIS (re)lance le flux infini (point d'entree utilisateur).

    - Flux deja actif : le titre est insere JUSTE APRES le courant (il joue
      immediatement) ; le prefixe deja joue reste a sa place, jamais rejoue ni
      deplace. La file demeure strictement lineaire : [a, d, b, c].
    - Aucun flux : nouvelle playlist, la timeline repart de zero, puis la file
      se construit en arriere-plan.
    """
    from services import queue as play_queue
    from services.streaming import _restart_loop, start_streaming

    was_streaming = bool(state.STREAMING_MODE)
    if was_streaming:
        # Un titre insere peut deja figurer dans la timeline : on l'en retire
        # pour ne pas le dupliquer ([a, d, b, d, c]).
        play_queue.drop_from_timeline(video_id)
    else:
        play_queue.session_reset()

    res = json.loads(play_music(video_id))
    if res.get("status") != "playing":
        return json.dumps(res, ensure_ascii=False)

    if was_streaming:
        # Le titre joue deja (play_music l'a charge) et figure en fin de
        # _HISTORY, donc juste apres le courant : la timeline est a jour.
        play_queue.note_current(res.get("title", ""))
        _restart_loop(wait_current=True)
    else:
        play_queue.queue_clear_for_rebuild()
        def _start():
            start_streaming(mood="", force_genre=False, wait_current=True)
        threading.Thread(target=_start, daemon=True).start()

    return json.dumps(res, ensure_ascii=False)


def _prefill_queue():
    """Construit la file en tache de fond — sans rien lire.

    Le remplissage habituel est reserve au mode streaming (`_maybe_refill` sort
    quand rien n'est charge) : hors flux, la file resterait vide et l'utilisateur
    ne verrait qu'un seul titre. On la prepare donc ici — au demarrage du serveur
    puis a l'ouverture du client — pour que la file soit deja prete quand il
    regarde son ecran. Aucune lecture n'est declenchee.
    """
    try:
        from services.queue import fill_in_progress, queue_fill, queue_remaining
        # File deja prete (ou en construction) : la reconstruire couterait
        # plusieurs secondes et effacerait des titres deja affiches.
        if queue_remaining() >= 3 or fill_in_progress():
            return
        last = hist_read(1)
        if not last:
            return
        meta = _meta(last[0].get("video_id", "")) or {}
        try:
            genre = infer_genre_ollama(meta.get("title", ""), meta.get("channel", ""))
        except Exception:
            genre = _genre_of(meta.get("channel", ""))
        force = bool(genre) and genre != "autre"
        print(f"  [prepare] file en fond (mood={genre if force else 'historique'})",
              flush=True)
        queue_fill(genre if force else "", force, rebuild=True)
    except Exception as exc:
        print(f"  [prepare] preparation de la file echouee : {exc}", flush=True)


def prepare_playback() -> str:
    """Prepare la lecture a l'ouverture du client web : dernier titre charge, en pause.

    Charge le dernier titre ecoute dans mpv **en pause** (aucun son tant que
    l'utilisateur n'a pas appuye sur Lecture : effet voulu) et SANS l'ecrire dans
    l'historique (ce n'est pas une ecoute).

    Ne demarre NI la lecture NI le flux infini : un demarrage a froid doit rester
    silencieux. Seule la grace de 10 s (presence temps reel) laisse une lecture
    deja en cours continuer lors d'une absence courte.

    Returns:
        JSON {status: 'prepared'|'already_loaded'|'no_history'} ou {error}.
    """
    if not _PREPARE_LOCK.acquire(blocking=False):
        return json.dumps({"status": "preparing"}, ensure_ascii=False)
    try:
        if state._now_playing:
            # Deja quelque chose en lecture (ou en pause) : on ne l'ecrase pas.
            return json.dumps({"status": "already_loaded"}, ensure_ascii=False)
        last = hist_read(1)
        video_id = (last[0].get("video_id") if last else None)
        if not video_id:
            return json.dumps({"status": "no_history"}, ensure_ascii=False)
        res = json.loads(play_music(video_id, autoplay=False, log=False))
        if res.get("status") != "playing":
            return json.dumps(res, ensure_ascii=False)
        # File pre-remplie en tache de fond : le titre prepare ne doit pas etre
        # le seul propose (« Suivant » et reprise doivent etre immediats).
        threading.Thread(target=_prefill_queue, daemon=True, name="prefill-queue").start()
        return json.dumps({"status": "prepared", "paused": True,
                           "video_id": video_id, "title": res.get("title", "")},
                          ensure_ascii=False)
    finally:
        _PREPARE_LOCK.release()


def stop_music() -> str:
    """Arrete la lecture en cours (sans tuer le daemon mpv).

    Returns:
        JSON {status: 'stopped'} si une lecture etait active, sinon 'nothing_playing'.
    """
    _drain_timer_msgs()
    was_playing = state._now_playing or (state._player is not None and state._player.poll() is None)
    _stop_player()
    return json.dumps({"status": "stopped" if was_playing else "nothing_playing"}, ensure_ascii=False)


def is_paused() -> bool:
    """True si mpv est en pause (usage interne : boucle de streaming)."""
    if not _mpv_ready():
        return False
    r = _ipc_send(["get_property", "pause"], timeout=1.0)
    return bool(r and r.get("error") == "success" and r.get("data"))

def toggle_pause() -> str:
    """Bascule pause/reprise de la lecture en cours (mpv IPC).

    Returns:
        JSON {status: 'paused'|'playing', paused} ou {error}.
    """
    if not _mpv_ready():
        return json.dumps({"error": "Lecteur mpv indisponible."}, ensure_ascii=False)
    cur = _ipc_send(["get_property", "pause"], timeout=2.0)
    if not cur or cur.get("error") != "success":
        return json.dumps({"error": "Etat de lecture illisible (mpv)."}, ensure_ascii=False)
    paused = not bool(cur.get("data"))
    resp = _ipc_send(["set_property", "pause", paused], timeout=2.0)
    if not resp or resp.get("error") != "success":
        return json.dumps({"error": "Commande pause refusee par mpv."}, ensure_ascii=False)
    return json.dumps({"status": "paused" if paused else "playing", "paused": paused},
                      ensure_ascii=False)


def seek_music(position: float) -> str:
    """Positionne la lecture a `position` (secondes) via mpv IPC.

    Returns:
        JSON {status: 'seeked', position} ou {error}.
    """
    if not _mpv_ready():
        return json.dumps({"error": "Lecteur mpv indisponible."}, ensure_ascii=False)
    try:
        pos = max(0.0, float(position))
    except (TypeError, ValueError):
        return json.dumps({"error": f"position invalide '{position}'."}, ensure_ascii=False)
    resp = _ipc_send(["set_property", "time-pos", pos], timeout=3.0)
    if not resp or resp.get("error") != "success":
        return json.dumps({"error": "Seek refuse par mpv."}, ensure_ascii=False)
    return json.dumps({"status": "seeked", "position": pos}, ensure_ascii=False)


def set_volume(volume) -> str:
    """Regle le volume de lecture (0-100) via mpv IPC.

    Returns:
        JSON {status: 'volume', volume} ou {error}.
    """
    if not _mpv_ready():
        return json.dumps({"error": "Lecteur mpv indisponible."}, ensure_ascii=False)
    try:
        vol = min(100, max(0, int(round(float(volume)))))
    except (TypeError, ValueError):
        return json.dumps({"error": f"volume invalide '{volume}'."}, ensure_ascii=False)
    resp = _ipc_send(["set_property", "volume", vol], timeout=2.0)
    if not resp or resp.get("error") != "success":
        return json.dumps({"error": "Commande volume refusee par mpv."}, ensure_ascii=False)
    return json.dumps({"status": "volume", "volume": vol}, ensure_ascii=False)


def playback_state() -> str:
    """Etat de lecture courant (titre, position, duree, pause).

    Position/duree/pause lues via mpv IPC ; titre via le dernier historique ; les
    modes shuffle/repeat proviennent de l'etat du flux.
    Returns:
        JSON {playing, paused, shuffle, repeat, video_id, title, channel, position, duration}.
    """
    pos = dur = None
    paused = False
    if _mpv_ready():
        ri = _ipc_send(["get_property", "idle-active"], timeout=1.0)
        if ri and ri.get("error") == "success" and ri.get("data") is True:
            # mpv n'a plus rien charge (fin de titre, flux casse, arret) : le
            # drapeau "playing" ne doit pas survivre, sinon l'UI affiche un titre
            # fantome (annonce comme en lecture, sans duree ni son).
            state._now_playing = False
        rp = _ipc_send(["get_property", "time-pos"], timeout=2.0)
        rd = _ipc_send(["get_property", "duration"], timeout=2.0)
        rpa = _ipc_send(["get_property", "pause"], timeout=2.0)
        if rp and rp.get("error") == "success":
            pos = rp.get("data")
            # mpv peut rapporter une position tres legerement negative (seek en
            # debut de flux) : on ne l'expose jamais, le temps minimal est 0.
            if isinstance(pos, (int, float)) and pos < 0:
                pos = 0.0
        if rd and rd.get("error") == "success":
            dur = rd.get("data")
        if rpa and rpa.get("error") == "success":
            paused = bool(rpa.get("data"))
    meta = _meta(hist_read(1)[0]["video_id"]) if hist_read(1) else None
    # Repli sur la duree connue du titre : mpv rapporte 0 pendant le chargement
    # d'un fichier, ce qui recadrerait la barre de progression au debut.
    if not isinstance(dur, (int, float)) or dur <= 0:
        video_id = (meta or {}).get("video_id", "")
        with _cache_lock:
            cached = state.STREAM_CACHE.get(video_id)
        if isinstance(cached, dict) and cached.get("duration"):
            dur = cached["duration"]
    return json.dumps({
        "playing": bool(state._now_playing),
        "paused": paused,
        "shuffle": bool(state.SHUFFLE),
        "repeat": state.REPEAT_MODE,
        "video_id": (meta or {}).get("video_id", ""),
        "title": (meta or {}).get("title", ""),
        "channel": (meta or {}).get("channel", ""),
        "position": pos,
        "duration": dur,
    }, ensure_ascii=False)
