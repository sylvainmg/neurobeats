"""Config IA : sélection unique, masquage, conversions, test de connexion.

Script autonome (meme style que test_transfer.py) : sort en code 1 si un cas
echoue. Aucun acces reseau, et aucun effet de bord : le repertoire des modeles
est temporaire, l'alignement du moteur local est neutralise (on verifie qu'il
est *demande*, sans lancer de process), et la cle `ai` du profil est sauvegardee
en entree puis restauree en sortie.

Usage: backend/.venv/bin/python backend/tests/test_ai_settings.py
"""
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))

# Doit preceder l'usage : `models.models_dir()` lit cette variable a l'appel.
_TEMP_MODELS = tempfile.mkdtemp(prefix="neurobeats-ai-settings-")
os.environ["NEUROBEATS_MODELS_DIR"] = _TEMP_MODELS

from services import llm  # noqa: E402
from services import models  # noqa: E402
from services.db_access import profile_read, profile_write  # noqa: E402

CHECKS = []
_SAVED_AI = None
# Cibles demandees a l'alignement du moteur : (kind, model) par appel.
_ALIGNED: list = []
# Alignement reel (on le remplace pour ne lancer aucun process).
_REAL_ALIGN = llm.align_engine


def check(name, ok, detail=""):
    CHECKS.append(bool(ok))
    print(f"  {'OK   ' if ok else 'ECHEC'} {name}" + (f"  [{detail}]" if detail else ""))


def _no_align(selection=None):
    """Remplace l'alignement du moteur : enregistre la cible, ne lance rien."""
    _ALIGNED.append(selection or llm.active_selection())


def _fake_model(model_id: str) -> None:
    """Enregistre un faux modele telecharge (manifeste + fichier present)."""
    os.makedirs(_TEMP_MODELS, exist_ok=True)
    file = os.path.join(_TEMP_MODELS, f"{model_id}.gguf")
    with open(file, "wb") as handle:
        handle.write(b"gguf")
    path = os.path.join(_TEMP_MODELS, "manifest.json")
    try:
        manifest = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        manifest = {}
    manifest[model_id] = {"model_id": model_id, "name": model_id, "file": file,
                          "size_bytes": os.path.getsize(file)}
    Path(path).write_text(json.dumps(manifest), encoding="utf-8")


def restaurer_ai():
    """Remet la config `ai` du profil a sa valeur d'entree (test sans effet)."""
    profile = profile_read()
    if _SAVED_AI is None:
        profile.pop("ai", None)
    else:
        profile["ai"] = _SAVED_AI
    profile_write(profile)


def _ai_record() -> dict:
    return profile_read().get("ai") or {}


def cas_masquage():
    check("cle courte -> masque court", llm.mask_api_key("abc") == "•••", llm.mask_api_key("abc"))
    check("prefixe sk garde 4 + 4", llm.mask_api_key("sk-proj-xYz999") == "sk-p•••z999",
          llm.mask_api_key("sk-proj-xYz999"))
    check("non-sk garde 2 + 4", llm.mask_api_key("secretValue12") == "se•••ue12",
          llm.mask_api_key("secretValue12"))


def cas_configured():
    d = dict(llm.DEFAULTS)
    d["provider"] = "ollama"
    check("ollama defaut configure", llm.is_configured(d) is True)
    d["provider"] = "lmstudio"
    check("lmstudio base_url suffit", llm.is_configured(d) is True)
    d["provider"] = "openai"
    d["openai"]["api_key"] = ""
    check("openai sans cle PAS configure", llm.is_configured(d) is False)
    d["openai"]["api_key"] = "sk-ok"
    check("openai avec cle configure", llm.is_configured(d) is True)
    d["provider"] = "anthropic"
    d["anthropic"]["api_key"] = ""
    check("anthropic sans cle PAS configure", llm.is_configured(d) is False)


