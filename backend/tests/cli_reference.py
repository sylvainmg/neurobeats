"""NeuroBeats - CLI terminal de REFERENCE (non produit).

Ce fichier est la reference fonctionnelle du moteur : il reproduit la boucle
conversationnelle Ollama + les filets deterministes qui jouaient le role de
"tests manuels" pendant le developpement. Le produit est le backend FastAPI
(backend/), qui expose le meme moteur en REST.

Usage : python tests/cli_reference.py   (ou tests/run.sh)
"""
import json
import os
import re
import sys
import threading

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.abspath(os.path.join(_HERE, ".."))  # backend/ (parent de tests/)
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

import ollama
import app as engine  # moteur NeuroBeats (search_music, play_music, ...)

MODEL = engine.MODEL
BASE = engine.BASE
# Table de dispatch des tools (reference CLI). Le moteur n'expose plus FUNCTIONS :
# l'API FastAPI route explicitement ; le CLI la reconstruit ici.
FUNCTIONS = {
    "search_music": engine.search_music,
    "play_now": engine.play_now,
    "play_music": engine.play_music,
    "play_choice": engine.play_choice,
    "stop_music": engine.stop_music,
    "create_playlist": engine.create_playlist,
    "load_playlist": engine.load_playlist,
    "playlist_next": engine.playlist_next,
    "start_streaming": engine.start_streaming,
    "stop_streaming": engine.stop_streaming,
    "skip_streaming": engine.skip_streaming,
    "get_recommendation": engine.get_recommendation,
    "get_user_stats": engine.get_user_stats,
    "store_preference": engine.store_preference,
}
LAST_SEARCH = engine.LAST_SEARCH



# ===================== Filets deterministes (reference) =====================

ORDINAL_MAP = {
    "premier": 1, "premiere": 1, "1er": 1, "1ere": 1, "1ème": 1, "1eme": 1,
    "deuxieme": 2, "deuxième": 2, "2e": 2, "2eme": 2, "2ème": 2, "second": 2, "seconde": 2,
    "troisieme": 3, "troisième": 3, "3e": 3, "3eme": 3, "3ème": 3,
    "quatrieme": 4, "quatrième": 4, "4e": 4, "4eme": 4, "4ème": 4,
    "cinquieme": 5, "cinquième": 5, "5e": 5, "5eme": 5, "5ème": 5,
}
_SELECT_RE = re.compile(
    r"^(?:le|la|l['’]|option(?:\s*n[°o])?|choix(?:\s*n[°o])?|num[eé]ro|titre(?:\s*n[°o])?|morceau|chanson|celui(?:-ci|-l[aà])?|celle(?:-ci|-l[aà])?)?"
    r"\s*(\d+|premier|premi[èe]re|1er|1ere|1[èe]me|deuxi[èe]me|2e|2[èe]me|troisi[èe]me|3e|3[èe]me|"
    r"quatri[èe]me|4e|4[èe]me|cinqui[èe]me|5e|5[èe]me|second|seconde|dernier|derni[èe]re)\s*[!.]?$",
    re.IGNORECASE,
)


def _parse_selection(text: str) -> int | None:
    """Si text est une selection ('le 1', '2', 'premier', 'dernier'...), retourne l'index 1-based, sinon None."""
    if not engine.LAST_SEARCH:
        return None
    t = text.strip().lower()
    if len(t) > 25:  # pas une reponse courte -> pas une selection
        return None
    m = _SELECT_RE.match(t)
    if not m:
        return None
    raw = m.group(1).lower()
    if raw in ("dernier", "derniere", "dernière"):
        return len(engine.LAST_SEARCH)
    if raw.isdigit():
        return int(raw)
    return ORDINAL_MAP.get(raw)



_RECO_RE = re.compile(
    r"(recomm?end|suggest|reco|sugg[eè]re|propose|d[eé]couvrir|d[eé]couverte|"
    r"autre chose|quelque chose|dans la veine|dans le m[êe]me|similaire|pareil|encore|"
    r"you may also like|si tu aimais|qu'est-ce que tu me conseilles|conseille)",
    re.IGNORECASE,
)


