"""Embeddings SentenceTransformer (singleton lazy) + cache SQLite."""
import threading
import time

from services import state
from services.db_access import _db_ready
from services.state import _tprint

MODEL_NAME = "all-MiniLM-L6-v2"
_reco_model = None  # singleton lazy : charge une seule fois, reutilise ensuite
_reco_model_lock = threading.Lock()  # evite le double chargement (warm-up + reco en parallele)


def _get_reco_model():
    """Singleton thread-safe du modele ST."""
    global _reco_model
    if _reco_model is None:
        with _reco_model_lock:
            if _reco_model is None:
                from sentence_transformers import SentenceTransformer
                t0 = time.perf_counter()
                print("  … chargement du modele d'affinites (1er appel)…", flush=True)
                try:
                    # Modele deja telecharge : le charger en local evite le
                    # controle de version reseau du Hub, qui representait
                    # l'essentiel des ~10 s du premier appel — et donc de la
                    # premiere construction de file, qui l'attendait.
                    _reco_model = SentenceTransformer(MODEL_NAME, local_files_only=True)
                except Exception:
                    _reco_model = SentenceTransformer(MODEL_NAME)
                print(f"  [embeddings] modele pret en {time.perf_counter() - t0:.1f}s",
                      flush=True)
    return _reco_model


def warm_reco_model():
    """Charge le modele d'embeddings en tache de fond (chauffe au demarrage).

    Appele par le lifespan AVANT tout travail de reco : la premiere construction
    de file ne doit jamais payer le chargement du modele.
    """
    try:
        _get_reco_model()
    except Exception as exc:
        _tprint(f"[embeddings] chauffe du modele echouee : {exc}")


def _embed_texts(texts):
    """(matrice similarities-like, mode) : ST lazy-singleton, fallback TF-IDF. Retourne embeddings normalises."""
    try:
        return _get_reco_model().encode(texts, normalize_embeddings=True), "ST"
    except Exception:
        from sklearn.feature_extraction.text import TfidfVectorizer
        import numpy as np
        mat = TfidfVectorizer().fit_transform(texts).toarray()
        norms = np.linalg.norm(mat, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        return mat / norms, "TF-IDF"


def _embed_titles_cached(vids, titles, seed_text):
    """[1] Cache embeddings : lookup SQLite par video_id avant encode().
    Retourne (matrice [seed + titres], hits, misses). Seed toujours encode frais
    (texte libre, pas de video_id)."""
    import numpy as np
    try:
        model = _get_reco_model()
    except Exception:
        return _embed_texts([seed_text] + titles)  # fallback TF-IDF (pas de cache texte)
    from core import db as _db
    cached = _db.db_embed_get_many(vids) if _db_ready() else {}
    missing = [(v, t) for v, t in zip(vids, titles) if v not in cached]
    if _db_ready() and missing:
        _tprint(f"[embeddings] cache hit {len(cached)}/{len(vids)}")
    if missing:
        fresh = model.encode([t for _, t in missing], normalize_embeddings=True)
        if _db_ready():
            for (v, _), vec in zip(missing, fresh):
                try:
                    _db.db_embed_put(v, vec)
                except Exception:
                    pass
                _tprint(f"[embeddings] recalc {v}")
        for (v, _), vec in zip(missing, fresh):
            cached[v] = np.asarray(vec, dtype=np.float32)
    seed_vec = model.encode([seed_text], normalize_embeddings=True)[0]
    mat = np.vstack([np.asarray(seed_vec, dtype=np.float32)] +
                    [np.asarray(cached[v], dtype=np.float32) for v in vids])
    return mat, "ST-cached"
