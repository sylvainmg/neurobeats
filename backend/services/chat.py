"""Chat serveur : boucle LLM + tools, historique fourni par le client (tronque).

Deux entrees :
- `chat()` : reponse complete (bloquant) pour POST /api/chat ;
- `chat_stream()` : generateur d'evenements pour POST /api/chat/stream (SSE).

Toutes deux partagent la preparation du contexte (`_prepare_convo`), l'execution
d'un outil (`_run_tool`) et la troncature de sortie (`_tail`).

Le fournisseur, le modele et l'URL viennent de la config IA (`services.llm`) :
Ollama local par defaut, OU LM Studio / OpenAI-compatible / Anthropic.
"""
import json
import re

from core.config import CODE_ROOT
from core.history import MAX_MESSAGES_DEFAULT, truncate_messages
from services import llm
from services.state import _tprint

# Fenetre de contexte passee a Ollama. Sans `options`, la valeur par defaut du
# modele s'applique : pour un historique + des resultats d'outils, on la fixe
# explicitement afin de rester previsible.
_NUM_CTX = 4096

# Borne sur les tours d'outils : sans elle, un modele qui rappelle un outil en
# boucle (ex. recherche en ligne) ferait tourner la requete indefiniment.
MAX_TOOL_ROUNDS = 5

# Consigne par defaut : garantit une reponse en francais meme si le client n'envoie
# pas de message system (le modele derive parfois vers une autre langue, ex. chinois).
DEFAULT_SYSTEM = (
    "Tu es NeuroBeats, un assistant musical. Reponds TOUJOURS en francais, "
    "jamais dans une autre langue, meme si les donnees sont techniques. "
    "Reponds en phrases courtes et claires. N'invente jamais de titre ni de "
    "video_id. N'affirme une action comme faite QUE si tu as reellement appele "
    "l'outil correspondant dans ce tour : sinon dis clairement que tu ne l'as "
    "pas fait. "
    "Quand l'utilisateur demande de lire/jouer un titre (lance, joue, mets, ecoute, play...), "
    "utilise play_now(query) directement : il cherche ET joue le top resultat en un seul appel. "
    "Ne demande JAMAIS de confirmation sur quel titre prendre : prends le meilleur (souvent le premier). "
    "N'utilise pas search_music + play_choice ensemble pour lire : utilise play_now."
)

# Assistant dedie a la page Profil : il gere les GOUTS, il ne lance pas de musique.
PROFILE_SYSTEM = (
    "Tu es l'assistant des gouts de l'utilisateur sur NeuroBeats. Reponds TOUJOURS "
    "en francais, en phrases courtes et claires. Ton role : resumer ses gouts, "
    "l'aider a noter des titres, gerer ses artistes favoris et son historique "
    "d'ecoute. Tu ne lances JAMAIS de musique et tu ne modifies pas la file de "
    "lecture. N'invente jamais de titre ni de video_id, et ne demande JAMAIS de "
    "video_id a l'utilisateur (il ne le connait pas) : pour noter un titre, "
    "appelle directement store_preference avec `title` (titre et artiste) et "
    "`rating`. Avant toute suppression de donnees, demande confirmation, puis "
    "utilise l'outil approprie. N'affirme une action comme faite QUE si tu as "
    "reellement appele l'outil correspondant dans ce tour : sinon dis clairement "
    "que tu ne l'as pas fait."
)

