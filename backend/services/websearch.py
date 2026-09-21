"""Recherche en ligne : source factuelle externe exposee a l'agent.

Interroge deux sources publiques sans cle d'API et renvoie des extraits bruts :
1. DuckDuckGo (HTML) : recherche web large ;
2. Wikipedia (API) : repli fiable et rapide.

Toutes les fonctions renvoient du JSON (convention du projet).
"""
import html as _html
import json
import re
import urllib.parse
import urllib.request

from services.state import _tprint

_TIMEOUT = 12.0
_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")

_DDG_ITEM = re.compile(
    r'<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', re.S)
_DDG_SNIPPET = re.compile(r'class="result__snippet"[^>]*>(.*?)</a>', re.S)
_TAGS = re.compile(r"<[^>]+>")


def _clean(fragment: str) -> str:
    text = _TAGS.sub("", fragment or "")
    return re.sub(r"\s+", " ", _html.unescape(text)).strip()


def _real_url(href: str) -> str:
    """DuckDuckGo encapsule ses liens (`/l/?uddg=<url>`)."""
    if "uddg=" in href:
        query = urllib.parse.urlparse(href).query
        target = urllib.parse.parse_qs(query).get("uddg", [""])[0]
        if target:
            return target
    return href if href.startswith("http") else f"https:{href}" if href.startswith("//") else href


def _duckduckgo(query: str, limit: int) -> list:
    url = "https://html.duckduckgo.com/html/?q=" + urllib.parse.quote_plus(query)
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as response:
        body = response.read().decode("utf-8", "replace")
    titles = _DDG_ITEM.findall(body)
    snippets = [_clean(s) for s in _DDG_SNIPPET.findall(body)]
    results = []
    for index, (href, title_html) in enumerate(titles[:limit]):
        results.append({
            "title": _clean(title_html),
            "url": _real_url(href),
            "snippet": snippets[index] if index < len(snippets) else "",
        })
    return results


def _wikipedia(query: str, limit: int) -> list:
    """Recherche Wikipedia (fr puis en) : titre + extrait de l'article."""
    for lang in ("fr", "en"):
        search_url = (
            f"https://{lang}.wikipedia.org/w/api.php?action=query&list=search"
            f"&srsearch={urllib.parse.quote_plus(query)}&format=json&srlimit={limit}"
        )
        req = urllib.request.Request(search_url, headers={"User-Agent": "NeuroBeats/1.0"})
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as response:
            data = json.load(response)
        hits = (data.get("query") or {}).get("search") or []
        if not hits:
            continue
        results = []
        for hit in hits[:limit]:
            title = hit.get("title", "")
            results.append({
                "title": title,
                "url": f"https://{lang}.wikipedia.org/wiki/{urllib.parse.quote(title.replace(' ', '_'))}",
                "snippet": _clean(hit.get("snippet", "")),
            })
        return results
    return []


def web_search(query: str, max_results: int = 5) -> str:
    """Interroge le web et retourne des extraits bruts (titre, url, extrait).

    Args:
        query: requete de recherche.
        max_results: nombre de resultats (borne a 1-8).

    Returns:
        JSON {source, query, results:[{title,url,snippet}]} ou {error} si aucune
        source n'a repondu.
    """
    text = (query or "").strip()
    if not text:
        return json.dumps({"error": "Requete de recherche vide."}, ensure_ascii=False)
    try:
        limit = max(1, min(int(max_results or 5), 8))
    except (TypeError, ValueError):
        limit = 5

    for source, fetch in (("duckduckgo", _duckduckgo), ("wikipedia", _wikipedia)):
        try:
            results = fetch(text, limit)
        except Exception as exc:
            _tprint(f"[websearch] {source} echec : {str(exc)[:100]}")
            continue
        if results:
            return json.dumps({"source": source, "query": text, "results": results},
                              ensure_ascii=False)
    return json.dumps(
        {"error": "Recherche en ligne indisponible (verifie la connexion reseau)."},
        ensure_ascii=False)
