"""Demo terminal RAG / Markov / Decouverte sur l'historique d'ecoute.

Rien d'integre a app.py : tests en print() uniquement.
Usage: backend/.venv/bin/python backend/tests/test_recommendation.py
"""
import json
import random
from collections import Counter, defaultdict
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent  # backend/ (données + code partagés)
QUERIES = ["gazo cartier", "lomepal trop beau", "lil nas x", "vald orelsan", "dance monkey"]

# Pseudo-genres derives du channel (pas de vrai tag genre dans l'historique)
CHANNEL_GENRE_MAP = {
    "GAZO OFFICIEL": "rap fr",
    "Lomepal": "rap fr",
    "VALD": "rap fr",
    "Info Star": "rap fr",          # clip evenement Vald/Orelsan
    "COLORS": "rap fr",             # Gazo - MOLLY (A COLORS SHOW)
    "Paroles Françaises": "rap fr",  # Gazo/Tiakola paroles
    "Lil Nas X": "pop us",
    "LIL UZI VERT": "rap us",
    "Finding Sounds": "pop us",     # Aimee Carty (lyrics)
    "Royal Music": "pop us",        # Tones and I (lyrics)
}


def load_history():
    """Historique : SQLite (neurobeats.db) si dispo, sinon JSON / .bak."""
    db_path = BASE / "neurobeats.db"
    if db_path.exists():
        try:
            import sys
            sys.path.insert(0, str(BASE))
            from core import db as _db
            rows = _db.db_get_history(500)
            rows.reverse()  # db renvoie DESC -> ordre chronologique
            return rows
        except Exception as exc:
            print(f"[warn] lecture SQLite echouee ({exc}), repli JSON")
    for name in ("music_history.json", "music_history.json.bak"):
        p = BASE / name
        if p.exists():
            with open(p, encoding="utf-8") as f:
                return json.load(f)
    raise FileNotFoundError("Aucun historique (ni neurobeats.db ni music_history.json)")


def _sqlite_genres():
    """{video_id: genre} depuis history (colonne genre remplie par l'auto-tagging)."""
    db_path = BASE / "neurobeats.db"
    if not db_path.exists():
        return {}
    try:
        import sqlite3
        con = sqlite3.connect(db_path)
        rows = con.execute("SELECT video_id, genre FROM history WHERE genre IS NOT NULL").fetchall()
        con.close()
        return {vid: g for vid, g in rows}
    except Exception:
        return {}


def dedup(history):
    """video_id -> {title, channel, count}."""
    stats = {}
    for e in history:
        vid = e.get("video_id", "")
        if vid not in stats:
            stats[vid] = {"title": e.get("title", ""), "channel": e.get("channel", ""), "count": 0}
        stats[vid]["count"] += 1
    return stats


def genre_of(channel, fallback="autre"):
    """Genre d'une chaine via le mapping cure, ou `fallback`."""
    return CHANNEL_GENRE_MAP.get(channel, fallback)


def markov_matrix(history, genres=None):
    """P(genre_N+1 | genre_N) = transitions / total depuis genre_N.
    genres : {video_id: genre} issu de SQLite (auto-tagging) prioritaire sur la map."""
    genres = genres or {}

    def _g(e):
        return genres.get(e.get("video_id")) or genre_of(e.get("channel", ""))

    seq = [_g(e) for e in history]
    trans = defaultdict(Counter)
    for g1, g2 in zip(seq, seq[1:]):
        trans[g1][g2] += 1
    proba = {g1: {g2: c / sum(cnt.values()) for g2, c in cnt.items()}
             for g1, cnt in trans.items()}
    return proba, seq[-1] if seq else None