# Portee « suggest » : redaction des points de depart de recherche (libelles IA).
SUGGEST_SYSTEM = (
    "Tu es directeur editorial musical. On te donne le profil d'ecoute d'un "
    "utilisateur (genres, artistes) et des extraits de recherche web. Tu proposes "
    "des points de depart de recherche pour la page Recherche : 4 a 6 libelles "
    "courts et varies (courants ou genres reels, ambiances, artistes proches), "
    "chacun avec la requete YouTube associee. Appuie-toi uniquement sur les "
    "informations fournies (profil et extraits) : n'invente aucun genre. "
    "La requete doit porter LE MEME theme que le libelle : c'est ce que "
    "l'utilisateur lira avant de cliquer. N'y ajoute jamais un artiste que le "
    "libelle ne nomme pas (pas de « Lomepal lofi » pour le libelle « Lo-fi ») : "
    "les artistes du profil servent a choisir les themes, pas a prefixer les "
    "requetes. Si le libelle est un genre ou une ambiance, la requete est ce "
    "genre ou cette ambiance. "
    'Reponds STRICTEMENT en JSON : {"suggestions": [{"label": "...", "query": "..."}]}'
)

# Portees du chat : jeu d'outils et consigne systeme associes.
_TOOL_FILES = {"global": "tools.json", "profile": "tools_profile.json",
               "suggest": "tools_suggest.json"}
_SYSTEMS = {"global": DEFAULT_SYSTEM, "profile": PROFILE_SYSTEM, "suggest": SUGGEST_SYSTEM}

# Libelles courts pour l'UI (puce d'activite pendant le streaming).
_TOOL_LABELS = {
    "search_music": "Recherche",
    "play_now": "Lecture",
    "play_music": "Lecture",
    "play_choice": "Lecture",
    "stop_music": "Arret",
    "create_playlist": "Creation de playlist",
    "load_playlist": "Chargement de playlist",
    "playlist_next": "Playlist",
    "list_playlists": "Bibliothèque",
    "rename_playlist": "Renommage",
    "delete_playlist": "Suppression",
    "add_track_to_playlist": "Ajout a une playlist",
    "remove_track_from_playlist": "Retrait d'une playlist",
    "start_streaming": "Flux infini",
    "stop_streaming": "Arret du flux",
    "skip_streaming": "Titre suivant",
    "get_recommendation": "Recommandation",
    "get_user_stats": "Statistiques",
    "store_preference": "Preference",
    # Portee « profil »
    "get_taste_summary": "Résumé des goûts",
    "list_rated": "Titres notés",
    "remove_rating": "Retrait d'une note",
    "list_favorites": "Artistes favoris",
    "add_favorite": "Ajout aux favoris",
    "remove_favorite": "Retrait des favoris",
    "delete_last_listen": "Suppression d'une écoute",
    "clear_history": "Effacement de l'historique",
    "update_profile_name": "Mise à jour du profil",
    "web_search": "Recherche en ligne",
}


def _load_tools(scope: str = "global"):
    """Jeu d'outils de la portee demandee (`tools.json` ou `tools_profile.json`)."""
    name = _TOOL_FILES.get(scope, "tools.json")
    with open(f"{CODE_ROOT}/{name}", encoding="utf-8") as f:
        return json.load(f)


def _tool_functions():
    """Table nom -> fonction des tools exposes au LLM (toutes portees confondues).

    Le scope choisit le *jeu declare* au modele (`tools.json` / `tools_profile.json`) ;
    cette table ne fait que resoudre les noms.
    """
    from services.youtube import search_music, play_now
    from services.audio import play_music, play_choice, stop_music
    from services.playlists import (
        add_track, create_playlist, delete_playlist, list_playlists, load_playlist,
        playlist_next, remove_track, rename_playlist,
    )
    from services.streaming import start_streaming, stop_streaming, skip_streaming
    from services.recommendation import get_recommendation, store_preference
    from services.db_access import get_user_stats
    from services.profile import (
        add_favorite, clear_history, delete_last_listen, delete_preference,
        get_taste_summary, list_favorites, list_preferences, remove_favorite,
        update_identity,
    )
    from services.websearch import web_search
    return {
        "search_music": search_music,
        "play_now": play_now,
        "play_music": play_music,
        "play_choice": play_choice,
        "stop_music": stop_music,
        "create_playlist": create_playlist,
        "load_playlist": load_playlist,
        "playlist_next": playlist_next,
        "list_playlists": list_playlists,
        "rename_playlist": rename_playlist,
        "delete_playlist": delete_playlist,
        "add_track_to_playlist": add_track,
        "remove_track_from_playlist": remove_track,
        "start_streaming": start_streaming,
        "stop_streaming": stop_streaming,
        "skip_streaming": skip_streaming,
        "get_recommendation": get_recommendation,
        "get_user_stats": get_user_stats,
        "store_preference": store_preference,
        # Portee « profil » (gestion des gouts)
        "get_taste_summary": get_taste_summary,
        "list_rated": list_preferences,
        "remove_rating": delete_preference,
        "list_favorites": list_favorites,
        "add_favorite": add_favorite,
        "remove_favorite": remove_favorite,
        "delete_last_listen": delete_last_listen,
        "clear_history": clear_history,
        "update_profile_name": update_identity,
        # Recherche en ligne (anti-hallucination), toutes portees
        "web_search": web_search,
    }


