"""Config IA : masquage, persistance, conversions providers, test de connexion.

Script autonome (meme style que test_transfer.py) : sort en code 1 si un cas
echoue. Aucun acces reseau : les appels LLM sont stubes (`llm.chat` fake). La
cle `ai` du profil est sauvegardee en entree et restauree en sortie, pour ne pas
polluer la base de dev.

Usage: backend/.venv/bin/python backend/tests/test_ai_settings.py
"""
import json
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))

from services import llm  # noqa: E402
from services.db_access import profile_read, profile_write  # noqa: E402

CHECKS = []


def check(name, ok, detail=""):
    CHECKS.append(bool(ok))
    print(f"  {'OK   ' if ok else 'ECHEC'} {name}" + (f"  [{detail}]" if detail else ""))


def restaurer_ai():
    """Remet la config `ai` du profil a sa valeur initiale (test, pas d'effet)."""
    saved = profile_read().get("ai")
    profile = profile_read()
    if saved is None:
        profile.pop("ai", None)
    else:
        profile["ai"] = saved
    profile_write(profile)


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

    out = json.loads(llm.save_ai_config(provider="toto-nope"))  # fournisseur inconnu ignore
    check("provider inconnu inchange", out["provider"] == "anthropic", out["provider"])

    # api_key=None conserve ; "" efface ; champs inconnus ignores
    out = json.loads(llm.save_ai_config(anthropic={"api_key": None,
                                                   "api_key_masked": "DIAP", "toto": 1}))
    check("api_key=None conserve", out["configured"] is True, out["configured"])
    out = json.loads(llm.save_ai_config(anthropic={"api_key": ""}))
    check("api_key vide efface", out["configured"] is False, out["configured"])
    check("champ inconnu ignore", "toto" not in llm._stored()["anthropic"]
          and "api_key_masked" not in llm._stored()["anthropic"])

    # retour a ollama propre
    out = json.loads(llm.save_ai_config(provider="ollama"))
    check("retour ollama configure", out["provider"] == "ollama" and out["configured"] is True)


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


def main():
    try:
        print("cas 1 : masquage des cles")
        cas_masquage()
        print("cas 2 : flag configured par fournisseur")
        cas_configured()
        print("cas 3 : persistance / masquage / validation")
        cas_persistance()
        print("cas 4 : conversions OpenAI")
        cas_conversion_openai()
        print("cas 5 : conversions Anthropic")
        cas_conversion_anthropic()
        print("cas 6 : test de connexion (fakes)")
        cas_connexion()
    finally:
        restaurer_ai()
    n_ok = sum(1 for c in CHECKS if c)
    n = len(CHECKS)
    print(f"\n{n_ok}/{n} verifications OK")
    sys.exit(0 if n_ok == n else 1)


if __name__ == "__main__":
    main()