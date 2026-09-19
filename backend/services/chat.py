"""Chat serveur : boucle Ollama + tools, historique fourni par le client (tronque)."""
import json

import ollama

from core.config import BASE, MODEL
from core.history import truncate_messages
from services.state import _tprint

# Consigne par defaut : garantit une reponse en francais meme si le client n'envoie
# pas de message system (le modele derive parfois vers une autre langue, ex. chinois).
DEFAULT_SYSTEM = (
    "Tu es NeuroBeats, un assistant musical. Reponds TOUJOURS en francais, "
    "jamais dans une autre langue, meme si les donnees sont techniques. "
    "Reponds en phrases courtes et claires. N'invente jamais de titre ni de video_id."
)


def _load_tools():
    with open(f"{BASE}/tools.json", encoding="utf-8") as f:
        return json.load(f)


def _tool_functions():
    """Table nom -> fonction des tools exposes au LLM."""
    from services.youtube import search_music, play_now
    from services.audio import play_music, play_choice, stop_music
    from services.playlists import create_playlist, load_playlist, playlist_next
    from services.streaming import start_streaming, stop_streaming, skip_streaming
    from services.recommendation import get_recommendation, store_preference
    from services.db_access import get_user_stats
    return {
        "search_music": search_music,
        "play_now": play_now,
        "play_music": play_music,
        "play_choice": play_choice,
        "stop_music": stop_music,
        "create_playlist": create_playlist,
        "load_playlist": load_playlist,
        "playlist_next": playlist_next,
        "start_streaming": start_streaming,
        "stop_streaming": stop_streaming,
        "skip_streaming": skip_streaming,
        "get_recommendation": get_recommendation,
        "get_user_stats": get_user_stats,
        "store_preference": store_preference,
    }


def chat(messages, max_messages=20):
    """Boucle conversationnelle stateless.

    - messages : liste de dicts {role, content} fournie par le client
    - max_messages : troncature (system conserve + N derniers)
    Retourne {reply, tool_calls, messages} ou messages = historique tronque mis a jour.
    """
    tools = _load_tools()
    functions = _tool_functions()
    convo = [dict(m) for m in truncate_messages(messages, max_messages)]
    if not any(m.get("role") == "system" for m in convo):
        convo.insert(0, {"role": "system", "content": DEFAULT_SYSTEM})

    response = ollama.chat(model=MODEL, messages=convo, tools=tools)
    msg = _msg_dict(response["message"])
    invoked = []

    while msg.get("tool_calls"):
        convo.append(msg)
        for call in msg["tool_calls"]:
            name = call["function"]["name"]
            args = call["function"].get("arguments", {})
            fn = functions.get(name)
            try:
                result = fn(**args) if fn else json.dumps({"error": f"Tool inconnu: {name}"})
            except Exception as exc:
                result = json.dumps({"error": f"Echec tool {name} : {exc}"}, ensure_ascii=False)
            invoked.append({"name": name, "arguments": args})
            convo.append({"role": "tool", "content": str(result)})
        response = ollama.chat(model=MODEL, messages=convo, tools=tools)
        msg = _msg_dict(response["message"])

    reply = msg.get("content", "")
    convo.append(msg)
    return {"reply": reply, "tool_calls": invoked,
            "messages": convo[-max_messages:] if max_messages else convo}


def _msg_dict(message):
    """Normalise un message Ollama (objet Message ou dict) en dict serialisable."""
    if isinstance(message, dict):
        d = dict(message)
    else:
        d = {"role": getattr(message, "role", "assistant"),
             "content": getattr(message, "content", "") or ""}
        tcs = getattr(message, "tool_calls", None)
        if tcs:
            d["tool_calls"] = [
                {"function": {"name": tc.function.name,
                              "arguments": dict(tc.function.arguments or {})}}
                for tc in tcs
            ]
    d.setdefault("role", "assistant")
    d.setdefault("content", "")
    return d
