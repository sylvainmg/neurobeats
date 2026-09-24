"""Outils LLM : arguments JSON string + rechange <tool_call> texte.

Script autonome (meme style que test_transfer.py) : sort en code 1 si un cas
echoue. Aucun acces reseau : `llm.chat`/`llm.chat_stream` et table d'outils sont
stubes. Couvre le bug LM Studio (arguments en JSON string dans le chemin
streaming -> TypeError) et le fallback des modeles qui renvoient l'appel d'outil
en texte (`<tool_call>` dans content).

Usage: backend/.venv/bin/python backend/tests/test_chat_tools.py
"""
import json
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))

from services import chat  # noqa: E402

CHECKS = []


def check(name, ok, detail=""):
    CHECKS.append(bool(ok))
    print(f"  {'OK   ' if ok else 'ECHEC'} {name}" + (f"  [{detail}]" if detail else ""))


def fake_fn(**kwargs):
    """Outil factice : renvoie l'argument `query` recu (evidence d'appel)."""
    return json.dumps({"results": [{"title": kwargs.get("query", "")}]})


# Table d'outils reduite, sans I/O reseau. Sauvee / restauree par `main`.
_ORIG = {}


def stub_functions():
    chat._tool_functions = lambda: {"search_music": fake_fn}


def restaurer_functions():
    chat._tool_functions = _ORIG.get("tool_functions")


def restaurer_llm():
    chat.llm.chat = _ORIG.get("chat")
    chat.llm.chat_stream = _ORIG.get("chat_stream")


def cas_run_tool():
    fn = {"search_music": fake_fn}

    ok, res = chat._run_tool(fn, "search_music", '{"query": "Dreamboy"}')
    data = json.loads(res)
    check("run_tool : arguments JSON string decode",
          ok is True and data["results"][0]["title"] == "Dreamboy", res)

    ok, res = chat._run_tool(fn, "search_music", {"query": "GAZO"})
    data = json.loads(res)
    check("run_tool : arguments dict (Ollama) inchanges",
          ok is True and data["results"][0]["title"] == "GAZO", res)

    ok, _ = chat._run_tool(fn, "search_music", "[1, 2]")
    check("run_tool : arguments non-objet -> {} sans TypeError", ok is True, "")

    ok, _ = chat._run_tool(fn, "search_music", "{fragment invalide")
    check("run_tool : JSON fragmentaire -> {} sans TypeError", ok is True, "")

    ok, res = chat._run_tool(fn, "outil_inconnu", {"x": 1})
    check("run_tool : outil inconnu -> echec propre",
          ok is False and "Tool inconnu" in json.loads(res).get("error", ""), res)


def cas_parse_texte():
    json_form = (
        '<tool_call>\n{"name": "search_music", "arguments": {"query": "Dreamboy"}}\n'
        "</tool_call>"
    )
    parsed = chat._parse_text_tool_call("Avant " + json_form + " apres")
    check("parse texte : forme JSON",
          parsed and parsed["function"]["name"] == "search_music"
          and parsed["function"]["arguments"] == {"query": "Dreamboy"}, str(parsed))

    tags_form = (
        "<tool_call>\n<function=search_music>\n"
        "<parameter=query>Dreamboy Lil Nas X</parameter>\n"
        "</function>\n</tool_call>"
    )
    parsed = chat._parse_text_tool_call(tags_form)
    check("parse texte : forme tags Qwen",
          parsed and parsed["function"]["name"] == "search_music"
          and parsed["function"]["arguments"] == {"query": "Dreamboy Lil Nas X"},
          str(parsed))

    parsed = chat._parse_text_tool_call("Tu parles des outils sans les appeler.")
    check("parse texte : prose sans bloc -> None", parsed is None, str(parsed))

    stripped = chat._strip_text_tool("Bonjour <tool_call><function=a></tool_call> fini")
    check("strip texte : bloc retire", stripped == "Bonjour  fini", stripped)


