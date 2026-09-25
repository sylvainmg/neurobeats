"""Tests du navigateur Hugging Face (services/hub.py) — sans reseau.

Le client `HfApi` est remplace par un double : on verifie la mise en forme des
resultats, le filtrage et le tri des GGUF, l'extraction de la quantification, le
verdict de compatibilite memoire, le cache, et le message d'indisponibilite.
Aucun appel sortant n'est effectue.

Usage: backend/.venv/bin/python backend/tests/test_hub.py
"""
import json
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))

from services import hub  # noqa: E402

CHECKS = []


def check(name: str, condition: bool, detail: str = "") -> None:
    CHECKS.append(bool(condition))
    suffix = f"  [{detail}]" if detail else ""
    print(f"  {'OK   ' if condition else 'ECHEC'} {name}{suffix}")


class FakeSibling:
    def __init__(self, rfilename: str, size: int = 0) -> None:
        self.rfilename = rfilename
        self.size = size


class FakeInfo:
    def __init__(self, repo_id: str, files: list[tuple[str, int]]) -> None:
        self.id = repo_id
        self.downloads = 1234
        self.likes = 7
        self.gated = False
        self.last_modified = "2026-09-01T10:00:00.000Z"
        self.siblings = [FakeSibling(name, size) for name, size in files]


class FakeApi:
    """Double de HfApi : compte les appels pour verifier le cache."""

    calls = {"search": 0, "info": 0}
    fail = False

    def list_models(self, **kwargs):
        FakeApi.calls["search"] += 1
        FakeApi.last_search = kwargs
        if FakeApi.fail:
            raise ConnectionError("reseau coupe")
        return [
            FakeInfo("bartowski/Qwen_Qwen3-4B-GGUF",
                     [("Qwen_Qwen3-4B-Q4_K_M.gguf", 2_500_000_000),
                      ("Qwen_Qwen3-4B-Q8_0.gguf", 4_300_000_000),
                      ("README.md", 2_000),
                      ("tokenizer.json", 11_000_000)]),
        ]

    def model_info(self, repo_id, **kwargs):
        FakeApi.calls["info"] += 1
        if FakeApi.fail:
            raise ConnectionError("reseau coupe")
        return FakeInfo(repo_id, [
            ("Model-Q8_0.gguf", 8_000_000_000),
            ("Model-Q4_K_M.gguf", 2_000_000_000),
            ("Model-Q8_0-00001-of-00002.gguf", 4_000_000_000),
            ("config.json", 900),
        ])


def reset() -> None:
    hub._CACHE.clear()
    FakeApi.calls.update({"search": 0, "info": 0})
    FakeApi.fail = False
    hub._api = lambda: FakeApi()


def cas_quantification():
    check("quant : Q4_K_M reconnue", hub.quant_of("Model-Q4_K_M.gguf") == "Q4_K_M",
          hub.quant_of("Model-Q4_K_M.gguf"))
    check("quant : IQ1_S reconnue", hub.quant_of("x-IQ1_S.gguf") == "IQ1_S",
          hub.quant_of("x-IQ1_S.gguf"))
    check("quant : absente -> vide", hub.quant_of("modele.gguf") == "",
          hub.quant_of("modele.gguf"))


def cas_recherche():
    reset()
    out = json.loads(hub.search_models("qwen3 gguf", 5))
    check("recherche : pas d'erreur", "error" not in out, str(out)[:80])
    check("recherche : un depot", len(out["models"]) == 1, str(out["models"]))
    repo = out["models"][0]
    check("recherche : champs utiles",
          repo["repo_id"] == "bartowski/Qwen_Qwen3-4B-GGUF" and repo["downloads"] == 1234
          and repo["likes"] == 7 and repo["gated"] is False, str(repo))
    check("recherche : filtre gguf transmis", FakeApi.last_search.get("filter") == "gguf",
          str(FakeApi.last_search))
    check("recherche : tri par telechargements",
          FakeApi.last_search.get("sort") == "downloads", str(FakeApi.last_search))

    hub.search_models("qwen3 gguf", 5)
    check("recherche : deuxieme appel servi par le cache", FakeApi.calls["search"] == 1,
          str(FakeApi.calls))

    out = json.loads(hub.search_models("   ", 5))
    check("recherche : requete vide -> aucun appel", FakeApi.calls["search"] == 1
          and out["models"] == [], str(out))


def cas_fichiers():
    reset()
    out = json.loads(hub.repo_files("bartowski/Repo-GGUF"))
    check("fichiers : pas d'erreur", "error" not in out, str(out)[:80])
    names = [f["filename"] for f in out["files"]]
    check("fichiers : seuls les .gguf sont listes",
          names == ["Model-Q4_K_M.gguf", "Model-Q8_0-00001-of-00002.gguf", "Model-Q8_0.gguf"],
          str(names))
    check("fichiers : tries du plus petit au plus gros",
          out["files"][0]["size_bytes"] < out["files"][1]["size_bytes"], str(names))
    check("fichiers : quantification extraite", out["files"][0]["quant"] == "Q4_K_M",
          str(out["files"][0]))
    check("fichiers : partie decoupee signalee",
          out["files"][1]["split"] is True and not out["files"][0]["split"],
          str([(f["filename"], f["split"]) for f in out["files"]]))
    check("fichiers : verdict de compatibilite present",
          isinstance(out["files"][0]["fits"], bool) and bool(out["files"][0]["hint"]),
          str(out["files"][0]))
    check("fichiers : budget annonce", out.get("budget_gb", 0) > 0, str(out.get("budget_gb")))

    out = json.loads(hub.repo_files("depot-invalide"))
    check("fichiers : depot invalide refuse", "error" in out, str(out)[:60])


def cas_indisponible():
    reset()
    FakeApi.fail = True
    out = json.loads(hub.search_models("qwen3", 5))
    check("panne : message d'indisponibilite", "indisponible" in (out.get("error") or ""),
          str(out.get("error"))[:70])
    out = json.loads(hub.repo_files("bartowski/Repo-GGUF"))
    check("panne : depot indisponible", "indisponible" in (out.get("error") or ""),
          str(out.get("error"))[:70])
    # Le cache ne conserve pas un echec : un second essai reinterroge.
    FakeApi.fail = False
    out = json.loads(hub.search_models("qwen3", 5))
    check("panne : retablissement sans cache negatif", "error" not in out, str(out)[:60])


def main() -> int:
    original_api = hub._api
    try:
        print("cas 1 : extraction de la quantification")
        cas_quantification()
        print("cas 2 : recherche de depots")
        cas_recherche()
        print("cas 3 : fichiers GGUF d'un depot")
        cas_fichiers()
        print("cas 4 : indisponibilite reseau")
        cas_indisponible()
    finally:
        hub._api = original_api
        hub._CACHE.clear()
    ok = sum(CHECKS)
    print(f"\n{ok}/{len(CHECKS)} verifications OK")
    return 0 if ok == len(CHECKS) else 1


if __name__ == "__main__":
    sys.exit(main())
