"""Abstraction LLM multi-fournisseurs : Ollama, LM Studio, OpenAI-compatible, Anthropic.

La config vit dans le profil (cle `ai` de la table `kv`, comme l'identite) :
l'utilisateur la regle depuis l'onglet « IA » de la page Profil. Par defaut, le
comportement historique est conserve : Ollama natif sur `localhost:11434`.

Les fournisseurs parlent des protocoles differents. On normalise tout en interne
au format Ollama (`{"message": {"content", "tool_calls": [...]}}`, tool_calls
`{"function": {"name", "arguments"}}`) pour que les services consommateurs
(chat, editorial, genres, suggestions) restent inchanges.

Interdits dans ce module : tout `import ollama` au niveau module (les clients
sont crees a la demande, apres lecture de la config). Les erreurs remontent au
appelant : chacun a deja son repli (fallback genre « autre », habillage neutre,
chat -> erreur SSE).
"""
import json
import time

from services.db_access import profile_read, profile_write
from services.state import _tprint

# ------------------------------------------------------------------- valeurs par defaut
DEFAULTS = {
    "provider": "ollama",
    "ollama": {"host": "http://localhost:11434", "model": "qwen2.5:7b"},
    "lmstudio": {"base_url": "http://localhost:1234/v1", "model": "Llama-3.2-3B-Instruct"},
    "openai": {"base_url": "https://api.openai.com/v1", "model": "gpt-4o-mini", "api_key": "sk-"},
    "anthropic": {"base_url": "https://api.anthropic.com",
                  "model": "claude-3-5-haiku-latest", "api_key": ""},
}
# Taille de sortie bornee : suffisante pour une reponse + un tour d'outils.
DEFAULT_MAX_TOKENS = 2048
# Libelle utilitaire pour le test de connexion.
PROVIDER_LABELS = {
    "ollama": "Ollama",
    "lmstudio": "LM Studio",
    "openai": "BYOK (OpenAI-compatible)",
    "anthropic": "Anthropic Claude",
}

# ----------------------------------------------------- acces config (profil SQLite)
_DEFAULTS_COPY = json.loads(json.dumps(DEFAULTS))


def _stored():
    """Config brute persistee (avec secrets) ; valeurs par defaut si jamais reglee."""
    raw = profile_read().get("ai")
    if not isinstance(raw, dict) or not raw.get("provider"):
        return json.loads(json.dumps(DEFAULTS))
    out = json.loads(json.dumps(DEFAULTS))
    for key, value in raw.items():
        if key == "provider" and value in DEFAULTS:
            out["provider"] = value
        elif isinstance(value, dict):
            out.setdefault(key, {}).update({k: v for k, v in value.items() if v is not None})
    return out


def get_ai_config(tool: bool = True) -> str:
    """Config du modele IA, secrets masques, en JSON (contrat `run_tool`).

    `api_key` n'y figure jamais en clair : le front n'affiche que le masque.
    """
    cfg = _stored()
    provider = cfg["provider"]
    out = {"provider": provider, **{k: dict(v) for k, v in cfg.items() if isinstance(v, dict)}}
    for name in cfg:
        block = out.get(name)
        if isinstance(block, dict) and "api_key" in block:
            block.pop("api_key", None)
            if _has_api_key(cfg, name):
                block["api_key_masked"] = mask_api_key(cfg[name]["api_key"])
    out["configured"] = is_configured(cfg)
    out["label"] = PROVIDER_LABELS.get(provider, provider)
    return json.dumps(out, ensure_ascii=False)


def mask_api_key(key: str) -> str:
    """Masque une cle : garde le prefixe court + les 4 derniers caracteres.

    Ex. `sk-proj-…AbC1` -> `sk-…AbC1`. Ne divulgue jamais le secret complet.
    """
    key = (key or "").strip()
    if len(key) <= 6:
        return "•••"
    head = key[:4] if key.startswith("sk") else key[:2]
    return f"{head}•••{key[-4:]}"