# Mots de pure demande (sans contenu) : 'recommande ...', 'encore', 'd'autres ...?'
_RECO_FILLER = {
    "recommande", "recommandes", "recommandez", "recommandation", "recommandations",
    "recommende", "recommendes", "recommendez", "recommendation", "recommendations",
    "reco", "recos", "suggere", "suggeres", "suggerez", "suggère", "suggères",
    "suggérez", "suggestion", "suggestions",
    "propose", "proposes", "proposez", "proposition", "propositions",
    "autre", "autres", "encore", "plus", "nouveau", "nouveaux", "nouvelle", "nouvelles",
    "quelque", "chose", "truc", "idée", "idee", "son", "sons", "musique", "musiques",
    "titre", "titres", "morceau", "morceaux", "écoute", "ecoute", "écouter", "ecouter",
    "quoi", "que", "moi", "stp", "svp", "plait", "donne", "donnez", "fais",
    "découvrir", "decouvrir", "découverte", "decouverte", "similar", "similaire",
    "pareil", "veine", "meme", "même", "dans", "le", "la", "les", "de", "des",
    "du", "un", "une", "et", "en", "au", "aux", "a", "tu", "vous", "je", "me",
    "d", "l", "s", "t", "qu", "que", "est", "ce", "c",
}


def _parse_reco_request(text: str) -> str | None:
    """Si text demande une reco, retourne le contexte pour get_recommendation, sinon None.
    Retourne '' si la demande n'a AUCUN contenu (ex: \"d'autres recommendations?\") :
    le moteur utilisera alors favoris + Markov, jamais la phrase brute sur YouTube."""
    if len(text) > 200 or not _RECO_RE.search(text):
        return None
    t = text.strip()
    # Extrait le contexte apres 'comme' si present (ex : 'comme Cartier de Gazo')
    m = re.search(r"comme\s+(.+)$", t, re.IGNORECASE)
    if m:
        return m.group(1).strip()
    # Reste-t-il un mot de contenu (artiste/titre/genre) hors filler ?
    words = [w for w in re.findall(r"[a-zàâäéèêëîïôöùûüç]+", t.lower()) if w not in _RECO_FILLER]
    if words:
        return t  # ex : 'du rap calme' -> garde comme contexte
    return ""


_PLAYLIST_RE = re.compile(r"playlist", re.IGNORECASE)
_PLAY_CREATE_RE = re.compile(
    r"(?:cr[eé]e(?:-moi)?|cr[eé]er|fais(?:-moi)?|faire|g[eé]n[eè]re(?:-moi)?)\s+"
    r"(?:une?\s+|la\s+)?playlist\s+(.+?)\s+(?:de|avec|pour)\s+(\d+)\s*(?:titres?|morceaux?|sons?)?"
    r"(?:\s+(?:de|en|sur|dans)\s+(.+))?\s*$",
    re.IGNORECASE,
)
_PLAY_CREATE_SIMPLE_RE = re.compile(
    r"(?:cr[eé]e(?:-moi)?|cr[eé]er|fais(?:-moi)?|faire|g[eé]n[eè]re(?:-moi)?)\s+"
    r"(?:une?\s+|la\s+)?playlist\s+(.+?)(?:\s+(?:de|en|sur|dans)\s+(.+))?\s*$",
    re.IGNORECASE,
)
_PLAY_LOAD_RE = re.compile(
    r"(?:lance(?:-moi)?|lancer|joue(?:-moi)?|jouer|mets?|mettre|d[eé]marre(?:-moi)?|load|load_playlist)"
    r"\s+(?:la\s+|ma\s+)?playlist\s+(.+?)\s*$",
    re.IGNORECASE,
)


def _parse_playlist_request(text: str):
    """('create', name, mood, count) | ('load', name) | None — filet deterministe playlists."""
    t = text.strip()
    if len(t) > 200 or not _PLAYLIST_RE.search(t):
        return None
    m = _PLAY_CREATE_RE.match(t)
    if m:
        name, count, mood = m.group(1).strip(), m.group(2), (m.group(3) or "").strip()
        return ("create", name.strip("'\" "), mood.strip("'\" ") or name, int(count))
    m = _PLAY_CREATE_SIMPLE_RE.match(t)
    if m:
        name, mood = m.group(1).strip(), (m.group(2) or "").strip()
        if re.search(r"\b(le|la|l['’]|num[eé]ro|choix|titre|morceau)\b\s*\d", name, re.IGNORECASE):
            return None  # 'le 1' etc : c'est une selection, pas une playlist
        return ("create", name.strip("'\" "), mood.strip("'\" ") or name, 10)
    m = _PLAY_LOAD_RE.match(t)
    if m:
        return ("load", m.group(1).strip().strip("'\" "), "", 0)
    return None


