"""Gestion de l'historique conversationnel.

L'historique est detenu par le CLIENT : il l'envoie a chaque appel /api/chat ou
/api/chat/stream. Le serveur le tronque pour borner le contexte envoye au modele
local (nombre de messages ET volume de caracteres).
"""

MAX_MESSAGES_DEFAULT = 20
# Garde-fou : aucun message (question comme reponse) ne depasse cette taille.
# Couche de securite, independante de la troncature du contexte.
MAX_CHARS_PER_MESSAGE = 2000
# Borne secondaire : le nombre de messages ne suffit pas, un resultat d'outil ou
# une recherche peuvent etre longs. On retire les tours les plus anciens tant que
# le total depasse ce budget de caracteres.
MAX_CHARS_DEFAULT = 12_000


def truncate_messages(messages, max_messages=MAX_MESSAGES_DEFAULT,
                      max_chars=MAX_CHARS_DEFAULT):
    """Garde le(s) message(s) system en tete + les derniers tours utiles.

    - messages : liste de dicts {role, content, ...}
    - max_messages : borne sur les messages NON-system (defaut 20)
    - max_chars : borne sur la somme des contenus (defaut 12000)

    Chaque message est d'abord plafonne a `MAX_CHARS_PER_MESSAGE` caracteres
    (garde-fou anti-abus), puis la fenetre est coupee sur une frontiere de tour
    (on demarre sur un message `user`) : sinon l'historique commencerait par un
    message `tool` orphelin ou un `assistant` avec `tool_calls` sans resultats,
    ce qu'Ollama refuse.
    """
    if not isinstance(messages, list):
        return []
    try:
        max_messages = max(1, min(int(max_messages), 100))
    except (TypeError, ValueError):
        max_messages = MAX_MESSAGES_DEFAULT
    try:
        max_chars = max(1000, int(max_chars))
    except (TypeError, ValueError):
        max_chars = MAX_CHARS_DEFAULT

    clamped = [_clamp_message(m) for m in messages]
    system = [m for m in clamped if isinstance(m, dict) and m.get("role") == "system"]
    rest = [m for m in clamped if not (isinstance(m, dict) and m.get("role") == "system")]

    window = rest[-max_messages:]
    window = _to_turn_boundary(window)
    window = _trim_to_chars(window, max_chars)
    return system + window


def _clamp_message(message):
    """Retourne le message avec un contenu borne a `MAX_CHARS_PER_MESSAGE`."""
    if not isinstance(message, dict):
        return message
    content = message.get("content")
    if isinstance(content, str) and len(content) > MAX_CHARS_PER_MESSAGE:
        return {**message, "content": content[:MAX_CHARS_PER_MESSAGE]}
    return message


def _to_turn_boundary(window):
    """Recule jusqu'a un `user` pour ne pas ouvrir sur un `tool`/`assistant` orphelin."""
    for i, m in enumerate(window):
        if isinstance(m, dict) and m.get("role") == "user":
            return window[i:]
    return window


def _trim_to_chars(window, max_chars):
    """Retire les tours les plus anciens tant que le total depasse `max_chars`."""
    while len(window) > 1 and _total_chars(window) > max_chars:
        # On retire jusqu'a la prochaine frontiere de tour pour rester coherent.
        drop = 1
        while drop < len(window) - 1 and window[drop].get("role") != "user":
            drop += 1
        window = window[drop:]
    return window


def _total_chars(window):
    total = 0
    for m in window:
        content = m.get("content") if isinstance(m, dict) else ""
        total += len(content) if isinstance(content, str) else len(str(content or ""))
    return total