def _prepare_convo(messages, max_messages, scope: str = "global"):
    """Tronque l'historique client et garantit la consigne systeme de la portee."""
    convo = [dict(m) for m in truncate_messages(messages, max_messages)]
    if not any(m.get("role") == "system" for m in convo):
        convo.insert(0, {"role": "system", "content": _SYSTEMS.get(scope, DEFAULT_SYSTEM)})
    return convo


def _coerce_args(args):
    """Normalise des arguments d'outil en dict (JSON string -> dict, sinon {})."""
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except (TypeError, json.JSONDecodeError):
            args = {}
    return args if isinstance(args, dict) else {}


def _run_tool(functions, name, args):
    """Execute un tool ; retourne (ok, resultat_serialise). Ne leve jamais.

    Les providers OpenAI-compatibles (LM Studio / BYOK) exposent `arguments` en
    JSON string ; Ollama le fournit deja en dict. On normalise avant l'appel,
    sinon `fn(**str)` leve TypeError et le tool echoue en rouge a tort.
    """
    fn = functions.get(name)
    args = _coerce_args(args)
    try:
        result = fn(**args) if fn else json.dumps({"error": f"Tool inconnu: {name}"})
    except Exception as exc:
        return False, json.dumps({"error": f"Echec tool {name} : {exc}"}, ensure_ascii=False)
    if fn is None:
        return False, result
    return True, result


# ----------------------------------------------------------------- appel d'outil en texte
# Certains modeles (gemma-2, qwen3…) n'ont pas de support natif d'outil : LM
# Studio, ou le modele lui-meme, renvoient alors l'appel en `content` plutôt que
# dans `tool_calls` structure. Le format est celui du template Qwen2.5
# (`<tool_call><function=..><parameter=k>v</parameter></tool_call>`) ou un JSON
# emboite. On le rechange pour ne pas laisser ces appels tomber en reponse texte.
_TEXT_TOOL_BLOCK_RE = re.compile(r"<tool_call>(.*?)</tool_call>", re.S)


def _parse_text_tool_call(text: str) -> dict | None:
    """Parse un bloc `<tool_call>…</tool_call>` en appel d'outil interne.

    Args:
        text: Contenu du message assistant.

    Returns:
        `{"function": {"name", "arguments"}}` si un bloc bien forme est trouve,
        sinon None. Le nom n'est PAS verifie ici : la rechange le croise avec la
        table des outils avant de dispatcher (anti-faux-positif d'une prose qui
        evoque les outils).
    """
    match = _TEXT_TOOL_BLOCK_RE.search(text or "")
    if not match:
        return None
    block = match.group(1).strip()
    # Forme JSON emboitee : {"name": .., "arguments": {..}}.
    try:
        data = json.loads(block)
    except (TypeError, json.JSONDecodeError):
        data = None
    if isinstance(data, dict) and isinstance(data.get("name"), str) and data.get("name"):
        args = data.get("arguments") or {}
        if not isinstance(args, dict):
            args = {}
        return {"function": {"name": data["name"], "arguments": args}}
    # Forme tags Qwen2.5 : <function=nom> + <parameter=cle>valeur</parameter>.
    fm = (re.search(r"<function=([^>\n]+)>", block)
          or re.search(r"<function>([^<]+)</function>", block))
    if not fm:
        return None
    name = fm.group(1).strip()
    if not name:
        return None
    params = {}
    for pm in re.finditer(r"<parameter=([^>\n]+)>([^<]*)</parameter>", block):
        params[pm.group(1).strip()] = pm.group(2).strip()
    return {"function": {"name": name, "arguments": params}}


