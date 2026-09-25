"""Navigateur de modeles Hugging Face (GGUF) pour le panneau local.

Le catalogue cure reste la voie recommandee ; ce module ouvre la recherche au Hub
pour choisir un modele hors catalogue. Aucun appel reseau n'a lieu au chargement :
tout part de fonctions appelees a la demande, mises en cache, et isolees pour
rester testables sans reseau. Toute panne renvoie un message « indisponible »,
que `dependencies.responses.error_status` traduit en HTTP 503.
"""
from __future__ import annotations

import json
import re
import threading
import time
from typing import Any, Callable

from services.models import _mem_budget_gb, probe_hardware
from services.state import _tprint

HUB_TTL = 600  # 10 min : une recherche bouge peu, et on menage le Hub
_QUANT_RE = re.compile(r"(IQ\d+(?:_[A-Z0-9]+)*|Q\d+(?:_[A-Z0-9]+)*|MXFP4|BF16|F16|F32)",
                       re.IGNORECASE)
# Un GGUF decoupe en parties (`…-00001-of-00003.gguf`) n'est chargeable qu'avec
# TOUTES ses parties : en telecharger une seule donnerait un modele casse.
_SPLIT_RE = re.compile(r"-\d{5}-of-\d{5}\.gguf$", re.IGNORECASE)

_LOCK = threading.Lock()
_CACHE: dict[str, tuple[float, Any]] = {}


def _cached(key: str, build: Callable[[], Any]) -> Any:
    """Memoïse un appel reseau (TTL) : rouvrir le modal ne reinterroge pas le Hub."""
    now = time.time()
    with _LOCK:
        hit = _CACHE.get(key)
        if hit and now - hit[0] < HUB_TTL:
            return hit[1]
    value = build()
    with _LOCK:
        _CACHE[key] = (time.time(), value)
    return value


def _api():
    """Client Hugging Face (import local : jamais au chargement du module)."""
    from huggingface_hub import HfApi
    return HfApi()


def quant_of(filename: str) -> str:
    """Quantification lisible extraite du nom de fichier ('' si inconnue)."""
    match = _QUANT_RE.search(filename or "")
    return match.group(1).upper() if match else ""


def _unavailable(what: str, exc: Exception) -> str:
    _tprint(f"[hub] {what} indisponible : {exc}")
    return json.dumps(
        {"error": "Catalogue Hugging Face indisponible (verifie la connexion reseau)."},
        ensure_ascii=False)


def search_models(query: str, limit: int = 20) -> str:
    """Repos GGUF correspondant a ``query``, du plus telecharge au moins.

    Returns:
        JSON ``{query, models:[{repo_id, downloads, likes, gated, updated}]}``
        ou ``{error}`` (reseau).
    """
    query = (query or "").strip()
    if not query:
        return json.dumps({"query": "", "models": []}, ensure_ascii=False)
    wanted = max(1, min(50, int(limit or 20)))

    def build() -> list[dict]:
        # `sort="downloads"` trie deja du plus telecharge au moins (cette version
        # de huggingface_hub n'accepte pas de `direction`).
        return [
            {"repo_id": info.id,
             "downloads": int(getattr(info, "downloads", 0) or 0),
             "likes": int(getattr(info, "likes", 0) or 0),
             "gated": bool(getattr(info, "gated", False)),
             "updated": str(getattr(info, "last_modified", "") or "")[:10]}
            for info in _api().list_models(search=query, filter="gguf",
                                           sort="downloads", limit=wanted)
        ]

    try:
        models = _cached(f"search:{query}:{wanted}", build)
    except Exception as exc:
        return _unavailable(f"recherche {query!r}", exc)
    return json.dumps({"query": query, "models": models}, ensure_ascii=False)


def repo_files(repo_id: str) -> str:
    """Fichiers GGUF d'un depot, avec taille et compatibilite avec la machine.

    Returns:
        JSON ``{repo_id, budget_gb, files:[{filename, size_bytes, quant, fits,
        hint}]}`` ou ``{error}``.
    """
    repo_id = (repo_id or "").strip()
    if "/" not in repo_id:
        return json.dumps({"error": f"Depot Hugging Face invalide : {repo_id!r}"},
                          ensure_ascii=False)
    try:
        files = _cached(f"files:{repo_id}", lambda: _list_gguf(repo_id))
    except Exception as exc:
        return _unavailable(f"fichiers de {repo_id!r}", exc)
    budget = _mem_budget_gb(probe_hardware())
    return json.dumps({
        "repo_id": repo_id,
        "budget_gb": round(budget, 1),
        "files": [{**item, **_fit(item.get("size_bytes", 0), budget)} for item in files],
    }, ensure_ascii=False)


def _list_gguf(repo_id: str) -> list[dict]:
    """GGUF du depot (nom, taille, quantification), du plus petit au plus gros."""
    info = _api().model_info(repo_id, files_metadata=True)
    out = []
    for sibling in (getattr(info, "siblings", None) or []):
        name = str(getattr(sibling, "rfilename", "") or "")
        if not name.endswith(".gguf"):
            continue
        out.append({"filename": name,
                    "size_bytes": int(getattr(sibling, "size", 0) or 0),
                    "quant": quant_of(name),
                    "split": bool(_SPLIT_RE.search(name))})
    out.sort(key=lambda item: item["size_bytes"])
    return out


def _fit(size_bytes: int, budget_gb: float) -> dict:
    """Verdict d'aide (jamais bloquant) : le modele tient-il en memoire ?"""
    if not size_bytes:
        return {"fits": None, "hint": "taille inconnue"}
    size_gb = size_bytes / 1024 ** 3
    return {"fits": size_gb * 1.15 <= budget_gb,
            "hint": f"{size_gb:.1f} Go pour {budget_gb:.1f} Go disponibles"}