def _apply_overrides(cfg: dict, provider: str = None, blocks: dict = None) -> dict:
    """Applique un patch de config (regles identiques a `save_ai_config`).

    Sert aussi au test de connexion : on maquille une config candidate avec les
    valeurs du formulaire (jamais persistees) le temps d'une reponse.
    """
    if provider in DEFAULTS:
        cfg["provider"] = provider
    for name, values in (blocks or {}).items():
        if name not in DEFAULTS or not isinstance(values, dict):
            continue
        current = cfg.setdefault(name, {})
        for field, value in values.items():
            # Liste blanche : on ne retient que les champs reels d'un fournisseur
            # (jamais `api_key_masked`, ni de surprise cote front).
            if field not in ("host", "base_url", "model", "api_key"):
                continue
            if field == "api_key":
                if value == "":
                    current["api_key"] = ""
                elif value is not None:
                    current["api_key"] = str(value).strip()
                # None -> conserver l'existante
            else:
                current[field] = (value or "").strip()
    return cfg


def save_ai_config(provider: str = None, **blocks) -> str:
    """Enregistre la config IA dans le profil.

    Args:
        provider: Fournisseur actif (`DEFAULTS` si absent).
        blocks: Par fournisseur, les champs a ecraser (host, model, api_key…).
            `api_key=None` conserve la cle existante ; `api_key=""` l'efface.

    Returns:
        JSON de la config masquee (contract `run_tool`).
    """
    cfg = _stored()
    _apply_overrides(cfg, provider, blocks)
    profile = profile_read()
    profile["ai"] = cfg
    profile_write(profile)
    _tprint(f"[llm] config IA enregistree : provider={cfg['provider']}")
    return get_ai_config()


def _has_api_key(cfg: dict, name: str) -> bool:
    return bool((cfg.get(name) or {}).get("api_key") or "")


def is_configured(cfg: dict | None = None) -> bool:
    """True si le fournisseur actif a de quoi repondre.

    Ollama/LM Studio : une URL de base suffit (modeles locaux sans cle).
    OpenAI/Anthropic : une cle API est requise.
    """
    cfg = cfg or _stored()
    provider = cfg["provider"]
    block = cfg.get(provider) or {}
    if provider == "anthropic":
        return bool(block.get("api_key")) and bool(block.get("base_url"))
    if provider == "openai":
        return bool(block.get("api_key")) and bool(block.get("base_url"))
    if provider == "lmstudio":
        return bool(block.get("base_url"))
    # ollama : host par defaut localhost — toujours valide.
    return bool(block.get("host"))


def ai_status() -> dict:
    """Etat resume pour /api/health : provider actif + config complet ou non."""
    cfg = _stored()
    return {"provider": cfg["provider"], "configured": is_configured(cfg)}


# -------------------------------------------------------------- fabrique de clients
def _default_client(provider: str, timeout: float, cfg: dict = None):
    """Instancie le client SDK du fournisseur (jamais au chargement du module)."""
    block = (cfg if cfg is not None else _stored())[provider]
    if provider == "ollama":
        import ollama  # import local : Ollama reste le repli, jamais obligatoire ici
        return ollama.Client(host=block.get("host") or DEFAULTS["ollama"]["host"],
                             timeout=timeout)
    if provider == "lmstudio" or provider == "openai":
        from openai import OpenAI
        return OpenAI(base_url=block.get("base_url") or DEFAULTS[provider]["base_url"],
                      api_key=block.get("api_key") or "sk-placeholder",
                      timeout=timeout)
    if provider == "anthropic":
        from anthropic import Anthropic
        return Anthropic(api_key=block.get("api_key") or "",
                         base_url=block.get("base_url") or DEFAULTS["anthropic"]["base_url"],
                         timeout=timeout)
    raise ValueError(f"Fournisseur IA inconnu : {provider!r}")


def _model(provider: str, cfg: dict = None) -> str:
    block = (cfg if cfg is not None else _stored())[provider]
    return (block.get("model") or "").strip() or DEFAULTS[provider]["model"]


