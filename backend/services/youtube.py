"""Recherche YouTube (yt-dlp) : cache requetes, retry, search_music, play_now."""
import hashlib
import json
import time

from yt_dlp import YoutubeDL

from core.config import VIDEO_ID_RE as _VIDEO_ID_RE
from core.config import YDL_OPTS
from services import state
from services.db_access import _meta
from services.state import _match_score, _remember, _tprint

_YT_CACHE: dict = {}  # query_hash -> (ts, results), TTL 30 min
_YT_CACHE_TTL = 30 * 60


def youtube_search(query: str, n: int = 5) -> list:
    """Recherche YouTube (avec cache), retourne des dicts {video_id, title, channel, duration}."""
    return _youtube_search_cached(query, n)


def _youtube_search_cached(query: str, n: int = 5) -> list:
    """Sert la recherche depuis le cache si fraiche, sinon interroge YouTube."""
    key = hashlib.md5(f"{query.strip().lower()}|{n}".encode()).hexdigest()
    hit = _YT_CACHE.get(key)
    if hit and time.time() - hit[0] < _YT_CACHE_TTL:
        _tprint(f"[youtube-cache] hit {query[:30]!r}")
        return [dict(r) for r in hit[1]]
    results = _youtube_search_live(query, n)
    _YT_CACHE[key] = (time.time(), [dict(r) for r in results])
    return results


def _youtube_search_live(query: str, n: int = 5) -> list:
    """Interroge YouTube avec retry exponentiel (1s, 2s, 4s). Leve si indisponible."""
    last_exc = None
    for attempt in range(3):
        try:
            with YoutubeDL(YDL_OPTS) as ydl:
                info = ydl.extract_info(f"ytsearch{n}:{query}", download=False)
            break
        except Exception as exc:
            last_exc = exc
            _tprint(f"[retry] ytsearch tentative {attempt + 1}/3 echec : {str(exc)[:80]}")
            if attempt < 2:
                time.sleep(2 ** attempt)
    else:
        raise last_exc
    results = []
    for e in (info.get("entries") or [])[:n]:
        if not e or not e.get("id"):
            continue
        vid = e["id"]
        if not _VIDEO_ID_RE.match(vid):
            continue  # id de chaine/playlist (ex. 22 car.) : pas une video jouable
        title = e.get("title", "")
        channel = e.get("channel") or e.get("uploader", "")
        dur = e.get("duration")
        _remember(vid, title, channel)
        results.append({"video_id": vid, "title": title, "channel": channel, "duration": dur})
    return results


def search_music(query: str, limit: int = 5) -> str:
    """Recherche YouTube et enrichit chaque resultat avec son genre.

    Args:
        query: Requete libre.
        limit: Nombre de resultats (borne 1-10).

    Returns:
        JSON : liste de {video_id, title, channel, duration, genre} ou {error}.
    """
    limit = max(1, min(int(limit or 5), 10))
    from services.genres import infer_genres_batch, _genre_of
    try:
        results = youtube_search(query, limit)
    except Exception as exc:
        return json.dumps({"error": f"Recherche YouTube echouee : {exc}"}, ensure_ascii=False)
    if not results:
        return json.dumps({"error": "Aucun resultat YouTube", "query": query}, ensure_ascii=False)
    try:
        genres = infer_genres_batch(results)
        for r in results:
            r["genre"] = genres.get(r["video_id"], "autre")
    except Exception as exc:
        _tprint(f"[genre-infer] batch echec ({exc}), fallback chaine")
        for r in results:
            r["genre"] = _genre_of(r.get("channel", ""))
    state.LAST_SEARCH.clear()
    state.LAST_SEARCH.update({r["video_id"]: r for r in results})
    return json.dumps(results, ensure_ascii=False)


def play_now(query: str) -> str:
    """Cherche et joue directement si la requete est assez specifique.

    Joue le 1er resultat si la requete a >= 2 mots significatifs et un recouvrement
    d'au moins 0.6 ; sinon retourne des options pour que l'utilisateur choisisse.

    Returns:
        JSON : statut de lecture, ou {error, options[...]} si la requete est vague.
    """
    from services.audio import play_music
    try:
        t0 = time.perf_counter()
        results = youtube_search(query, 5)
        _tprint(f"recherche YouTube : {time.perf_counter() - t0:.1f}s")
    except Exception as exc:
        return json.dumps({"error": f"Recherche YouTube echouee : {exc}"}, ensure_ascii=False)
    if not results:
        return json.dumps({"error": "Aucun resultat YouTube", "query": query}, ensure_ascii=False)
    state.LAST_SEARCH.clear()
    state.LAST_SEARCH.update({r["video_id"]: r for r in results})
    score, n = _match_score(query, results[0].get("title", ""), results[0].get("channel", ""))
    if n >= 2 and score >= 0.6:
        print(f"  … trouvé : {results[0].get('title', '')}", flush=True)
        res = json.loads(play_music(results[0]["video_id"]))
        if res.get("status") == "playing":
            # Auto-streaming : le flux infini demarre dans le genre du titre lance.
            from services.audio import _autostart_after_play
            _autostart_after_play(res.get("title", ""), res.get("channel", ""))
        return json.dumps(res, ensure_ascii=False)
    return json.dumps({
        "error": "Requete trop vague pour lecture immediate, demande a l'utilisateur de choisir.",
        "options": results[:5],
    }, ensure_ascii=False)
