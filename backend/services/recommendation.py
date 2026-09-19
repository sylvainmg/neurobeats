"""Recommandation live : RAG + Markov O2 + stats + decouverte 60/40, filtrage genre dur."""
import json
import re
import threading
import time
from collections import Counter
from datetime import datetime

from services import state
from services.db_access import _db_ready, _meta, get_user_stats, hist_read, profile_read, profile_write
from services.embeddings import _embed_texts, _embed_titles_cached
from services.genres import (
    GENERIC_CHANNELS, GENRE_LABELS, GENRE_SEARCH_TERMS, _JUNK_TITLE_RE,
    _genre_of, infer_genres_batch,
)
from services.markov import _history_stats, _markov_next, _markov_next2
from services.rag import _rag_rank
from services.state import _remember, _tokens, _tprint
from services.youtube import youtube_search


def store_preference(video_id: str, rating: int) -> str:
    """Stocke la note (1-5) d'une video dans le profil utilisateur."""
    meta = state.LAST_SEARCH.get(video_id) or _meta(video_id)
    if meta is None:
        return json.dumps({"error": f"video_id '{video_id}' inconnu. Appelle d'abord search_music."}, ensure_ascii=False)
    profile = profile_read()
    profile["preferences"][video_id] = {
        "rating": rating, "title": meta.get("title", ""), "channel": meta.get("channel", "")
    }
    if rating >= 4 and meta.get("channel"):
        if meta["channel"] not in profile["genres_favoris"]:
            profile["genres_favoris"].append(meta["channel"])
    profile_write(profile)
    return json.dumps({"status": "stored", "video_id": video_id, "rating": rating}, ensure_ascii=False)


def _cold_start_warmup():
    """[6] Warm-up au demarrage (thread fond) : top-3 genres/artistes, embeddings + prefetch.
    Le 1er start_streaming() devient quasi-immediat (modele + cache chauds)."""
    from services.audio import _prefetch
    t0 = time.perf_counter()
    try:
        history = hist_read(200)
        if not history:
            return
        stats = _history_stats(history)
        top = Counter({v: s["count"] for v, s in stats.items()}).most_common(3)
        if not top:
            return
        vids = [v for v, _ in top]
        titles = [stats[v]["title"] or v for v in vids]
        _embed_titles_cached(vids, titles, titles[0])  # modele chaud + cache rempli
        for v in vids:
            try:
                _prefetch(v)  # URLs audio pre-resolues
            except Exception:
                pass
        try:
            _rag_rank(titles[0], stats)  # pipeline RAG verifie
        except Exception:
            pass
        print(f"  [cold-start] Warm-up complet en {time.perf_counter() - t0:.1f}s "
              f"({len(vids)} titres top)", flush=True)
    except Exception as exc:
        _tprint(f"[cold-start] echec : {exc}")

# Garde-fou anti-litteral (moteur) : reconnait une phrase de "demande" sans contenu
# (ex. 'recommande-moi', 'd'autres ...?') qui ne doit jamais partir telle quelle sur YouTube.
_RECO_RE = re.compile(
    r"(recomm?end|suggest|reco|sugg[eè]re|propose|d[eé]couvrir|d[eé]couverte|"
    r"autre chose|quelque chose|dans la veine|dans le m[êe]me|similaire|pareil|encore|"
    r"you may also like|si tu aimais|qu'est-ce que tu me conseilles|conseille)",
    re.IGNORECASE,
)
_RECO_FILLER = {
    "recommande", "recommandes", "recommandez", "recommandation", "recommandations",
    "recommende", "recommendes", "recommendez", "recommendation", "recommendations",
    "reco", "recos", "suggere", "suggeres", "suggerez", "suggère", "suggères",
    "suggérez", "suggestion", "suggestions",
    "propose", "proposes", "proposez", "proposition", "propositions",
    "autre", "autres", "encore", "plus", "nouveau", "nouveaux", "nouvelle", "nouvelles",
    "quelque", "chose", "truc", "idée", "idee", "son", "sons", "musique", "musiques",
    "titre", "titres", "morceau", "morceaux", "écoute", "ecoute", "écouter", "ecouter",
    "quoi", "que", "moi", "stp", "svp", "plait", "donne", "donnez", "fais",
    "découvrir", "decouvrir", "découverte", "decouverte", "similar", "similaire",
    "pareil", "veine", "meme", "même", "dans", "le", "la", "les", "de", "des",
    "du", "un", "une", "et", "en", "au", "aux", "a", "tu", "vous", "je", "me",
    "d", "l", "s", "t", "qu", "est", "ce", "c",
}