def _strip_text_tool(text: str) -> str:
    """Retire les blocs `<tool_call>` d'un message (afin de garder la prose)."""
    return _TEXT_TOOL_BLOCK_RE.sub("", text or "").strip()


def _label(name):
    return {"label": _TOOL_LABELS.get(name, name)}


def _summarize(name, result):
    """Resume court et optionnel d'un resultat d'outil, pour l'UI."""
    try:
        data = json.loads(result)
    except (TypeError, json.JSONDecodeError):
        return ""
    if not isinstance(data, dict):
        return ""
    if data.get("error"):
        return str(data["error"])[:120]
    for key in ("results", "recommendations", "tracks"):
        items = data.get(key)
        if isinstance(items, list):
            return f"{len(items)} resultat(s)"
    if data.get("title"):
        return str(data["title"])[:120]
    return ""


def _tail(convo, max_messages):
    """Historique renvoye au client : borne (system conserve, coupe sur un tour)."""
    if not max_messages:
        return convo
    return truncate_messages(convo, max_messages)


def _merge_tool_calls(acc: dict, incoming):
    """Accumule les `tool_calls` d'un stream dans `acc` (index -> {name, arguments}).

    Les arguments peuvent arriver completes en un chunk (cas courant) ou etre
    fragmentes selon la version d'ollama : on fusionne par index.
    """
    for tc in incoming or []:
        if isinstance(tc, dict):
            fn = tc.get("function") or {}
            name = fn.get("name", "") or ""
            args = fn.get("arguments") or {}
            idx = tc.get("index")
        else:
            fn = getattr(tc, "function", None)
            name = (getattr(fn, "name", "") if fn else "") or ""
            args = dict(getattr(fn, "arguments", None) or {}) if fn else {}
            idx = getattr(tc, "index", None)
        if idx is None:
            idx = len(acc)
        slot = acc.setdefault(idx, {"name": "", "arguments": {}})
        if name:
            slot["name"] = name
        if isinstance(args, dict):
            slot["arguments"].update(args)
        elif args:
            slot["arguments"] = args


def chat(messages, max_messages=MAX_MESSAGES_DEFAULT, scope: str = "global"):
    """Boucle conversationnelle stateless (reponse complete).

    - messages : liste de dicts {role, content} fournie par le client
    - max_messages : troncature (system conserve + N derniers)
    - scope : "global" (assistant musical) ou "profile" (assistant des gouts)
    Retourne {reply, tool_calls, messages} ou messages = historique tronque mis a jour.
    """
    tools = _load_tools(scope)
    functions = _tool_functions()
    convo = _prepare_convo(messages, max_messages, scope)

    response = llm.chat(convo, tools=tools, num_ctx=_NUM_CTX)
    msg = _msg_dict(response["message"])
    invoked = []
    rounds = 0

    while True:
        calls = msg.get("tool_calls") or []
        # Rechange : LM Studio renvoie parfois l'appel d'outil en texte
        # (`<tool_call>` dans content) quand il echoue a le structurer.
        if not calls and rounds < MAX_TOOL_ROUNDS:
            text_tool = _parse_text_tool_call(msg.get("content", ""))
            if text_tool and text_tool["function"]["name"] in functions:
                msg = {**msg, "content": _strip_text_tool(msg.get("content", "")),
                       "tool_calls": [text_tool]}
                calls = [text_tool]
        if not calls:
            break
        if rounds >= MAX_TOOL_ROUNDS:
            # Trop d'allers-retours d'outils : on demande une reponse finale sans
            # outils plutot que de boucler.
            _tprint(f"[chat] {MAX_TOOL_ROUNDS} tours d'outils atteints, reponse finale")
            final = llm.chat(convo, num_ctx=_NUM_CTX)
            msg = _msg_dict(final["message"])
            break
        rounds += 1
        convo.append(msg)
        for call in calls:
            name = call["function"]["name"]
            args = _coerce_args(call["function"].get("arguments", {}) or {})
            ok, result = _run_tool(functions, name, args)
            invoked.append({"name": name, "arguments": args, "ok": ok})
            convo.append({"role": "tool", "content": str(result)})
        response = llm.chat(convo, tools=tools, num_ctx=_NUM_CTX)
        msg = _msg_dict(response["message"])

    reply = msg.get("content", "")
    convo.append(msg)
    return {"reply": reply, "tool_calls": invoked, "messages": _tail(convo, max_messages)}