_PLAY_VERB_RE = re.compile(
    r"^(?:lance(?:-moi)?|lancer|lancez|joue(?:-moi)?|jouer|jouez|"
    r"mets(?:-moi)?|mettre|mettez|écoute(?:-moi)?|écouter|écoutez|"
    r"démarre(?:-moi)?|démarrer|démarrez|play|relance(?:-moi)?|relancer|"
    r"rejoue(?:-moi)?|rejouer|remets(?:-moi)?|remettre)\b\s*(.+?)\s*$",
    re.IGNORECASE,
)
_THIS_RE = re.compile(
    r"^(?:ce|cet|cette)\s+(son|morceau|titre|tube|musique|chanson)s?$|"
    r"^(?:celui-ci|celle-ci|celui-là|celle-là|joue-le|lance-le)$",
    re.IGNORECASE,
)
_BARE_PLAYLIST_RE = re.compile(r"^(?:la|ma|une|les?)\s+playlists?$", re.IGNORECASE)


def _parse_play_request(text: str):
    """('play', query) | ('this',) | None — verbe d'action explicite en tete.
    La query est NETTOYEE du verbe ('Lance Winterfell de MMZ' -> 'Winterfell de MMZ')
    car le verbe fausse le match YouTube. 'ce son/celui-ci' -> joue la liste en cours."""
    t = text.strip()
    if len(t) > 200:
        return None
    m = _PLAY_VERB_RE.match(t)
    if not m:
        return None
    query = m.group(1).strip().strip("'\" ")
    if not query or _BARE_PLAYLIST_RE.match(query):
        return None  # pas de contenu reel -> laisse au LLM (playlists/streaming geres avant)
    low = query.lower()
    if "playlist" in low or "flux" in low or "radio" in low or "streaming" in low or "stream" in low:
        return None  # routes dediees (playlist/streaming) prioritaires, gerees avant ce filet
    if _THIS_RE.match(query):
        return ("this", "", 0)
    return ("play", query, 0)


_STREAMING_RE = re.compile(
    r"(flux\s+infini|en\s+continu|la\s+radio|mode\s+radio|streaming|non-?stop|sans\s+arr[eê]t)",
    re.IGNORECASE,
)
_STREAM_STOP_RE = re.compile(
    r"(stoppe?r?\s+(le\s+|la\s+)?(flux|stream|streaming|radio)|arr[eê]te?\s+(le\s+|la\s+)?(flux|stream|streaming|radio)|"
    r"stop\s+(le\s+|la\s+)?(flux|stream)|coupe\s+(le\s+|la\s+)?(flux|stream))",
    re.IGNORECASE,
)
_STREAM_SKIP_RE = re.compile(
    r"^(?:passe(?:-moi)?|passer|skip|zappe(?:-moi)?|zapper|suivant|next)\b.{0,40}$",
    re.IGNORECASE,
)
_STREAM_START_RE = re.compile(
    r"(?:d[eé]marre(?:-moi)?|d[eé]marrer|lance(?:-moi)?|lancer|mets?|mettre|active(?:-moi)?|start)"
    r"\b.{0,60}?(flux\s+infini|en\s+continu|la\s+radio|mode\s+radio|streaming)",
    re.IGNORECASE,
)


