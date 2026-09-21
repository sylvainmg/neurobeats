"""Jaquettes d'album reelles : palier haut des pochettes HQ.

Un titre YouTube ne dit pas quel album il illustre. On interroge donc les
catalogues publics (Deezer, puis iTunes) avec l'artiste et le titre, et on
n'accepte QUE les rapprochements surs : mieux vaut garder la vignette YouTube
qu'afficher la jaquette d'un autre morceau. Le seuil est dans
`core.config.COVERS_MATCH_MIN`, et la duree sert d'arbitre quand on la connait
des deux cotes.

Interet pour la netteté : une jaquette d'album est **carree** (aucun recadrage,
donc aucun pixel perdu) et disponible en 1000 px et plus, la ou YouTube plafonne
a 1280x720 en 16/9 — soit 720 px de haut une fois recadre en carre.

Aucune cle d'API n'est requise. Une pochette ne changeant jamais, l'appelant met
le resultat en cache definitivement : ces API ne sont sollicitees qu'une fois par
titre.
"""
import json
import re
import unicodedata
import urllib.parse
import urllib.request
from difflib import SequenceMatcher

from core.config import COVERS_MATCH_MIN

TIMEOUT = 8.0
_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) NeuroBeats/1.0"

# Taille reclamee a iTunes : son URL de vignette porte la taille, donc on monte
# directement au-dela du plafond des pochettes (un seul telechargement utile).
ITUNES_PX = 1400

# Mentions qui trainent dans les titres et noms de chaine YouTube et faussent le
# rapprochement avec un catalogue musical. Appliquees des deux cotes de la
# comparaison, elles s'annulent : ce qu'elles risquent de gommer (« Live ») est
# rattrape par le controle de duree.
_NOISE = re.compile(
    r"\b(official|officiel|video|clip|lyrics?|paroles|audio|hd|hq|4k|remastered|"
    r"remaster|live|visualizer|topic|vevo|music|records?|feat|ft|with)\b",
    re.IGNORECASE)
_PARENS = re.compile(r"[\(\[\{][^\)\]\}]*[\)\]\}]")
_ARTIST_SPLIT = re.compile(r"\s+[-–—]\s+")

# Ecart de duree tolere (secondes) et penalite associee. Un titre exact du bon
# artiste reste un bon candidat meme si la version differe (clip raccourci,
# version album plus longue) : seule une divergence enorme fait echouer la
# comparaison, et une correspondance approximative reste alors ecartee.
_DURATION_BANDS = ((7, 0.0), (60, 0.08), (180, 0.15))
_DURATION_PENALTY = 0.30


def _normalize(text: str) -> str:
    """Minuscules, sans accents, ponctuation ni mentions parasites."""
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(char for char in text if not unicodedata.combining(char))
    text = _PARENS.sub(" ", text.lower())
    text = _NOISE.sub(" ", text)
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text).split())


def _search_term(text: str) -> str:
    """Libelle epure pour interroger un catalogue (casse et accents conserves).

    Le titre brut ne doit pas partir tel quel dans la requete : « Evidemment
    (lyrics video) » ne ressort rien, « Lomepal Evidemment » si.
    """
    return " ".join(_NOISE.sub(" ", _PARENS.sub(" ", text or "")).split())


def _ratio(left: str, right: str) -> float:
    return SequenceMatcher(None, left, right).ratio()


def _split_artist(title: str, channel: str) -> tuple[str, str]:
    """(artiste, titre) deduits du libelle YouTube et de la chaine.

    Convention dominante : « Artiste - Titre ». Quand le titre n'a pas de
    separateur, la chaine fait office d'artiste (« Lil Nas X - Topic »).
    """
    parts = _ARTIST_SPLIT.split(title or "", maxsplit=1)
    if len(parts) == 2 and parts[0].strip() and parts[1].strip():
        return parts[0].strip(), parts[1].strip()
    return (channel or "").strip(), (title or "").strip()