def chat_stream(messages, max_messages=MAX_MESSAGES_DEFAULT, scope: str = "global"):
    """Generateur d'evenements de la boucle conversationnelle (pour SSE).

    Evenements : token | tool_start | tool_end | done. Les exceptions sont
    laissees remonter au routeur, qui emet un evenement `error`.
    """
    tools = _load_tools(scope)
    functions = _tool_functions()
    convo = _prepare_convo(messages, max_messages, scope)
    invoked = []
    rounds = 0

    while True:
        acc: dict = {}
        parts: list = []
        # Trop d'allers-retours d'outils : on repasse sans outils pour obtenir une
        # reponse finale au lieu de boucler.
        exhausted = rounds >= MAX_TOOL_ROUNDS
        if exhausted:
            _tprint(f"[chat] {MAX_TOOL_ROUNDS} tours d'outils atteints, reponse finale")
        stream = llm.chat_stream(convo, tools=None if exhausted else tools, num_ctx=_NUM_CTX)
        try:
            for chunk in stream:
                msg = chunk.get("message") if isinstance(chunk, dict) else getattr(chunk, "message", None)
                if msg is None:
                    continue
                piece = (msg.get("content") if isinstance(msg, dict) else getattr(msg, "content", "")) or ""
                if piece:
                    parts.append(piece)
                    yield {"type": "token", "content": piece}
                tcs = (msg.get("tool_calls") if isinstance(msg, dict)
                       else getattr(msg, "tool_calls", None))
                _merge_tool_calls(acc, tcs)
        finally:
            close = getattr(stream, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass

        calls = [{"function": {"name": v["name"], "arguments": v["arguments"]}}
                 for _, v in sorted(acc.items()) if v["name"]]
        assistant = {"role": "assistant", "content": "".join(parts)}
        if not calls and not exhausted:
            # Rechange : meme appel d'outil, mais sous forme de texte.
            text_tool = _parse_text_tool_call(assistant["content"])
            if text_tool and text_tool["function"]["name"] in functions:
                assistant["content"] = _strip_text_tool(assistant["content"])
                calls = [text_tool]
        if not calls or exhausted:
            convo.append(assistant)
            break
        rounds += 1
        assistant["tool_calls"] = calls
        convo.append(assistant)
        for call in calls:
            name = call["function"]["name"]
            args = _coerce_args(call["function"].get("arguments", {}) or {})
            yield {"type": "tool_start", "name": name, "arguments": args, **_label(name)}
            ok, result = _run_tool(functions, name, args)
            invoked.append({"name": name, "ok": ok})
            yield {"type": "tool_end", "name": name, "ok": ok,
                   "summary": _summarize(name, result), **_label(name)}
            convo.append({"role": "tool", "content": str(result)})

    yield {"type": "done", "messages": _tail(convo, max_messages), "tool_calls": invoked}


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