def get_recommendation(query: str = "", force_genre_filter: bool = False) -> str:
    """Retourne 3 videos non ecoutees a partir du contexte et de l'historique.

    Combine un classement RAG (similarite au contexte), une prediction Markov O2 du
    genre suivant et les stats d'ecoute (genre/artiste preferes, penalite skip, creneau
    horaire). Le resultat est filtre pour exclure les 20 dernieres ecoutes.

    Args:
        query: Contexte libre (titre, envie, genre). Vide utilise le dernier ecoute.
        force_genre_filter: Si True et query est un genre connu (ex. 'rap fr'),
            restreint la reco a ce genre (utilise par le streaming et les playlists).

    Returns:
        JSON : {based_on, markov_genre, recommendations[...], warning?}.
    """
    history = hist_read(500)
    profile = profile_read()
    if not history and not profile.get("preferences"):
        return json.dumps({"error": "Aucun historique. Ecoute d'abord de la musique via search_music + play_music."}, ensure_ascii=False)
    # Stats d'ecoute (SQLite si dispo) : pilotent les bonus et penalites ci-dessous.
    try:
        ustats = json.loads(get_user_stats())
    except Exception:
        ustats = {}
    genre_top = (ustats.get("genre_top") or {}).get("genre")
    artiste_top = (ustats.get("artiste_top") or {}).get("channel")
    heure_slot = (ustats.get("heure_pref") or {}).get("slot")
    skip_channels = set()
    if _db_ready():
        from core import db as _db
        con = _db._connect()
        try:
            for row in con.execute(
                    "SELECT channel, CAST(SUM(skips) AS FLOAT) / MAX(SUM(plays), 1) AS r"
                    " FROM stats_channel GROUP BY channel HAVING SUM(plays) >= 2"):
                if row["r"] is not None and row["r"] >= 0.5:
                    skip_channels.add(row["channel"])
        except Exception:
            pass
        finally:
            con.close()
    try:
        _h, _now_h = None, datetime.now().hour
        for _lo, _hi, _name in [(6, 12, "matin"), (12, 14, "midi"), (14, 18, "apres-midi"),
                                (18, 24, "soir"), (0, 6, "nuit")]:
            if _lo <= _now_h < _hi:
                _h = _name
                break
        cur_slot = _h or "nuit"
    except Exception:
        cur_slot = ""
    slot_boost_genre = genre_top if heure_slot and heure_slot == cur_slot else None
    listened = {h.get("video_id") for h in history}
    recent = {h.get("video_id") for h in history[-20:]}  # anti-redite : jamais les 20 derniers
    recent |= {vid for vid in state.LAST_SEARCH}  # + jamais le lot precedent
    seed_text = (query or "").strip() or (history[-1].get("title", "") if history else "music")
    # Garde-fou anti-littéral : une demande brute ne doit JAMAIS partir telle quelle sur YouTube
    if _RECO_RE.search(seed_text) and not re.search(r"comme\s+.+", seed_text, re.IGNORECASE):
        content = [w for w in re.findall(r"[a-zàâäéèêëîïôöùûüç]+", seed_text.lower())
                   if w not in _RECO_FILLER]
        if not content:
            seed_text = history[-1].get("title", "") if history else "music"
    genre_pred, genre_p = _markov_next(history)
    _tprint(f"reco seed={seed_text[:40]!r} markov->{genre_pred} (p={genre_p:.2f})")
    genre_pred2, genre_p2, markov_src = _markov_next2(history)
    _tprint(f"reco markov2->{genre_pred2} (p={genre_p2:.2f}, {markov_src})")
    stats = _history_stats(history)
    # Filtrage genre dur (streaming infini / playlist) : n'active que si query est un genre connu.
    genre_target = None
    if force_genre_filter:
        q = (query or "").strip().lower()
        known = set(GENRE_LABELS) | {_genre_of(h.get("channel", "")) for h in history}
        known.discard("autre")
        if q in known:
            genre_target = q
    if genre_target:
        # Markov O2 restreint au genre cible (transitions intra-genre uniquement)
        gp2, gpp2, gsrc2 = _markov_next2(history, genre_filter=genre_target)
        genre_pred2, genre_p2, markov_src = gp2 or genre_target, gpp2, gsrc2 + "+genre"
    # RAG : le titre ecoute le plus proche du contexte -> seed affine.
    import re as _re_sel
    seed_norm = set(_re_sel.findall(r"[a-z0-9]+", seed_text.lower()))
    seed_sig = set(_tokens(seed_text))
    search_terms = [seed_text]
    try:
        ranked = []
        for v, s in _rag_rank(seed_text, stats):
            words = set(_re_sel.findall(r"[a-z0-9]+", (stats[v]["title"] or "").lower()))
            overlap = len(seed_norm & words) / max(len(seed_norm), 1)
            wsig = set(_tokens(stats[v]["title"] or ""))
            union = seed_sig | wsig
            jacc = len(seed_sig & wsig) / len(union) if union else 0.0
            if overlap < 0.8 and jacc < 0.5 and s >= 0.35:
                ranked.append((v, s))
        if ranked:
            top = next((stats[v] for v, _ in ranked if stats[v].get("channel") not in GENERIC_CHANNELS),
                       stats[ranked[0][0]])
            if top.get("channel") and top["channel"] not in GENERIC_CHANNELS:
                search_terms.append(top["channel"])
            if top.get("title") and top["title"] != seed_text:
                search_terms.append(top["title"])
            if top.get("channel") in GENERIC_CHANNELS and top.get("title"):
                artist = re.split(r"\s+[-–]\s+", top["title"], maxsplit=1)[0].strip()
                if artist and artist != seed_text:
                    search_terms.append(artist)
        elif not (query or "").strip():
            search_terms = [c for c, _ in Counter(
                h.get("channel") for h in history if h.get("channel")).most_common(2)]
            seed_text = search_terms[0] if search_terms else seed_text
    except Exception as exc:
        _tprint(f"RAG seed echec ({exc}), seed brut seul")
    # 1-3 ytsearch ciblés + filet favoris, on collecte large (>= 12) sur TOUS les termes
    collected, seen = [], set()
    if genre_target:
        genre_channels = [c for c, _ in Counter(
            h.get("channel") for h in history
            if h.get("channel") and _genre_of(h["channel"]) == genre_target
            and h["channel"] not in GENERIC_CHANNELS).most_common(6)]
        terms = list(dict.fromkeys(([seed_text] if seed_text.lower() != genre_target else [])
                                   + genre_channels))
        terms += GENRE_SEARCH_TERMS.get(genre_target, [genre_target])
    else:
        terms = list(search_terms[:3])
        terms += [c for c, _ in Counter(
            h.get("channel") for h in history if h.get("channel")).most_common(2)
            if c not in terms]

    def _collect(terms_list, target, pool):
        for term in terms_list:
            if len(pool) >= target:
                break
            try:
                for r in youtube_search(term, 8):
                    vid = r["video_id"]
                    if vid in listened or vid in recent or vid in seen:
                        continue
                    seen.add(vid)
                    pool.append(r)
            except Exception as exc:
                _tprint(f"[offline-mode] ytsearch '{term[:30]}' indisponible : {str(exc)[:80]}")
                return False
        return True

    online = _collect(terms, 16 if genre_target else 12, collected)
    if genre_target and collected:
        collected = [r for r in collected if not _JUNK_TITLE_RE.search(r.get("title", "") or "")]
        genres = infer_genres_batch(collected)
        for r in collected:
            r["genre"] = genres.get(r["video_id"], "autre")
        before = len(collected)
        collected = [r for r in collected if r["genre"] == genre_target]
        _tprint(f"[genre-filter] force=True focus='{genre_target}', "
                f"{len(collected)} titres eligibles / {before} collectes")
    # Fusion : score = RAG*wR + Markov*wM + stats*wS. Les poids dependent du contexte
    # (un flux infini privilegie la continuite Markov ; une reco unique la pertinence RAG).
    FUSION_WEIGHTS = {
        "stream": (0.25, 0.50, 0.25),
        "reco": (0.50, 0.20, 0.30),
        "playlist": (0.40, 0.30, 0.30),
    }
    fusion_ctx = "stream" if threading.current_thread().name == "streaming" else "reco"
    wR, wM, wS = FUSION_WEIGHTS[fusion_ctx]
    import numpy as np
    fav_channels = {c for c, _ in Counter(h.get("channel") for h in history if h.get("channel")).most_common(5)}
    seed_words = set(_tokens(seed_text))

    def _score(cands):
        try:
            emb = _embed_texts([seed_text] + [(c.get("title") or "") for c in cands])
            emb = np.asarray(emb[0] if isinstance(emb, tuple) else emb)
            cos = (emb[0] @ emb[1:].T).tolist()
        except Exception as exc:
            _tprint(f"[fusion] encode echec ({type(exc).__name__}: {str(exc)[:100]}), cos=0")
            cos = [0.0] * len(cands)
        rag_n = [min(max((s + 1.0) / 2.0, 0.0), 1.0) for s in cos]
        out = []
        for r, s, rn in zip(cands, cos, rag_n):
            words = set(_tokens(r.get("title") or ""))
            union = seed_words | words
            if union and len(seed_words & words) / len(union) >= 0.5:
                continue
            ch = r.get("channel", "")
            g = r.get("genre") or _genre_of(ch)
            markov_n = genre_p2 if genre_pred2 and g == genre_pred2 else 0.0
            stats_n = 0.0
            if genre_top and g == genre_top:
                stats_n += 0.5
            if artiste_top and ch == artiste_top:
                stats_n += 0.3
            if slot_boost_genre and g == slot_boost_genre:
                stats_n += 0.2
            if ch in skip_channels:
                stats_n -= 0.5
            stats_n = min(max(stats_n, 0.0), 1.0)
            final = rn * wR + markov_n * wM + stats_n * wS
            if ch in GENERIC_CHANNELS:
                final *= 0.6
            if genre_target and g == genre_target:
                final *= 2.0
            _tprint(f"[fusion:{fusion_ctx}] RAG={rn:.2f} Markov={markov_n:.2f} stats={stats_n:.2f} "
                    f"-> final={final:.2f} {(r.get('title') or '')[:35]}")
            out.append((final, r.get("channel") in fav_channels, r))
        return out

    scored = _score(collected)
    # Filet : tant que < 3 exploitables, elargit (top-5 channels, 2e/3e match RAG, genre Markov)
    if online and len(scored) < 3:
        extra_terms = []
        if genre_target:
            extra_terms += [c for c, _ in Counter(
                h.get("channel") for h in history
                if h.get("channel") and _genre_of(h["channel"]) == genre_target
                and h["channel"] not in GENERIC_CHANNELS).most_common(10)
                if c not in terms]
        else:
            try:
                rag_all = _rag_rank(seed_text, stats)
                for v, s in rag_all[1:3]:
                    for cand in (stats[v].get("channel"), stats[v].get("title")):
                        if cand and cand != seed_text and cand not in terms and cand not in extra_terms:
                            extra_terms.append(cand)
            except Exception:
                pass
            extra_terms += [c for c, _ in Counter(
                h.get("channel") for h in history if h.get("channel")).most_common(5)
                if c not in terms and c not in extra_terms]
            if genre_pred and genre_pred not in terms:
                extra_terms.append(genre_pred)
        extra = []
        n_more = (20 if genre_target else 20) - len(collected)
        _collect(extra_terms, max(n_more, 6), extra)
        if genre_target and extra:
            eg = infer_genres_batch(extra)
            for r in extra:
                r["genre"] = eg.get(r["video_id"], "autre")
            extra = [r for r in extra if r["genre"] == genre_target]
        collected += extra
        scored = _score(collected)
    if not scored:
        # Repli local : RAG seul sur l'historique (distingue mode hors-ligne et vivier epuise).
        if online:
            _tprint("[genre-filter] vivier epuise, replay historique local")
            warn = ("Genre épuisé : titres déjà écoutés (aucune nouveauté dans ce genre)."
                    if genre_target else "Titres déjà écoutés (aucune nouveauté).")
        else:
            _tprint("[offline-mode] YouTube indisponible, reco locale seule")
            warn = "Mode hors-ligne : titres déjà écoutés (YouTube indisponible)."
        try:
            ranked = [(v, s) for v, s in _rag_rank(seed_text, stats)
                      if v not in recent and (not genre_target or stats[v]["genre"] == genre_target)][:3]
        except Exception:
            ranked = []
        if not ranked:
            return json.dumps({"error": "Aucune nouveaute trouvee. Ecoute plus de titres pour affiner."}, ensure_ascii=False)
        picks = [{"video_id": v, "title": stats[v]["title"], "channel": stats[v]["channel"],
                  "genre": stats[v]["genre"], "score": round(float(s), 3)} for v, s in ranked]
        for p in picks:
            _remember(p["video_id"], p.get("title", ""), p.get("channel", ""))
        state.LAST_SEARCH.update({p["video_id"]: p for p in picks})
        return json.dumps({"based_on": seed_text, "markov_genre": genre_target or genre_pred,
                           "recommendations": picks, "warning": warn},
                          ensure_ascii=False)
    scored.sort(key=lambda x: (-x[1], -x[0]))  # 60/40 : favoris d'abord, puis meilleur score
    # Dédup inter-candidats : même chanson via plusieurs uploads -> garde le meilleur.
    deduped = []
    for s, is_fav, r in scored:
        words = set(_tokens(r.get("title") or ""))
        dup = False
        for _, _, kept in deduped:
            kw = set(_tokens(kept.get("title") or ""))
            union = words | kw
            if union and len(words & kw) / len(union) >= 0.5:
                dup = True
                break
        if not dup:
            deduped.append((s, is_fav, r))
    scored = deduped
    picks, seen_genres, div_skips = [], set(), 0
    for s, is_fav, r in scored:
        if len(picks) >= 3:
            break
        g = r.get("genre") or _genre_of(r.get("channel", ""))
        if g in seen_genres and len(picks) < 2 and div_skips < 1 \
                and len({x[2].get("channel") for x in scored}) > 2:
            div_skips += 1
            continue
        seen_genres.add(g)
        picks.append({"video_id": r["video_id"], "title": r.get("title", ""),
                      "channel": r.get("channel", ""), "genre": g, "score": round(float(s), 3)})
    for p in picks:
        _remember(p["video_id"], p.get("title", ""), p.get("channel", ""))
    state.LAST_SEARCH.update({p["video_id"]: p for p in picks})
    out = {"based_on": seed_text, "markov_genre": genre_target or genre_pred,
           "recommendations": picks}
    if genre_target:
        out["genre_filter"] = genre_target
    if len(picks) < 3:
        out["warning"] = f"Seulement {len(picks)} nouveauté(s) trouvée(s) — écoute plus de titres pour affiner."
    return json.dumps(out, ensure_ascii=False)