# ----------------------------------------------- conversion de messages/outils
def _tool_calls_anonymes(calls: list) -> list:
    """Transforme des tool_calls internes en liste OpenAI-compatible (ids generes).

    Interne : `{"function": {"name", "arguments": dict|str}}`.
    OpenAI : `{"id", "type": "function", "function": {"name", "arguments": str}}`.
    """
    out = []
    for i, call in enumerate(calls or []):
        fn = call.get("function") or {}
        args = fn.get("arguments") or {}
        if not isinstance(args, str):
            args = json.dumps(args, ensure_ascii=False)
        out.append({"id": f"call_{i}",
                    "type": "function",
                    "function": {"name": fn.get("name", ""), "arguments": args}})
    return out


def _convo_openai(messages: list) -> list:
    """Convo interne -> format OpenAI Chat Completions (outils inclus).

    Convertit une passe unique : pour chaque message `tool`, on attribue l'id du
    outil assistant qui le precede (`call_<idx>`), premier id des tool_calls vus.
    """
    result: list = []
    last_assistant_call_ids: list = []
    for idx, msg in enumerate(messages or []):
        calls = _tool_calls_anonymes(msg.get("tool_calls")) if msg.get("tool_calls") else None
        if calls:
            last_assistant_call_ids = [c["id"] for c in calls]
        if msg.get("role") == "tool":
            tid = last_assistant_call_ids[0] if last_assistant_call_ids else f"call_{idx}"
            result.append({"role": "tool", "tool_call_id": tid,
                           "content": str(msg.get("content", ""))})
        elif calls is not None:
            result.append({"role": msg.get("role", "assistant"),
                           "content": msg.get("content", "") or "", "tool_calls": calls})
        else:
            result.append({"role": msg.get("role", "user"),
                           "content": msg.get("content", "") or ""})
    return result


def _tools_openai(tools: list | None) -> list | None:
    """Tools internes (format Ollama/OpenAI deja) -> liste OpenAI (identique)."""
    if not tools:
        return None
    return list(tools)


def _merge_consecutive_user(conv: list) -> list:
    """Fusionne les messages `user` adjacents (forbid abus d'alternance Anthropic).

    Un `tool_result` et la suite du message utilisateur forment deux messages
    `user` consecutifs ; l'API les refuse. On les regroupe en un seul message
    dont le contenu est la concatenation des blocs.
    """
    out: list = []
    for msg in conv:
        if out and msg.get("role") == "user" and out[-1].get("role") == "user":
            prev = out[-1]
            prev_blocks = prev.get("content")
            if isinstance(prev_blocks, list) and isinstance(msg.get("content"), list):
                out[-1] = {"role": "user", "content": prev_blocks + msg["content"]}
                continue
        out.append(msg)
    return out


def _convo_anthropic(messages: list) -> tuple[str, list]:
    """Convo interne -> (system, messages Anthropic).

    Anthropic separe le role system et impose l'alternance user/assistant. Les
    tool_calls deviennent des blocs `tool_use`, les resultats des blocs
    `tool_result` portes par un message `user`.
    """
    system_parts = [m.get("content", "") for m in messages or [] if m.get("role") == "system"]
    system = "\n".join(str(p) for p in system_parts if p)
    out: list = []
    pending_id = None
    pending_calls: list = []
    for msg in messages or []:
        role = msg.get("role", "user")
        if role == "system":
            continue
        content = msg.get("content", "") or ""
        calls = msg.get("tool_calls")
        if role == "tool":
            # Resultat d'un tool : bloc tool_result rattache a l'id du tool_use connu.
            out.append({"role": "user",
                        "content": [{"type": "tool_result", "tool_use_id": pending_id or "tool_1",
                                     "content": str(content)}]})
            if pending_calls:
                pending_calls.pop(0)
            continue
        if calls:
            blocks = []
            for idx, call in enumerate(calls):
                fn = call.get("function") or {}
                args = fn.get("arguments") or {}
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except json.JSONDecodeError:
                        args = {}
                cid = f"tool_{len(out)}_{idx}"
                blocks.append({"type": "tool_use", "id": cid, "name": fn.get("name", ""),
                               "input": args})
                pending_id = cid
            # Associe chaque tool_result a son tool_use : on memorise les n-1 restants.
            out.append({"role": "assistant", "content": blocks + [{"type": "text", "text": str(content)}]})
        else:
            out.append({"role": role, "content": [{"type": "text", "text": str(content)}]})
    return system, _merge_consecutive_user(out)