def cas_persistance():
    out = llm.save_ai_config(provider="anthropic",
                             anthropic={"base_url": "https://api.anthropic.com",
                                        "model": "claude-x", "api_key": "sk-ant-secret"})
    d = json.loads(out)
    check("provider persiste", d["provider"] == "anthropic", d["provider"])
    check("configured devient True", d["configured"] is True, d["configured"])
    check("cle masquee en lecture", d["anthropic"].get("api_key_masked", "").startswith("sk-"),
          d["anthropic"].get("api_key_masked"))
    check("cle jamais lisible", "api_key" not in d["anthropic"])

    try:
        llm.save_ai_config(provider="toto-nope")
        check("fournisseur inconnu refuse", False, "aucune erreur levee")
    except ValueError as exc:
        check("fournisseur inconnu refuse", "inconnu" in str(exc), str(exc)[:60])

    # api_key=None conserve ; "" efface ; champs inconnus ignores
    out = json.loads(llm.save_ai_config(anthropic={"api_key": None,
                                                   "api_key_masked": "DIAP", "toto": 1}))
    check("api_key=None conserve", out["configured"] is True, out["configured"])
    out = json.loads(llm.save_ai_config(anthropic={"api_key": ""}))
    check("api_key vide efface", out["configured"] is False, out["configured"])
    check("champ inconnu ignore", "toto" not in llm._stored()["anthropic"]
          and "api_key_masked" not in llm._stored()["anthropic"])

    # Le choix est UN enregistrement : `selection` porte le modele local, aucun
    # port de session n'est persiste, et les cles de l'ancien format disparaissent.
    _fake_model("test-model")
    llm.save_ai_config(provider="embedded", embedded={
        "model": "test-model", "base_url": "http://127.0.0.1:45678/v1"
    })
    record = _ai_record()
    check("selection : modele local persiste",
          record.get("selection") == {"kind": "embedded", "model": "test-model"},
          str(record.get("selection")))
    check("selection : aucune cle de l'ancien format",
          "provider" not in record and "last_external_provider" not in record
          and "embedded" not in record, str(sorted(record)))
    view = json.loads(llm.get_ai_config())
    check("selection : provider derive de la selection",
          view["provider"] == "embedded" and view.get("actual_provider") is None,
          str(view.get("provider")))
    check("selection : selection canonique exposee",
          view.get("selection") == {"kind": "embedded", "model": "test-model"},
          str(view.get("selection")))

    # retour a ollama propre
    out = json.loads(llm.save_ai_config(provider="ollama"))
    check("retour ollama configure", out["provider"] == "ollama" and out["configured"] is True)


def cas_selection_unique():
    """Un seul choix : prendre l'un desélectionne tout le reste (et aligne le moteur)."""
    _ALIGNED.clear()
    llm.align_engine = _no_align
    try:
        _fake_model("modele-a")
        _fake_model("modele-b")

        llm.set_selection("ollama")
        check("externe : selection unique", llm.active_selection() == {"kind": "ollama"},
              str(llm.active_selection()))
        check("externe : moteur local arrete", _ALIGNED[-1] == {"kind": "ollama"},
              str(_ALIGNED[-1]))

        llm.set_selection("embedded", model="modele-a")
        check("local A : selection unique",
              llm.active_selection() == {"kind": "embedded", "model": "modele-a"},
              str(llm.active_selection()))
        check("local A : moteur aligne sur A",
              _ALIGNED[-1] == {"kind": "embedded", "model": "modele-a"}, str(_ALIGNED[-1]))

        llm.set_selection("embedded", model="modele-b")
        check("local B : A est desélectionne (remplace)",
              llm.active_selection() == {"kind": "embedded", "model": "modele-b"},
              str(llm.active_selection()))

        llm.set_selection("lmstudio")
        check("retour externe : local desélectionne",
              llm.active_selection() == {"kind": "lmstudio"}, str(llm.active_selection()))
        check("retour externe : moteur arrete", _ALIGNED[-1] == {"kind": "lmstudio"},
              str(_ALIGNED[-1]))

        # Un modele inconnu du manifeste ne peut pas devenir le choix.
        try:
            llm.set_selection("embedded", model="pas-telecharge")
            check("local non telecharge refuse", False, "aucune erreur levee")
        except ValueError as exc:
            check("local non telecharge refuse", "non telecharge" in str(exc), str(exc)[:60])

        # `save_ai_config` (forme historique) converge vers la meme ecriture.
        llm.save_ai_config(provider="embedded", embedded={"model": "modele-a"})
        check("forme historique : meme selection",
              llm.active_selection() == {"kind": "embedded", "model": "modele-a"},
              str(llm.active_selection()))
        llm.save_ai_config(provider="embedded",
                           selection={"kind": "embedded", "model": "modele-b"})
        check("forme canonique : selection appliquee",
              llm.active_selection() == {"kind": "embedded", "model": "modele-b"},
              str(llm.active_selection()))
    finally:
        llm.align_engine = _REAL_ALIGN
        llm.save_ai_config(provider="ollama")