def _score(want_artist: str, want_title: str, want_duration, candidate: dict) -> float:
    """Confiance 0-1 du rapprochement d'un resultat de catalogue.

    Le titre pese un peu plus que l'artiste (les noms d'artistes varient
    beaucoup : featuring, label, suffixe « Topic »), et un ecart de duree
    significatif disqualifie presque le candidat.
    """
    got_title = _normalize(candidate.get("title", ""))
    want_title = _normalize(want_title)
    if not got_title or not want_title:
        return 0.0
    title_score = _ratio(want_title, got_title)
    if want_title in got_title or got_title in want_title:
        title_score = max(title_score, 0.9)

    got_artist = _normalize(candidate.get("artist", ""))
    want_artist = _normalize(want_artist)
    artist_score = 0.0
    if want_artist and got_artist:
        artist_score = _ratio(want_artist, got_artist)
        if want_artist in got_artist or got_artist in want_artist:
            artist_score = max(artist_score, 0.9)

    got_duration = candidate.get("duration")
    penalty = 0.0
    if want_duration and got_duration:
        try:
            gap = abs(float(want_duration) - float(got_duration))
            penalty = next((amount for limit, amount in _DURATION_BANDS if gap <= limit),
                           _DURATION_PENALTY)
        except (TypeError, ValueError):
            pass
    return max(0.0, min(1.0, 0.55 * title_score + 0.45 * artist_score - penalty))


def _get_json(url: str):
    """GET JSON best-effort : None si reseau, timeout ou reponse illisible."""
    try:
        request = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            return json.loads(response.read().decode("utf-8", "replace"))
    except Exception:
        return None


def _deezer(artist: str, title: str, duration):
    """Meilleur candidat Deezer (jaquette 1000x1000), ou None."""
    data = _get_json("https://api.deezer.com/search?limit=10&q="
                     + urllib.parse.quote(_search_term(f"{artist} {title}")))
    best = None
    for item in (data or {}).get("data") or []:
        album = item.get("album") or {}
        cover = album.get("cover_xl") or album.get("cover_big")
        if not cover:
            continue
        score = _score(artist, title, duration, {
            "title": item.get("title") or "",
            "artist": (item.get("artist") or {}).get("name") or "",
            "duration": item.get("duration"),
        })
        if best is None or score > best["score"]:
            best = {"url": cover, "provider": "deezer", "score": score}
    return best


def _itunes(artist: str, title: str, duration):
    """Meilleur candidat iTunes (jaquette jusqu'a ITUNES_PX), ou None."""
    data = _get_json("https://itunes.apple.com/search?limit=10&entity=song&term="
                     + urllib.parse.quote(_search_term(f"{artist} {title}")))
    best = None
    for item in (data or {}).get("results") or []:
        artwork = item.get("artworkUrl100") or ""
        if not artwork:
            continue
        score = _score(artist, title, duration, {
            "title": item.get("trackName") or "",
            "artist": item.get("artistName") or "",
            "duration": (item.get("trackTimeMillis") or 0) / 1000 or None,
        })
        if best is None or score > best["score"]:
            best = {
                "url": re.sub(r"/\d+x\d+bb\.(?:jpg|png)",
                              f"/{ITUNES_PX}x{ITUNES_PX}bb.jpg", artwork),
                "provider": "itunes",
                "score": score,
            }
    return best


def resolve(title: str, channel: str, duration=None):
    """Jaquette d'album sure pour ce titre, ou None.

    Args:
        title: libelle YouTube (« Lil Nas X - MONTERO (Official Video) »).
        channel: chaine YouTube, utilisee comme artiste a defaut de separateur.
        duration: duree en secondes, si connue (arbitre les versions live/remix).

    Returns:
        dict {url, provider, score, artist, track} si la confiance atteint
        COVERS_MATCH_MIN ; None sinon, et l'appelant passe au palier suivant.
    """
    artist, track = _split_artist(title, channel)
    if not track:
        return None
    for provider in (_deezer, _itunes):
        best = provider(artist, track, duration)
        if best and best["score"] >= COVERS_MATCH_MIN:
            best.update({"artist": artist, "track": track})
            return best
    return None