def _tools_anthropic(tools: list | None) -> list | None:
    """Tools internes -> format Anthropic (`input_schema` remplace `parameters`)."""
    if not tools:
        return None
    converted = []
    for tool in tools:
        if isinstance(tool, dict) and tool.get("type") == "function":
            fn = tool.get("function") or {}
            converted.append({"name": fn.get("name", ""),
                              "description": fn.get("description", "") or "",
                              "input_schema": fn.get("parameters") or {"type": "object", "properties": {}}})
        elif isinstance(tool, dict) and tool.get("name"):
            converted.append(tool)
    return converted


def _tool_calls_internes(inputs: list, provider: str) -> list:
    """Tool_calls d'un provider -> format interne `{"function": {"name", "arguments"}}`.

    Ollama/OpenAI exposent `function.arguments` (str ou dict) ; Anthropic expose un
    bloc par tool_use avec `input` deja complet.
    """
    calls = []
    for item in inputs or []:
        fn = (item.get("function") or {}) if isinstance(item, dict) else getattr(item, "function", None)
        if provider == "anthropic":
            name = item.get("name") if isinstance(item, dict) else getattr(item, "name", "")
            args = item.get("input") if isinstance(item, dict) else getattr(item, "input", None)
            if not isinstance(args, dict):
                try:
                    args = json.loads(args) if isinstance(args, str) else {}
                except json.JSONDecodeError:
                    args = {}
            calls.append({"function": {"name": name or "", "arguments": args}})
        else:
            name = fn.get("name", "") if fn else ""
            args = fn.get("arguments", {}) if fn else {}
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except json.JSONDecodeError:
                    args = {}
            calls.append({"function": {"name": name, "arguments": args or {}}})
    return calls


# ------------------------------------------------------- appels unifies (non-stream)
def chat(messages: list, tools: list | None = None, *, model: str = None,
         temperature: float = None, num_ctx: int = None, json_mode: bool = False,
         timeout: float = 120.0, config: dict = None) -> dict:
    """Reponse complete du modele (format Ollama : `{"message": {...}}`).

    Usage <=> ancien `_OLLAMA.chat(model, messages, tools, options)`. La sortie
    est normalisee en `{"message": {"role", "content", "tool_calls"}}` quel que
    soit le fournisseur (les consumers n'ont pas a changer).

    Args:
        config: Config candidate (test de connexion) ; `None` = config persistee.
    """
    cfg = config if config is not None else _stored()
    provider = cfg["provider"]
    selected = model or _model(provider, cfg)
    if provider == "ollama":
        client = _default_client(provider, timeout, cfg)
        options = {}
        if temperature is not None:
            options["temperature"] = temperature
        if num_ctx:
            options["num_ctx"] = num_ctx
        response = client.chat(model=selected, messages=messages, tools=tools or None,
                               options=options or None, format="json" if json_mode else None)
        return {"message": dict(response.get("message") or {})}

    if provider in ("lmstudio", "openai"):
        client = _default_client(provider, timeout, cfg)
        kwargs = {
            "model": selected,
            "messages": _convo_openai(messages),
            "temperature": temperature if temperature is not None else 0.3,
        }
        if tools:
            kwargs["tools"] = _tools_openai(tools)
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}
        response = client.chat.completions.create(**kwargs)
        choice = response.choices[0]
        msg = choice.message or {}
        content = getattr(msg, "content", None) or ""
        calls = getattr(msg, "tool_calls", None)
        return {"message": {"role": "assistant", "content": content,
                            "tool_calls": _tool_calls_internes(calls, "openai") if calls else [],
                            "finish_reason": getattr(choice, "finish_reason", "")}}

    if provider == "anthropic":
        client = _default_client(provider, timeout, cfg)
        system, conv = _convo_anthropic(messages)
        kwargs = {
            "model": selected,
            "max_tokens": DEFAULT_MAX_TOKENS,
            "temperature": temperature if temperature is not None else 0.3,
        }
        if system:
            kwargs["system"] = system
        if tools:
            kwargs["tools"] = _tools_anthropic(tools)
        if not conv:
            conv = [{"role": "user", "content": [{"type": "text", "text": ""}]}]
        response = client.messages.create(messages=conv, **kwargs)
        blocks = response.content or []
        text = "".join(getattr(b, "text", "") or "" for b in blocks
                       if getattr(b, "type", None) in ("text", "text_delta"))
        calls = [getattr(b, "model_dump", lambda: {})() or {} for b in blocks
                 if getattr(b, "type", None) == "tool_use"]
        return {"message": {"role": "assistant", "content": text,
                            "tool_calls": _tool_calls_internes([dict(b) for b in calls], "anthropic")
                            if calls else [],
                            "finish_reason": getattr(response, "stop_reason", "")}}
    raise ValueError(f"Fournisseur IA inconnu : {provider!r}")


