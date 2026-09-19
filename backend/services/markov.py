"""Chaines de Markov sur les genres : ordre 1, ordre 2 (Laplace + slots horaires)."""
from collections import Counter, defaultdict
from datetime import datetime

from services import state
from services.genres import _genre_of
from services.state import _tprint


def _markov_next(history):
    """(genre_pred, proba) : genre le plus probable apres le dernier ecoute, None si historique vide."""
    seq = [_genre_of(h.get("channel", "")) for h in history]
    if len(seq) < 2:
        return None, 0.0
    trans = defaultdict(Counter)
    for g1, g2 in zip(seq, seq[1:]):
        trans[g1][g2] += 1
    row = trans.get(seq[-1], {})
    if not row:
        return None, 0.0
    total = sum(row.values())
    best, n = max(row.items(), key=lambda x: x[1])
    return best, n / total


def _markov_next2(history, genre_filter=None):
    """[2] Markov ordre 2 avec lissage Laplace + contexte horaire.
    P(g3|g1,g2) = (count+1)/(total+V). Matrice separee par slot horaire de l'ecoute.
    genre_filter : ne garde que les ecoutes de ce genre (transitions intra-genre).
    Retourne (genre_pred, proba, source) avec source = 'markov2' | 'markov2-slot' | 'markov1-fallback'."""
    items = [(h.get("channel", ""), h.get("timestamp", "")) for h in history]
    if genre_filter:
        items = [(ch, ts) for ch, ts in items if _genre_of(ch) == genre_filter]
    seq = [_genre_of(ch) for ch, _ in items]
    if len(seq) < 3:
        pred, p = _markov_next(history)
        if genre_filter:
            return genre_filter, 0.5, "genre-prior"
        return pred, p, "markov1-fallback"
    from core import db as _dbmod
    slots = [_dbmod._slot_of(ts) for _, ts in items]
    genres = sorted(set(seq))
    V = len(genres)
    # Transitions globales O2 : (g1,g2) -> Counter(g3)
    trans = defaultdict(Counter)
    # Transitions par slot (slot de l'ecoute g3 = contexte d'arrivee)
    trans_slot = defaultdict(lambda: defaultdict(Counter))
    for (g1, g2, g3), s3 in zip(zip(seq, seq[1:], seq[2:]), slots[2:]):
        trans[(g1, g2)][g3] += 1
        trans_slot[s3][(g1, g2)][g3] += 1
    key = (seq[-2], seq[-1])
    try:
        cur_slot = _dbmod._slot_of(datetime.now().isoformat())
    except Exception:
        cur_slot = ""
    # 1. Contexte horaire d'abord (si donnees)
    row_s = trans_slot.get(cur_slot, {}).get(key, {})
    if row_s:
        total = sum(row_s.values())
        best, n = max(row_s.items(), key=lambda x: x[1])
        return best, (n + 1) / (total + V), "markov2-slot"
    # 2. Global O2 avec Laplace
    row = trans.get(key, {})
    if row:
        total = sum(row.values())
        best, n = max(row.items(), key=lambda x: x[1])
        _tprint(f"[markov2] après {key}: {best} (p={(n + 1) / (total + V):.2f})")
        return best, (n + 1) / (total + V), "markov2"
    # 3. Fallback O1
    if genre_filter:
        return genre_filter, 0.5, "genre-prior"
    pred, p = _markov_next(history)
    _tprint("[markov1-fallback]")
    return pred, p, "markov1-fallback"


def _history_stats(history):
    """video_id -> {title, channel, count} (dedup, comme la demo)."""
    stats = {}
    for e in history:
        vid = e.get("video_id", "")
        if not vid:
            continue
        if vid not in stats:
            stats[vid] = {"title": e.get("title", ""), "channel": e.get("channel", ""),
                          "genre": _genre_of(e.get("channel", "")), "count": 0}
        stats[vid]["count"] += 1
    return stats