def cas_stream_arguments_string():
    """Le vrai bug LM Studio : arguments en JSON string dans le flux SSE."""
    events = []
    rounds = {"n": 0}

    def fake_stream(convo, **kwargs):
        rounds["n"] += 1
        if rounds["n"] == 1:
            yield {"message": {"role": "assistant", "content": "",
                               "tool_calls": [
                                   {"function": {"name": "search_music",
                                                 "arguments": '{"query": "Dreamboy"}'}}]}}
        else:
            yield {"message": {"role": "assistant", "content": "J'ai lance la recherche."}}

    chat.llm.chat_stream = fake_stream
    for ev in chat.chat_stream([{"role": "user", "content": "Cherche Dreamboy"}]):
        events.append(ev)

    starts = [e for e in events if e["type"] == "tool_start"]
    ends = [e for e in events if e.get("type") == "tool_end"]
    check("stream : string JSON decode avant dispatch",
          len(starts) == 1 and starts[0]["arguments"] == {"query": "Dreamboy"}, str(starts))
    check("stream : outil execute (ok)", len(ends) == 1 and ends[0]["ok"] is True, str(ends))
    done = [e for e in events if e["type"] == "done"][0]
    check("stream : tool_calls remonte", len(done["tool_calls"]) == 1
          and done["tool_calls"][0]["ok"] is True, str(done["tool_calls"]))


def cas_stream_texte():
    """Fallback : l'appel sort en `<tool_call>` texte, pas en tool_calls."""
    events = []
    rounds = {"n": 0}

    def fake_stream(convo, **kwargs):
        rounds["n"] += 1
        if rounds["n"] == 1:
            yield {"message": {"role": "assistant", "content":
                               "<tool_call>\n<function=search_music>\n"
                               "<parameter=query>Dreamboy</parameter>\n</function>\n"
                               "</tool_call>"}}
        else:
            yield {"message": {"role": "assistant", "content": "Trouve sur YouTube !"}}

    chat.llm.chat_stream = fake_stream
    for ev in chat.chat_stream([{"role": "user", "content": "Cherche Dreamboy"}]):
        events.append(ev)

    ends = [e for e in events if e.get("type") == "tool_end"]
    check("stream texte : rechange detecte l'outil",
          len(ends) == 1 and ends[0]["name"] == "search_music" and ends[0]["ok"] is True,
          str(ends))
    done = [e for e in events if e["type"] == "done"][0]
    check("stream texte : aucune boucle infinie", rounds["n"] == 2, str(rounds["n"]))


def cas_chat_texte():
    """Fallback sur le chemin complet (non-stream) POST /api/chat."""
    rounds = {"n": 0}
    invoked = {}

    def fake_chat(convo, **kwargs):
        rounds["n"] += 1
        if rounds["n"] == 1:
            return {"message": {"role": "assistant", "content":
                                '<tool_call>{"name": "search_music", '
                                '"arguments": {"query": "Dreamboy"}}</tool_call>'}}
        return {"message": {"role": "assistant", "content": "C'est lance !"}}

    chat.llm.chat = fake_chat
    out = chat.chat([{"role": "user", "content": "Cherche Dreamboy"}])
    check("chat : rechange execute l'outil",
          len(out["tool_calls"]) == 1 and out["tool_calls"][0]["ok"] is True,
          str(out["tool_calls"]))
    check("chat : tags retires de la reponse",
          "<tool_call>" not in out["reply"] and rounds["n"] == 2, out["reply"])


def main():
    _ORIG["tool_functions"] = chat._tool_functions
    _ORIG["chat"] = chat.llm.chat
    _ORIG["chat_stream"] = chat.llm.chat_stream
    try:
        stub_functions()
        print("cas 1 : _run_tool (arguments string / dict / invalide)")
        cas_run_tool()
        print("cas 2 : parse <tool_call> texte")
        cas_parse_texte()
        print("cas 3 : chat_stream arguments string (bug LM Studio)")
        cas_stream_arguments_string()
        print("cas 4 : chat_stream rechange texte")
        cas_stream_texte()
        print("cas 5 : chat rechange texte")
        cas_chat_texte()
    finally:
        restaurer_functions()
        restaurer_llm()

    n_ok = sum(1 for c in CHECKS if c)
    n = len(CHECKS)
    print(f"\n{n_ok}/{n} verifications OK")
    sys.exit(0 if n_ok == n else 1)


if __name__ == "__main__":
    main()