def chat_stream(messages: list, tools: list | None = None, *, model: str = None,
                temperature: float = None, num_ctx: int = None, json_mode: bool = False,
                timeout: float = 120.0, config: dict = None):
    """Generateur de chunks `{"message": {...}}` (streaming, format Ollama).

    Boucle de chat existante : consomme `chunk["message"]["content"]` pour les
    tokens et accumule `tool_calls` par `_merge_tool_calls`. On preserve ce
    contrat : les streams OpenAI/Anthropic sont decoupes en morceaux `content`,
    puis un chunk final porte les `tool_calls` complets (un seul acquisition).

    Args:
        config: Config candidate (test de connexion) ; `None` = config persistee.
    """
    cfg = config if config is not None else _stored()
    provider = cfg["provider"]
    selected = model or _model(provider, cfg)

    if provider == "ollama":
        client = _default_client(provider, timeout, cfg)
        options = {}
        if temperature is not None:
            options["temperature"] = temperature
        if num_ctx:
            options["num_ctx"] = num_ctx
        stream = client.chat(model=selected, messages=messages, tools=tools or None,
                             options=options or None, format="json" if json_mode else None,
                             stream=True)
        for chunk in stream:
            if not isinstance(chunk, dict):
                chunk = chunk.model_dump()
            yield {"message": dict(chunk.get("message") or {})}
        return

    if provider in ("lmstudio", "openai"):
        client = _default_client(provider, timeout, cfg)
        kwargs = {
            "model": selected,
            "messages": _convo_openai(messages),
            "temperature": temperature if temperature is not None else 0.3,
            "stream": True,
        }
        if tools:
            kwargs["tools"] = _tools_openai(tools)
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}
        stream = client.chat.completions.create(**kwargs)
        acc: dict = {}
        for chunk in stream:
            for choice in (chunk.choices or []):
                delta = choice.delta or {}
                piece = getattr(delta, "content", None) or ""
                if piece:
                    yield {"message": {"role": "assistant", "content": piece, "tool_calls": []}}
                for tc in getattr(delta, "tool_calls", None) or []:
                    idx = tc.index if tc.index is not None else len(acc)
                    slot = acc.setdefault(idx, {"name": "", "arguments": ""})
                    fn = tc.function or {}
                    if fn.name:
                        slot["name"] = fn.name
                    if fn.arguments:
                        slot["arguments"] += fn.arguments
        if acc:
            calls = [{"function": {"name": v["name"], "arguments": v["arguments"]}}
                     for _, v in sorted(acc.items()) if v["name"]]
            yield {"message": {"role": "assistant", "content": "", "tool_calls": calls}}
        return

    if provider == "anthropic":
        client = _default_client(provider, timeout, cfg)
        system, conv = _convo_anthropic(messages)
        kwargs = {
            "model": selected,
            "max_tokens": DEFAULT_MAX_TOKENS,
            "temperature": temperature if temperature is not None else 0.3,
            "stream": True,
        }
        if system:
            kwargs["system"] = system
        if tools:
            kwargs["tools"] = _tools_anthropic(tools)
        if not conv:
            conv = [{"role": "user", "content": [{"type": "text", "text": ""}]}]
        stream = client.messages.create(messages=conv, **kwargs)
        blocks: dict = {}  # index -> {"type", "name", "arguments"}
        for event in stream:
            etype = getattr(event, "type", "")
            if etype in ("content_block_start", "content_block_delta", "content_block_stop"):
                # Resistele n'expose pas toujours les champs : on passe par model_dump.
                try:
                    data = event.model_dump()
                except Exception:
                    data = {}
                if etype == "content_block_start":
                    idx = data.get("index", len(blocks))
                    block = (data.get("content_block") or {})
                    blocks.setdefault(idx, {"type": block.get("type", "text"),
                                            "name": block.get("name", ""), "arguments": ""})
                elif etype == "content_block_delta":
                    idx = data.get("index", 0)
                    delta = (data.get("delta") or {})
                    d_type = delta.get("type", "")
                    slot = blocks.setdefault(idx, {"type": "text", "name": "", "arguments": ""})
                    if d_type == "text_delta" and delta.get("text"):
                        yield {"message": {"role": "assistant",
                                           "content": delta.get("text", ""), "tool_calls": []}}
                    elif d_type == "input_json_delta" and delta.get("partial_json"):
                        slot["type"] = "tool_use"
                        slot["arguments"] += delta.get("partial_json", "")
                # content_block_stop : rien d'autre a faire (arguments sans texte)
                continue
            if etype == "message_stop":
                break
        calls = []
        for _, slot in sorted(blocks.items()):
            if slot.get("type") != "tool_use" or not slot.get("name"):
                continue
            raw = slot.get("arguments", "")
            try:
                args = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                args = {}
            calls.append({"function": {"name": slot["name"], "arguments": args}})
        if calls:
            yield {"message": {"role": "assistant", "content": "", "tool_calls": calls}}
        return
    raise ValueError(f"Fournisseur IA inconnu : {provider!r}")