def _parse_streaming_request(text: str):
    """('start', mood) | ('stop',) | ('skip',) | None — filet deterministe streaming."""
    t = text.strip()
    if len(t) > 200:
        return None
    if _STREAM_STOP_RE.search(t):
        return ("stop", "", 0)
    if engine.STREAMING_MODE and _STREAM_SKIP_RE.match(t):
        return ("skip", "", 0)
    if _STREAM_START_RE.search(t) or (_STREAMING_RE.search(t) and re.search(
            r"\b(d[eé]marre|lance|mets?|active|start|joue|jouer|play)\b", t, re.IGNORECASE)):
        m = re.search(r"comme\s+(.+)$", t, re.IGNORECASE)
        if m:
            return ("start", m.group(1).strip(), 0)
        words = [w for w in re.findall(r"[a-zàâäéèêëîïôöùûüç]+", t.lower())
                 if w not in _RECO_FILLER]
        mood_words = [w for w in words if w not in
                      {"demarre", "demarrez", "demarrer", "démarre", "démarrez", "démarrer",
                       "lance", "lancer", "lancez", "mets",
                       "mettre", "mettez", "active", "activer", "activez", "start", "joue",
                       "jouer", "jouez", "play", "flux", "infini", "continu", "radio", "mode",
                       "streaming", "stop", "non"}]
        return ("start", " ".join(mood_words), 0)
    return None


# ===================== Boucle conversationnelle =====================