def rag_top3(queries, titles):
    """Top-3 titres par similarite cosinus. ST si dispo, sinon TF-IDF fallback."""
    try:
        from sentence_transformers import SentenceTransformer
        model = SentenceTransformer("all-MiniLM-L6-v2")
        print("[ST mode] sentence-transformers all-MiniLM-L6-v2")
        emb_t = model.encode(titles, normalize_embeddings=True)
        emb_q = model.encode(queries, normalize_embeddings=True)
        import numpy as np
        sims = np.dot(emb_q, np.array(emb_t).T)
        return sims.tolist(), "cosinus-ST"
    except Exception as exc:
        print(f"[TF-IDF fallback] ST indisponible ({type(exc).__name__}): TF-IDF sklearn")
        from sklearn.feature_extraction.text import TfidfVectorizer
        from sklearn.metrics.pairwise import cosine_similarity
        vec = TfidfVectorizer().fit_transform(titles + queries)
        sims = cosine_similarity(vec[len(titles):], vec[:len(titles)])
        return sims.tolist(), "cosinus-TFIDF"


def discovery(stats, history, query):
    """Tirage 60/40 : favori (top-5 ecoutes) ou nouveaute (hors 20 derniers).

    Returns:
        (kind, title, raison) avec kind in {'favori', 'nouveau'}.
    """
    favoris = [vid for vid, _ in Counter({v: s["count"] for v, s in stats.items()}).most_common(5)]
    exclus = {e.get("video_id") for e in history[-20:]}
    nouveaux = [vid for vid in stats if vid not in exclus and vid not in favoris]
    if random.random() < 0.6:
        vid = random.choice(favoris)
        return "favori", stats[vid]["title"], "tirage 60/40 -> favori (top-5 ecoutes)"
    if nouveaux:
        vid = random.choice(nouveaux)
        return "nouveau", stats[vid]["title"], "tirage 60/40 -> nouveau (hors 20 derniers)"
    vid = random.choice(favoris)
    return "favori", stats[vid]["title"], "fallback: aucun nouveau dispo -> favori"


def main():
    """Execute les demos : setup, Markov, RAG top-3, decouverte 60/40."""
    history = load_history()
    stats = dedup(history)
    titles = [s["title"] for s in stats.values()]
    print(f"=== Setup: {len(history)} entrees, {len(stats)} titres uniques ===")
    for vid, n in Counter({v: x["count"] for v, x in stats.items()}).most_common(5):
        print(f"  {n}x {stats[vid]['title'][:50]}")
    print(f"=== Requetes simulees: {QUERIES} ===")

    print("\n=== 1. Markov P(genre_N+1 | genre_N) ===")
    genres = _sqlite_genres()
    print(f"(genres: {len(genres)} depuis SQLite auto-tagging)" if genres else "(genres: map chaine)")
    proba, last = markov_matrix(history, genres)
    print(f"dernier genre ecoute: {last}")
    for g1, row in proba.items():
        print(f"  depuis {g1}: " + ", ".join(f"{g2}={p:.2f}" for g2, p in sorted(row.items(), key=lambda x: -x[1])))
    for q in QUERIES:
        best = max(proba.get(last, {}).items(), key=lambda x: x[1], default=(None, 0))
        print(f"  requete {q!r} -> apres {last!r}: {best[0]!r} (p={best[1]:.2f})")

    print("\n=== 2. RAG top-3 par requete ===")
    sims, metric = rag_top3(QUERIES, titles)
    print(f"(metrique: {metric})")
    for q, row in zip(QUERIES, sims):
        top = sorted(zip(titles, row), key=lambda x: -x[1])[:3]
        print(f"  requete {q!r}:")
        for t, s in top:
            print(f"    {s:.3f}  {t[:60]}")

    print("\n=== 3. Decouverte 60/40 (hors 20 derniers) ===")
    random.seed(42)  # reproductible pour la demo
    for q in QUERIES:
        kind, title, raison = discovery(stats, history, q)
        print(f"  requete {q!r}: [60/40 -> {kind}] {title[:60]} ({raison})")


if __name__ == "__main__":
    main()
