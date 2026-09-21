"""Habillage editorial : titre de section + accroche rediges par le LLM.

Le LLM ne choisit jamais les titres (c'est le moteur de reco) : il met en mots une
selection deja faite. Repli neutre si Ollama est indisponible — la page reste utile.

Partage par l'accueil et Decouvrir.
"""
import json

import ollama

from core.config import MODEL
from services.state import _tprint

# Ollama peut etre lent : on ne bloque jamais l'utilisateur pour un habillage.
_OLLAMA = ollama.Client(timeout=25.0)

FALLBACK_TITLE = "Recommandé pour toi"
FALLBACK_INTRO = "Une sélection tirée de tes écoutes et affinée par l'IA."


def llm_copy(tracks: list, genre: str, instructions: str = "") -> tuple[str, str]:
    """Retourne (titre, accroche) pour une selection de titres.

    Args:
        tracks: titres deja selectionnes (au moins `title`/`channel`).
        genre: genre dominant, sert de cadre a la redaction.
        instructions: precision optionnelle integree au prompt.

    Returns:
        (titre, accroche) ; repli neutre si le LLM repond mal ou est indisponible.
    """
    listing = ", ".join(f"{t.get('title', '')} — {t.get('channel', '')}" for t in tracks[:5])
    prompt = (
        "Tu es directeur editorial musical. Voici la selection deja recommandee "
        f"a l'utilisateur (genre dominant : {genre or 'varié'}) : {listing}. "
        f"{instructions} "
        "Redige en francais un titre de section court (4 mots maximum) et une "
        "phrase d'accroche personnalisee (20 mots maximum). "
        'Reponds STRICTEMENT en JSON : {"titre": "...", "accroche": "..."}'
    )
    try:
        resp = _OLLAMA.chat(
            model=MODEL,
            messages=[{"role": "user", "content": prompt}],
            options={"temperature": 0.6},
            format="json",
        )
        data = json.loads(resp["message"]["content"])
        title = str(data.get("titre", "")).strip()
        intro = str(data.get("accroche", "")).strip()
        if title and intro:
            return title, intro
        _tprint("[editorial] reponse LLM incomplete, repli")
    except Exception as exc:
        _tprint(f"[editorial] habillage indisponible ({type(exc).__name__}), repli")
    return FALLBACK_TITLE, FALLBACK_INTRO
