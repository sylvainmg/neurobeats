"""RAG : classement par similarite cosinus sur les embeddings de titres."""
from services.embeddings import _embed_titles_cached


def _rag_rank(seed_text, stats):
    """[(video_id, score)] tries par similarite cosinus au seed (bonus x1.2 si genre Markov predit)."""
    import numpy as np
    vids = list(stats)
    titles = [stats[v]["title"] or v for v in vids]
    emb = _embed_titles_cached(vids, titles, seed_text)
    emb = np.asarray(emb[0] if isinstance(emb, tuple) else emb)
    scores = emb[0] @ emb[1:].T
    ranked = sorted(zip(vids, scores.tolist()), key=lambda x: -x[1])
    return ranked
