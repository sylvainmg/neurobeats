"""Gestion de l'historique conversationnel.

L'historique est detenu par le CLIENT (stateless server) : il l'envoie a chaque
appel /api/chat. Le serveur le tronque a un nombre maximal de messages pour
borner le contexte envoye au modele.
"""

MAX_MESSAGES_DEFAULT = 20


def truncate_messages(messages, max_messages=MAX_MESSAGES_DEFAULT):
    """Garde le(s) message(s) system en tete + les `max_messages` derniers tours.

    - messages : liste de dicts {role, content, ...}
    - max_messages : borne sur les messages NON-system (defaut 20)
    """
    if not isinstance(messages, list):
        return []
    try:
        max_messages = max(1, min(int(max_messages), 100))
    except (TypeError, ValueError):
        max_messages = MAX_MESSAGES_DEFAULT

    system = [m for m in messages if isinstance(m, dict) and m.get("role") == "system"]
    rest = [m for m in messages if not (isinstance(m, dict) and m.get("role") == "system")]
    return system + rest[-max_messages:]