def cas_migration_ancien_format():
    """L'ancien `provider` + `embedded.model` migre vers `selection`, une seule fois."""
    profile = profile_read()
    profile["ai"] = {"provider": "embedded", "embedded": {"model": "vieux-modele"},
                     "last_external_provider": "ollama",
                     "ollama": {"host": "http://localhost:11434", "model": "m"}}
    profile_write(profile)
    check("migration : ancien format lu",
          llm.active_selection() == {"kind": "embedded", "model": "vieux-modele"},
          str(llm.active_selection()))
    check("migration : reecriture effectuee", llm.migrate_ai_selection() is True)
    record = _ai_record()
    check("migration : selection ecrite",
          record.get("selection") == {"kind": "embedded", "model": "vieux-modele"},
          str(record.get("selection")))
    check("migration : cles legacy supprimees",
          "provider" not in record and "last_external_provider" not in record,
          str(sorted(record)))
    check("migration : configuration preservee",
          record.get("ollama", {}).get("host") == "http://localhost:11434",
          str(record.get("ollama")))
    check("migration : idempotente", llm.migrate_ai_selection() is False)


def cas_modele_suit_la_selection():
    """Le modele interroge suit LA selection, jamais l'etat du moteur."""
    previous_state = models._SERVER
    previous_proc = models._SERVER_PROC
    llm.align_engine = _no_align
    try:
        _fake_model("choisi")
        models._SERVER = {"pid": 424242, "port": 59991, "model_id": "autre-modele"}
        llm.set_selection("embedded", model="choisi")
        cfg = llm._stored()
        check("modele : celui de la selection, pas du moteur charge",
              llm._model("embedded", cfg) == "choisi", llm._model("embedded", cfg))
    finally:
        models._SERVER = previous_state
        models._SERVER_PROC = previous_proc
        llm.align_engine = _REAL_ALIGN
        llm.save_ai_config(provider="ollama")


def cas_conversion_openai():
    convo = [
        {"role": "system", "content": "S"},
        {"role": "user", "content": "u1"},
        {"role": "assistant", "content": "",
         "tool_calls": [{"function": {"name": "a", "arguments": {"x": 1}}}]},
        {"role": "tool", "content": "r"},
    ]
    out = llm._convo_openai(convo)
    calls = out[2]
    check("tool_calls OpenAI references id", calls["tool_calls"][0]["id"] != "", "")
    check("arguments stringifies", isinstance(calls["tool_calls"][0]["function"]["arguments"], str),
          calls["tool_calls"][0]["function"]["arguments"])
    check("message tool pointe le bon id",
          out[3]["tool_call_id"] == calls["tool_calls"][0]["id"], out[3]["tool_call_id"])


def cas_conversion_anthropic():
    convo = [
        {"role": "system", "content": "S"},
        {"role": "user", "content": "u1"},
        {"role": "assistant", "content": "",
         "tool_calls": [{"function": {"name": "a", "arguments": {"x": 1}}}]},
        {"role": "tool", "content": "r"},
        {"role": "user", "content": "u2"},
    ]
    system, out = llm._convo_anthropic(convo)
    check("system extrait", system == "S", system)
    tool_use = out[1]["content"][0]
    check("tool_use au format Anthropic", tool_use.get("type") == "tool_use"
          and tool_use.get("input") == {"x": 1}, str(tool_use))
    check("user consecutifs fusionnes",
          out[-1]["role"] == "user" and out[-1]["content"][-1]["type"] == "text",
          str(out[-1]['content']))
    check("tool_result rattache au bon id",
          out[2]["content"][0]["tool_use_id"] == tool_use["id"],
          out[2]["content"][0]["tool_use_id"])

    tools = [{"type": "function", "function": {"name": "b", "description": "d",
                                               "parameters": {"type": "object", "properties": {}}}}]
    converted = llm._tools_anthropic(tools)
    check("input_schema remplace parameters", "input_schema" in converted[0]
          and "parameters" not in converted[0], str(converted))