def main():
    """Boucle conversationnelle du CLI de reference (Ollama + filets deterministes)."""
    tools = json.load(open(f"{BASE}/tools.json", encoding="utf-8"))
    engine._migrate_json_to_db()  # 1er run : importe les JSON dans SQLite puis .bak
    threading.Thread(target=engine.net_probe, daemon=True).start()  # classe reseau en fond
    threading.Thread(target=engine._cold_start_warmup, daemon=True).start()  # warm-up embeddings + prefetch
    engine._load_stream_cache()  # URLs audio en cache (~0s de resolution, TTL 5h)
    messages = [
        {"role": "system", "content": (
            "Tu es NeuroBeats, un assistant musical avec acces REEL a YouTube. Reponds toujours en francais. "
            "REGLE CRITIQUE : ne JAMAIS inventer de video_id. Pour jouer un titre, appelle TOUJOURS "
            "search_music d'abord, puis play_music UNIQUEMENT avec un video_id retourne par search_music "
            "ou get_recommendation. Si l'utilisateur demande un titre precis, cherche-le tel quel. "
            "Si la recherche ne retourne rien de pertinent, dis-le honnetement au lieu de jouer autre chose. "
            "AUTOPLAY STRICT : si la demande contient un verbe d'action explicite (lance, joue, mets, ecoute, "
            "demarre, play...) alors appelle play_now avec la requete : ce tool cherche ET joue en un seul appel. "
            "Si la demande est vague ou sans verbe d'action (simple mention d'un titre, question, exploration), "
            "appelle search_music, presente la liste NUMEROTEE (1. titre — chaine (duree), un par ligne) et demande a l'utilisateur de choisir. "
            "CHOIX NUMEROTE : si l'utilisateur repond par un numero ou un ordinal ('le 1', '2', 'le 2eme', 'premier', "
            "'dernier'...), appelle TOUJOURS play_choice avec cet index : ne reponds JAMAIS 'je joue ...' "
            "sans avoir appele play_choice (sinon rien ne joue reellement). "
            "INTERDICTION D'INVENTER : ne cite JAMAIS un titre, une version ou une option specifique "
            "(official video, live, remix...) sans l'avoir obtenue d'un resultat de tool ; "
            "si tu n'as pas encore appele de tool, appelle search_music au lieu de repondre de memoire. "
            "Apres une lecture immediate reussie (status playing), annonce en UNE phrase ce qui joue "
            "(ex : 'Je joue CELINE 3x. Dis-moi si tu voulais une autre version.'). "
            "CONFIDENTIALITE DU JARGON : ne montre JAMAIS de video_id brut ni de nom d'outil "
            "(play_music, search_music...) a l'utilisateur ; parle en titres de chansons. "
            "Pour stopper la lecture, utilise stop_music. "
            "Pour recommander, appelle get_recommendation avec le contexte en query (titre du moment ou envie "
            "exprimee, ex : 'comme Cartier de Gazo') : il retourne 3 videos NON ecoutees, jouables via play_music "
            "ou play_choice ; presente-les NUMEROTEES et propose de jouer un numero. "
            "PLAYLISTS : pour 'cree une playlist NOM de N titres (mood)', appelle create_playlist(name=NOM, "
            "mood=MOOD ou NOM, count=N) ; pour 'lance/joue la playlist NOM', appelle load_playlist(name=NOM) ; "
            "presente la playlist NUMEROTEE (titre — chaine, un par ligne). "
            "STREAMING : pour 'flux infini / radio / en continu (mood)', appelle start_streaming(mood=MOOD ou '') ; "
            "pour 'stoppe le flux / la radio', stop_streaming ; pour 'suivant / skip', skip_streaming. "
            "Ne boucle JAMAIS toi-meme sur get_recommendation : le thread streaming gere l'enchainement. "
            "STATS : pour 'mes stats / qu'est-ce que j'écoute / mes goûts', appelle get_user_stats "
            "(genre/artiste top, créneau préféré, skips) et résume en français sans jargon."
        )}
    ]
    print("🎵 NeuroBeats (YouTube) — tape 'quit' pour quitter.\n")
    threading.Thread(target=engine._ipc_event_loop, daemon=True).start()  # timer 1er son (poll time-pos)
    try:
        while True:
            engine._drain_timer_msgs()  # timers affiches ici, jamais pendant input()
            try:
                user_input = input("Vous > ").strip()
            except (EOFError, KeyboardInterrupt):
                print("\nA bientot !")
                break
            if user_input.lower() in ("quit", "exit"):
                print("A bientot !")
                break
            if not user_input:
                continue
            # Ordre des filets : selection, reco, playlist, streaming AVANT autoplay.
            # (play capte 'lance...' mais les routes playlist/flux/radio sont prioritaires ;
            #  le bloc autoplay est apres le filet streaming, voir plus bas.)
            sel = _parse_selection(user_input)
            if sel is not None:
                # Filet de securite deterministe : 'le 1', '2'... jouent SANS passer par le LLM
                # (le modele repond parfois 'je joue ...' sans appeler le tool -> rien ne joue).
                messages.append({"role": "user", "content": user_input})
                print(f"  [tool] play_choice{{'index': {sel}}}")
                result = engine.play_choice(sel)
                try:
                    data = json.loads(result)
                except json.JSONDecodeError:
                    data = {}
                messages.append({"role": "tool", "content": result})
                if data.get("status") == "playing":
                    print(f"\nNeuroBeats > Je joue {data.get('title', '')}. Dis-moi si tu voulais une autre version.\n")
                    messages.append({"role": "assistant", "content": f"Je joue {data.get('title', '')}."})
                else:
                    print(f"\nNeuroBeats > {data.get('error', 'Choix impossible.')}\n")
                    messages.append({"role": "assistant", "content": data.get("error", "Choix impossible.")})
                continue
            reco_q = _parse_reco_request(user_input)
            if reco_q is not None:
                # Filet deterministe : le modele hallucine parfois une liste sans appeler
                # get_recommendation -> on appelle le vrai moteur et on affiche la liste NUMEROTEE.
                messages.append({"role": "user", "content": user_input})
                print(f"  [tool] get_recommendation{{'query': {reco_q!r}}}")
                result = engine.get_recommendation(reco_q)
                try:
                    data = json.loads(result)
                except json.JSONDecodeError:
                    data = {}
                messages.append({"role": "tool", "content": result})
                recos = data.get("recommendations", []) if isinstance(data, dict) else []
                if recos:
                    lines = [f"{i + 1}. {r.get('title', '')} — {r.get('channel', '')}"
                             for i, r in enumerate(recos)]
                    reply = "Voici ce que je te propose :\n" + "\n".join(lines)
                    if isinstance(data, dict) and data.get("warning"):
                        reply += f"\n({data['warning']})"
                    reply += "\nDis-moi un numero pour jouer."
                    print(f"\nNeuroBeats > {reply}\n")
                    messages.append({"role": "assistant", "content": reply})
                else:
                    err = (data.get("error", "Pas de recommandation pour le moment.")
                           if isinstance(data, dict) else "Pas de recommandation pour le moment.")
                    print(f"\nNeuroBeats > {err}\n")
                    messages.append({"role": "assistant", "content": err})
                continue
            pl_req = _parse_playlist_request(user_input)
            if pl_req is not None:
                # Filet deterministe playlists : construction/lecture SANS passer par le LLM.
                messages.append({"role": "user", "content": user_input})
                kind = pl_req[0]
                if kind == "create":
                    _, name, mood, count = pl_req
                    print(f"  [tool] create_playlist{{'name': {name!r}, 'mood': {mood!r}, 'count': {count}}}")
                    result = engine.create_playlist(name, mood, count)
                    try:
                        data = json.loads(result)
                    except json.JSONDecodeError:
                        data = {}
                    messages.append({"role": "tool", "content": result})
                    songs = data.get("songs", []) if isinstance(data, dict) else []
                    if songs:
                        lines = [f"{i + 1}. {s.get('title', '')} — {s.get('channel', '')}"
                                 for i, s in enumerate(songs)]
                        reply = (f"Playlist '{data.get('name', name)}' ({len(songs)} titres)"
                                 + (f" — ambiance {data.get('mood', '')}" if data.get("mood") else "")
                                 + " :\n" + "\n".join(lines))
                        if data.get("warning"):
                            reply += f"\n({data['warning']})"
                        reply += "\nDis 'lance la playlist' pour l'écouter."
                    else:
                        reply = data.get("error", "Playlist vide.") if isinstance(data, dict) else "Playlist vide."
                    print(f"\nNeuroBeats > {reply}\n")
                    messages.append({"role": "assistant", "content": reply})
                else:
                    _, name, _, _ = pl_req
                    print(f"  [tool] load_playlist{{'name': {name!r}}}")
                    result = engine.load_playlist(name)
                    try:
                        data = json.loads(result)
                    except json.JSONDecodeError:
                        data = {}
                    messages.append({"role": "tool", "content": result})
                    songs = data.get("songs", []) if isinstance(data, dict) else []
                    if songs and data.get("status") == "playing_playlist":
                        lines = [f"{i + 1}. {s.get('title', '')} — {s.get('channel', '')}"
                                 for i, s in enumerate(songs)]
                        reply = (f"Playlist '{data.get('name', name)}' ({len(songs)} titres) :\n"
                                 + "\n".join(lines) + "\n▶ Lecture du 1er titre.")
                    else:
                        reply = data.get("error", "Playlist introuvable.") if isinstance(data, dict) else "Playlist introuvable."
                        if isinstance(data, dict) and data.get("playlists"):
                            reply += f" (dispo : {', '.join(data['playlists'])})"
                    print(f"\nNeuroBeats > {reply}\n")
                    messages.append({"role": "assistant", "content": reply})
                continue
            st_req = _parse_streaming_request(user_input)
            if st_req is not None:
                # Filet deterministe streaming : start/stop/skip SANS passer par le LLM.
                messages.append({"role": "user", "content": user_input})
                kind = st_req[0]
                if kind == "start":
                    _, mood, _ = st_req[0], st_req[1], st_req[2]
                    print(f"  [tool] start_streaming{{'mood': {mood!r}}}")
                    result = engine.start_streaming(mood)
                    try:
                        data = json.loads(result)
                    except json.JSONDecodeError:
                        data = {}
                    messages.append({"role": "tool", "content": result})
                    if data.get("status") == "streaming_started":
                        reply = (f"Flux infini lancé"
                                 + (f" — ambiance {mood}" if mood else "")
                                 + ". Les titres s'enchaînent seuls ; dis 'suivant', 'stoppe le flux' ou 'quit'.")
                    else:
                        reply = f"Flux déjà en cours ({data.get('count', 0)} titres joués)."
                    print(f"\nNeuroBeats > {reply}\n")
                    messages.append({"role": "assistant", "content": reply})
                elif kind == "stop":
                    print("  [tool] stop_streaming{}")
                    result = engine.stop_streaming()
                    messages.append({"role": "tool", "content": result})
                    print("\nNeuroBeats > Flux arrêté. Dis-moi ce que tu veux écouter.\n")
                    messages.append({"role": "assistant", "content": "Flux arrêté."})
                else:
                    print("  [tool] skip_streaming{}")
                    result = engine.skip_streaming()
                    try:
                        data = json.loads(result)
                    except json.JSONDecodeError:
                        data = {}
                    messages.append({"role": "tool", "content": result})
                    reply = "Titre suivant…" if data.get("status") == "skipped" else data.get("error", "Pas de flux en cours.")
                    print(f"\nNeuroBeats > {reply}\n")
                    messages.append({"role": "assistant", "content": reply})
                continue
            play_req = _parse_play_request(user_input)
            if play_req is not None:
                # Filet deterministe autoplay : verbe d'action explicite -> play_now direct
                # avec query NETTOYEE (le verbe fausse le match YouTube : 'Lance Winterfell'
                # doit chercher 'Winterfell', pas 'Lance Winterfell'). Apres les filets
                # selection/reco/playlist/streaming (routes prioritaires).
                messages.append({"role": "user", "content": user_input})
                kind = play_req[0]
                if kind == "this":
                    if not engine.LAST_SEARCH:
                        reply = "Rien n'est en liste pour le moment. Demande-moi une recherche ou une reco."
                        print(f"\nNeuroBeats > {reply}\n")
                        messages.append({"role": "assistant", "content": reply})
                    else:
                        print("  [tool] play_choice{'index': 1}")
                        result = engine.play_choice(1)
                        try:
                            data = json.loads(result)
                        except json.JSONDecodeError:
                            data = {}
                        messages.append({"role": "tool", "content": result})
                        if data.get("status") == "playing":
                            reply = f"Je joue {data.get('title', '')}. Dis-moi si tu voulais une autre version."
                        else:
                            reply = data.get("error", "Choix impossible.")
                        print(f"\nNeuroBeats > {reply}\n")
                        messages.append({"role": "assistant", "content": reply})
                else:
                    _, query, _ = play_req
                    print(f"  [tool] play_now{{'query': {query!r}}}")
                    result = engine.play_now(query)
                    try:
                        data = json.loads(result)
                    except json.JSONDecodeError:
                        data = {}
                    messages.append({"role": "tool", "content": result})
                    if isinstance(data, dict) and data.get("status") == "playing":
                        reply = f"Je joue {data.get('title', '')}. Dis-moi si tu voulais une autre version."
                        print(f"\nNeuroBeats > {reply}\n")
                        messages.append({"role": "assistant", "content": reply})
                    elif isinstance(data, dict) and data.get("options"):
                        lines = [f"{i + 1}. {r.get('title', '')} — {r.get('channel', '')}"
                                 for i, r in enumerate(data["options"])]
                        reply = ("Requête un peu vague, voici les options :\n" + "\n".join(lines)
                                 + "\nDis-moi un numero pour jouer.")
                        print(f"\nNeuroBeats > {reply}\n")
                        messages.append({"role": "assistant", "content": reply})
                    else:
                        reply = (data.get("error", "Recherche impossible.")
                                 if isinstance(data, dict) else "Recherche impossible.")
                        print(f"\nNeuroBeats > {reply}\n")
                        messages.append({"role": "assistant", "content": reply})
                continue
            messages.append({"role": "user", "content": user_input})

            response = ollama.chat(model=MODEL, messages=messages, tools=tools)
            msg = response["message"]

            while msg.get("tool_calls"):
                messages.append(msg)
                for call in msg["tool_calls"]:
                    name = call["function"]["name"]
                    args = call["function"].get("arguments", {})
                    print(f"  [tool] {name}{args}")
                    fn = FUNCTIONS.get(name)
                    try:
                        result = fn(**args) if fn else json.dumps({"error": f"Tool inconnu: {name}"})
                    except Exception as exc:
                        result = json.dumps({"error": f"Echec tool {name} : {exc}"}, ensure_ascii=False)
                    messages.append({"role": "tool", "content": str(result)})
                response = ollama.chat(model=MODEL, messages=messages, tools=tools)
                msg = response["message"]

            print(f"\nNeuroBeats > {msg.get('content', '')}\n")
            messages.append(msg)
    finally:
        engine.STREAMING_MODE = False
        engine.STREAMING_SKIP.set()
        engine._drain_timer_msgs()
        engine._stop_player()
        engine._shutdown_daemon()




if __name__ == "__main__":
    main()
