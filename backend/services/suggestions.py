"""Points de depart de recherche, libelles par l'IA.

Le libelle n'est pas tire d'une liste codee en dur : le LLM le redige a partir du
profil d'ecoute de l'utilisateur (genres et artistes les plus presents), accompagne
d'extraits de recherche web collectes cote serveur. Si le LLM ne produit rien
d'exploitable, aucun libelle n'est renvoye.

Meme contrat que l'accueil / Decouvrir : construction en arriere-plan, cache RAM,
`building` ; la requete ne bloque jamais.
"""
import json
import re
import threading
import time
from collections import Counter

import ollama

from core.config import MODEL
from services.chat import SUGGEST_SYSTEM
from services.db_access import hist_read
from services.genres import GENERIC_CHANNELS
from services.state import _tprint
from services.websearch import web_search

SUGGEST_TTL = 900
MAX_SUGGESTIONS = 6

# Appel LLM dedie : sortie JSON imposee (`format="json"`), sans boucle d'outils —
# les extraits web sont collectes cote serveur et fournis dans le prompt.
_OLLAMA = ollama.Client(timeout=120.0)

_LOCK = threading.Lock()
_CACHE: dict = {}
_BUILDING = False


def _seed() -> dict:
    """Profil d'ecoute reel : genres et artistes les plus presents."""
    history = hist_read(300)
    genres = Counter(
        (h.get("genre") or "").strip() for h in history if (h.get("genre") or "").strip()
    )
    genres.pop("autre", None)
    artists = Counter(
        h.get("channel") for h in history
        if h.get("channel") and h.get("channel") not in GENERIC_CHANNELS
    )
    return {
        "genres": [g for g, _ in genres.most_common(4)],
        "artists": [c for c, _ in artists.most_common(3)],
    }


def _web_facts(artists: list) -> list:
    """Extraits de recherche web sur les artistes principaux.

    Collectes cote serveur pour etre fournis au modele avec le profil d'ecoute.
    """
    facts = []
    for artist in artists[:2]:
        try:
            data = json.loads(web_search(f"{artist} genre musical", 3))
        except Exception as exc:
            _tprint(f"[suggest] web_search {artist!r} echec : {str(exc)[:80]}")
            continue
        snippets = [
            f"{r.get('title', '')} — {r.get('snippet', '')}".strip(" —")
            for r in data.get("results", [])[:2]
            if r.get("snippet") or r.get("title")
        ]
        if snippets:
            facts.append({"artiste": artist, "sources": snippets})
    return facts


def _words(text: str) -> set:
    return set(re.findall(r"[a-z0-9]+", (text or "").lower()))


def _sanitize_query(label: str, query: str, artists: list) -> str:
    """Ramene la requete au theme du libelle.

    Le modele prefixe volontiers les requetes par les artistes du profil
    (« Lomepal lofi ») : cliquer sur un genre revient alors a rechercher ses
    artistes habituels, et la recherche ne correspond plus au libelle lu. On
    retire donc les artistes dont le libelle ne parle pas, puis on retombe sur
    le libelle si la requete ne partage plus rien avec lui (sinon on
    rechercherait « feat », par exemple).
    """
    cleaned = query
    for artist in artists or []:
        name = (artist or "").strip()
        if not name or name.lower() in label.lower():
            continue  # le libelle nomme l'artiste : la requete peut le garder
        cleaned = re.sub(rf"\b{re.escape(name)}\b", " ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" -–—,.")
    related = any(part in label_word or label_word in part
                  for part in _words(cleaned) for label_word in _words(label))
    if len(cleaned) < 3 or not related:
        return label
    return cleaned


def _parse_suggestions(reply: str, artists: list | None = None) -> list:
    """Extrait la liste JSON de la reponse du modele (tolere du texte autour)."""
    if not reply:
        return []
    match = re.search(r"\{.*\}", reply, re.S)
    if not match:
        return []
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return []
    out, seen = [], set()
    for item in (data.get("suggestions") or []):
        if not isinstance(item, dict):
            continue
        label = str(item.get("label", "")).strip()
        query = str(item.get("query", "")).strip() or label
        if not label or label.lower() in seen:
            continue
        seen.add(label.lower())
        out.append({"label": label[:40],
                    "query": _sanitize_query(label, query, artists or [])[:80]})
        if len(out) >= MAX_SUGGESTIONS:
            break
    return out


def _ask_llm(payload: dict) -> str:
    """Demande les libelles au LLM (JSON impose, sans outils)."""
    response = _OLLAMA.chat(
        model=MODEL,
        messages=[
            {"role": "system", "content": SUGGEST_SYSTEM},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ],
        options={"temperature": 0.4},
        format="json",
    )
    message = response.get("message") or {}
    return message.get("content", "") if isinstance(message, dict) else getattr(message, "content", "")


def _build():
    """Construit les libelles (IA + faits web) et remplace le cache."""
    global _CACHE, _BUILDING
    suggestions = []
    try:
        seed = _seed()
        if seed["genres"] or seed["artists"]:
            payload = {
                "genres_ecoutes": seed["genres"],
                "artistes_ecoutes": seed["artists"],
                "sources_web": _web_facts(seed["artists"]),
            }
            suggestions = _parse_suggestions(_ask_llm(payload), seed["artists"])
            _tprint(f"[suggest] {len(suggestions)} libelle(s) IA propose(s)")
    except Exception as exc:
        _tprint(f"[suggest] construction echec : {exc}")
    with _LOCK:
        _CACHE.clear()
        _CACHE.update({"suggestions": suggestions, "generated_at": int(time.time())})
        _CACHE["building"] = False
    _BUILDING = False


def _ensure_fresh(force: bool = False):
    """Lance une construction en fond si le cache est vide ou perime."""
    global _BUILDING
    with _LOCK:
        age = time.time() - _CACHE.get("generated_at", 0) if _CACHE else None
        fresh = age is not None and age < SUGGEST_TTL
        if _BUILDING or (fresh and not force):
            return
        _BUILDING = True
        _CACHE["building"] = True
    threading.Thread(target=_build, daemon=True, name="suggest").start()


def get_search_suggestions() -> str:
    """Libelles de recherche proposes par l'IA (peut etre vide : rien d'invente)."""
    _ensure_fresh()
    with _LOCK:
        payload = {"suggestions": list(_CACHE.get("suggestions", [])),
                   "building": _BUILDING}
    return json.dumps(payload, ensure_ascii=False)


def refresh_search_suggestions() -> str:
    """Force une nouvelle proposition (bouton « regenerer » cote UI)."""
    _ensure_fresh(force=True)
    return json.dumps({"status": "refreshing"}, ensure_ascii=False)