def cas_connexion():
    import services.chat as chat

    def ok_chat(messages, **kwargs):
        return {"message": {"role": "assistant", "content": "OK"}}

    def ko_chat(messages, **kwargs):
        raise ConnectionError("serveur injoignable")

    chat.llm.chat = ok_chat
    res = json.loads(chat.llm.test_connection())
    check("test connexion OK", res["ok"] is True and res.get("latency_ms", 0) >= 0, str(res))
    chat.llm.chat = ko_chat
    res = json.loads(chat.llm.test_connection())
    check("test connexion KO sans lever", res["ok"] is False and "error" in res, str(res))

    # Valeurs volantes du formulaire : le test epouse la config candidate
    # (le model affiche est celui en cours d'edition, pas celui persiste).
    seen = {}
    before = llm._stored()

    def spy_chat(messages, **kwargs):
        seen["config"] = kwargs.get("config")
        return {"message": {"role": "assistant", "content": "OK"}}

    chat.llm.chat = spy_chat
    res = json.loads(chat.llm.test_connection(
        provider="lmstudio",
        lmstudio={"base_url": "http://127.0.0.1:9/v1", "model": "MODELE-VOLANT"}))
    check("test volant : model repris du formulaire",
          res["ok"] is True and res.get("model") == "MODELE-VOLANT"
          and res.get("provider") == "lmstudio", str(res))
    after = llm._stored()
    check("test volant : rien persiste",
          after == before
          and seen.get("config", {}).get("lmstudio", {}).get("model") == "MODELE-VOLANT",
          str(after.get("lmstudio")))


def cas_embedded_non_charge():
    """Un seul modele actif : sans serveur local, aucun repli vers l'externe."""
    previous = models._SERVER, models._SERVER_PROC
    try:
        models._SERVER, models._SERVER_PROC = None, None
        try:
            llm._default_client("embedded", 5.0)
            check("embedded non charge : client refuse", False, "aucune erreur levee")
        except RuntimeError as exc:
            check("embedded non charge : erreur explicite",
                  "pas encore chargé" in str(exc), str(exc)[:70])
        res = json.loads(llm.test_connection(provider="embedded",
                                             embedded={"model": "qwen3-8b"}))
        check("embedded non charge : test explicite",
              res.get("ok") is False and "pas encore chargé" in (res.get("error") or ""),
              str(res.get("error"))[:70])
    finally:
        models._SERVER, models._SERVER_PROC = previous


def main():
    global _SAVED_AI
    _SAVED_AI = profile_read().get("ai")
    try:
        print("cas 1 : masquage des cles")
        cas_masquage()
        print("cas 2 : flag configured par fournisseur")
        cas_configured()
        print("cas 3 : persistance / masquage / validation")
        cas_persistance()
        print("cas 4 : sélection unique (un seul choix, le reste desélectionne)")
        cas_selection_unique()
        print("cas 5 : migration de l'ancien format vers `selection`")
        cas_migration_ancien_format()
        print("cas 6 : le modèle interrogé suit la sélection")
        cas_modele_suit_la_selection()
        print("cas 7 : conversions OpenAI")
        cas_conversion_openai()
        print("cas 8 : conversions Anthropic")
        cas_conversion_anthropic()
        print("cas 9 : test de connexion (fakes)")
        cas_connexion()
        print("cas 10 : modele local non charge")
        cas_embedded_non_charge()
    finally:
        restaurer_ai()
        shutil.rmtree(_TEMP_MODELS, ignore_errors=True)
    n_ok = sum(1 for c in CHECKS if c)
    n = len(CHECKS)
    print(f"\n{n_ok}/{n} verifications OK")
    sys.exit(0 if n_ok == n else 1)


if __name__ == "__main__":
    main()