def test_connection(timeout: float = 15.0, provider: str = None, **blocks) -> str:
    """Verifie que le fournisseur repond (prompt minimal), en JSON (cont. run_tool).

    Si `provider` ou des blocs sont fournis, ils maquillent une config candidate
    (le test épouse les valeurs volantes du formulaire sans rien persister) ;
    sinon on teste la config enregistree.

    Returns:
        {"ok": true, "latency_ms", "model", "provider"} sinon
        {"ok": false, "error"} — ne leve jamais.
    """
    if provider is not None or blocks:
        # Copie profonde : on ne touche jamais a la config persistee ni a DEFAULTS.
        cfg = json.loads(json.dumps(_stored()))
        _apply_overrides(cfg, provider, blocks)
    else:
        cfg = _stored()
    provider = cfg["provider"]
    if not is_configured(cfg):
        return json.dumps({"ok": False,
                           "error": "Configuration incomplete (cle API ou URL manquante)."},
                          ensure_ascii=False)
    start = time.monotonic()
    try:
        chat([{"role": "user", "content": "Reponds uniquement OK."}],
             temperature=0, timeout=timeout, config=cfg)
        latency = int((time.monotonic() - start) * 1000)
        return json.dumps({"ok": True, "latency_ms": latency, "provider": provider,
                           "model": _model(provider, cfg)}, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({"ok": False, "provider": provider,
                           "error": f"{type(exc).__name__}: {exc}"[:180]}, ensure_ascii=False)