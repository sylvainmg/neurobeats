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
from services import state
from services.db_access import _meta, hist_append
from services.genres import _genre_of, infer_genre_ollama
from services.state import (
    _cache_lock, _drain_timer_msgs, _now_ms, _tprint, _watch_first_second,
    load_json, save_json, TIMER_MSGS,
)


def _load_stream_cache():
    """Charge le cache disque en RAM en ignorant les entrees expirees (TTL 5h)."""
    data = load_json(STREAM_CACHE_PATH, {})
    now = time.time()
    state.STREAM_CACHE = {vid: e for vid, e in data.items()
                          if isinstance(e, dict) and e.get("url") and now - e.get("ts", 0) < STREAM_CACHE_TTL}


def _save_stream_cache():
    save_json(STREAM_CACHE_PATH, state.STREAM_CACHE)


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
                    state.STREAM_CACHE[video_id] = {"url": info["url"], "ts": time.time()}
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
    """Pre-resout l'URL audio en arriere-plan (N+1 pendant la lecture de N)."""
    fut = state._prefetch_cache.get(video_id)
    if fut is None or fut.done():
        state._prefetch_cache[video_id] = state._prefetch_exec.submit(_resolve_audio_url, video_id)


def _take_prefetch(video_id: str) -> str | None:
    """Recupere l'URL pre-resolue si prete (non bloquant), sinon None."""
    fut = state._prefetch_cache.pop(video_id, None)
    if fut is not None and fut.done():
        try:
            return fut.result()
        except Exception:
            return None
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


def play_music(video_id: str) -> str:
    """Joue une video YouTube via le daemon mpv (fallback : process mpv direct).

    Args:
        video_id: Identifiant YouTube (11 caracteres) issu d'un tool du moteur.

    Returns:
        JSON {status: 'playing', video_id, title, channel} ou {error}.

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
    try:
        _p_genre = infer_genre_ollama(meta.get("title", ""), meta.get("channel", ""))
    except Exception:
        _p_genre = _genre_of(meta.get("channel", ""))
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
        stream_url = _take_prefetch(video_id) or _resolve_audio_url(video_id) or page_url
        resolve_dur = _now_ms() - t_stream_start
        _tprint(f"resolution flux audio : {resolve_dur:.1f}s{' (cache)' if from_cache and stream_url != page_url else ''}")
        print("  … lancement du son", flush=True)
        resp = _ipc_send(["loadfile", stream_url, "replace"], timeout=10.0)
        if resp and resp.get("error") == "success":
            state._mpv_timing.update({"gen": state._mpv_timing["gen"] + 1, "t_mpv": _now_ms(),
                                      "t_stream": t_stream_start, "resolve": resolve_dur, "found": False})
            state._now_playing = True
            state._player_t0 = t_stream_start
            title, channel = meta.get("title", ""), meta.get("channel", "")
            print(f"\n  ▶ Lecture : {title} — {channel}\n")
            hist_append(video_id, title, channel, meta.get("duration"), _p_genre)
            _maybe_prefetch_next(video_id)
            return json.dumps({"status": "playing", "video_id": video_id, "title": title,
                               "channel": channel}, ensure_ascii=False)
        _tprint(f"daemon mpv loadfile echec ({resp}), fallback spawn direct")
    # Repli : un process mpv dedie (si le daemon n'est pas disponible).
    _stop_player()
    page_url = f"https://www.youtube.com/watch?v={video_id}"
    print("  … connexion au flux audio", flush=True)
    t_stream_start = time.perf_counter()
    entry = state.STREAM_CACHE.get(video_id)
    from_cache = isinstance(entry, dict) and bool(entry.get("url"))
    stream_url = _resolve_audio_url(video_id) or page_url  # fallback page si resolution echoue
    resolve_dur = time.perf_counter() - t_stream_start
    _tprint(f"resolution flux audio : {resolve_dur:.1f}s{' (cache)' if from_cache and stream_url != page_url else ''}")
    print("  … lancement du son", flush=True)
    try:
        t_mpv_start = time.perf_counter()
        args = MPV_BASE_ARGS if not TIMING else [a for a in MPV_BASE_ARGS if a != "--really-quiet"]
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
    print(f"\n  ▶ Lecture : {title} — {channel}\n")
    hist_append(video_id, title, channel, meta.get("duration"), _p_genre)
    _maybe_prefetch_next(video_id)
    return json.dumps({"status": "playing", "video_id": video_id, "title": title,
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
    A utiliser quand l'utilisateur repond par un numero ('le 1', '2', 'premier'...)."""
    try:
        idx = int(index) - 1
    except (TypeError, ValueError):
        return json.dumps({"error": f"index '{index}' invalide. Donne un numero entre 1 et {len(state.LAST_SEARCH)}."}, ensure_ascii=False)
    vids = list(state.LAST_SEARCH.keys())
    if not vids:
        return json.dumps({"error": "Aucune recherche recente. Appelle d'abord search_music."}, ensure_ascii=False)
    if idx < 0 or idx >= len(vids):
        return json.dumps({"error": f"index {index} hors limites (1-{len(vids)}).", "options": list(state.LAST_SEARCH.values())}, ensure_ascii=False)
    return play_music(vids[idx])


def stop_music() -> str:
    """Arrete la lecture en cours (sans tuer le daemon mpv).

    Returns:
        JSON {status: 'stopped'} si une lecture etait active, sinon 'nothing_playing'.
    """
    _drain_timer_msgs()
    was_playing = state._now_playing or (state._player is not None and state._player.poll() is None)
    _stop_player()
    return json.dumps({"status": "stopped" if was_playing else "nothing_playing"}, ensure_ascii=False)
