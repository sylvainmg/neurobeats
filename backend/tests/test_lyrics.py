"""Paroles : parseur LRC, extraction Genius, pipeline et cache.

Script autonome (meme style que test_covers.py) : il sort en code 1 si un cas
echoue. La base et le cache sont rediriges vers un dossier temporaire, donc la
vraie bibliotheque de paroles n'est jamais touchee ; les sources reseau sont
remplacees par des fakes (aucun appel externe sauf 1 cas live, signale SKIP).

Usage: backend/.venv/bin/python backend/tests/test_lyrics.py
"""
import asyncio
import os
import shutil
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))

from core import db as engine_db
from services import lyrics

CHECKS = []
SKIPPED = []


def check(name, ok, detail=""):
    CHECKS.append(bool(ok))
    print(f"  {'OK   ' if ok else 'ECHEC'} {name}" + (f"  [{detail}]" if detail else ""))


def skip(name, why=""):
    SKIPPED.append(name)
    print(f"  SKIP  {name}" + (f"  [{why}]" if why else ""))


# --- Bac a sable : ni la base ni les caches reels ne sont touches ------------
SANDBOX = tempfile.mkdtemp(prefix="lyrics-test-")
engine_db.DB_PATH = os.path.join(SANDBOX, "test.db")
engine_db.db_init()

_SYNCED_LRC = """[ar:Artiste inconnu]
[00:17.12] First line
[00:20.00][00:24.50] Chorus line
[00:28.31] <00:28.31>Word level</00:35.00> enhanced
[01:02.5] Last line
"""


def _mock_lrclib(payload):
    """Remplace la source LRCLIB par un fake comptabilise."""
    calls = {"n": 0}

    def fake(artist, title, duration):
        calls["n"] += 1
        return payload

    lyrics._lrclib = fake
    return calls


def _mock_genius(payload):
    """Remplace la source Genius par un fake comptabilise."""
    calls = {"n": 0}

    def fake(artist, title, channel):
        calls["n"] += 1
        return payload

    lyrics._genius = fake
    return calls


def _expire(video_id, days=8):
    """Fait vieillir une entree de cache au-dela de son TTL (miss: 7 j)."""
    engine_db.db_lyrics_put(
        video_id, status="miss", source="", synced=0, instrumental=0,
        title="", artist="", payload="", error="")
    con = engine_db._connect()
    old = (datetime.now() - timedelta(days=days)).isoformat()
    con.execute("UPDATE lyrics SET created_at=? WHERE video_id=?", (old, video_id))
    con.commit()
    con.close()


print("\n[1] Parseur LRC")
lines = lyrics._parse_lrc(_SYNCED_LRC)
check("les horodatages sont lus et arrondis",
      lines[0] == {"time": 17.12, "text": "First line"}, str(lines[0]))
check("un refrain a deux instants donne deux entrees",
      [l["text"] for l in lines if l["text"] == "Chorus line"] ==
      ["Chorus line", "Chorus line"])
check("le LRC enhanced est depouille",
      not any("Word level" in l["text"] and "<" in l["text"] for l in lines),
      str(lines))
check("les balises metadonnees ([ar:], [ti:]) sont ignorees",
      all("[ar:" not in l["text"] and "[ti:" not in l["text"] for l in lines))
check("le tri est chronologique",
      [l["time"] for l in lines] == sorted(l["time"] for l in lines),
      str([l["time"] for l in lines]))
big = lyrics._parse_lrc("[12:34.56] x")
check("le format [mm:ss.xx] passe la minute", big[0]["time"] == 754.56, str(big))

plain = lyrics._clean_plain("  Premiere   ligne \n\n  Seconde\n")
check("le texte brut est resserre et les vides retires",
      plain == ["Premiere ligne", "Seconde"], str(plain))

print("\n[2] Normalisation artiste / titre")
check("artiste deduit du libelle",
      lyrics.coverart._split_artist("GAZO - CARTIER", "Gazo") == ("GAZO", "CARTIER"))
check("artiste deduit de la chaine sans separateur",
      lyrics.coverart._split_artist("Evidemment", "Lomepal") == ("Lomepal", "Evidemment"))
check("les mentions YouTube sont retirees de la requete",
      lyrics.coverart._search_term("MONTERO (Official Video)") == "MONTERO",
      repr(lyrics.coverart._search_term("MONTERO (Official Video)")))

print("\n[3] Conversion d'un enregistrement LRCLIB")
rec = lyrics._lrclib_record({
    "trackName": "CARTIER", "artistName": "Gazo", "duration": 225.6,
    "syncedLyrics": "[00:06.89] Ready, ready, ready\n[00:11.59] Eh, eh, eh",
    "plainLyrics": "Ready, ready, ready\nEh, eh, eh", "instrumental": False})
check("le synced prime sur le texte",
      rec["synced"] is True and rec["lines"][0]["time"] == 6.89, str(rec["lines"][:1]))
rec = lyrics._lrclib_record({
    "trackName": "X", "artistName": "Y", "syncedLyrics": "",
    "plainLyrics": "Un\nDeux", "instrumental": False})
check("sans synced, le texte brut alimente des lignes sans temps",
      rec["synced"] is False and rec["lines"] ==
      [{"time": None, "text": "Un"}, {"time": None, "text": "Deux"}])
rec = lyrics._lrclib_record({"instrumental": True, "syncedLyrics": "",
                             "plainLyrics": "", "trackName": "Ocean",
                             "artistName": "Ambient"})
check("instrumental = une vraie reponse (pas un echec)",
      rec["instrumental"] is True and rec["lines"] == [])
check("un enregistrement vide est rejete",
      lyrics._lrclib_record({"trackName": "", "artistName": "",
                             "syncedLyrics": "", "plainLyrics": ""}) is None)

print("\n[4] Extraction des paroles Genius (HTML fixture)")
html_fixture = (
    '<html><body><div class="SongPage">'
    '<div data-lyrics-container="true">'
    '<div class="lyrics">First line<br/><a href="/x">Second line</a></div>'
    '<div data-exclude-from-selection="true">Contribuer a Genius</div>'
    '<br/>Third &amp; fourth&apos;s line'
    "</div>"
    '<div data-lyrics-container="true">Verse two</div>'
    "</div></body></html>")
extracted = lyrics._extract_lyrics(html_fixture)
check("les blocs data-lyrics-container sont extraits",
      "First line" in extracted and "Verse two" in extracted, repr(extracted))
check("le bloc data-exclude-from-selection est retire",
      "Contribuer" not in extracted and "Genius" not in extracted)
check("les sauts <br> deviennent des lignes", "First line\n" in extracted)
check("les entites HTML sont decodees",
      "Third & fourth's line" in extracted, repr(extracted))
check("pas de balises residuelles", "<" not in extracted)
check("une page sans bloc ne renvoie rien",
      lyrics._extract_lyrics("<html><p>rien</p></html>") == "")

print("\n[5] Pipeline : trouvaille LRCLIB + cache positif")
_lrclib_calls = _mock_lrclib({"status": "found", "payload": {
    "synced": True, "source": "lrclib", "instrumental": False,
    "title": "CARTIER", "artist": "Gazo",
    "lines": [{"time": 6.89, "text": "Ready, ready, ready"}]}})
_genius_calls = _mock_genius({"status": "miss"})
out = __import__("json").loads(lyrics.get_lyrics(
    "v1" * 11, title="GAZO - CARTIER", channel="Gazo", duration=225.6))
check("paroles trouvees via LRCLIB",
      out["found"] and out["synced"] and out["source"] == "lrclib", str(out))
check("l'enveloppe porte les lignes",
      out["lines"] == [{"time": 6.89, "text": "Ready, ready, ready"}])
second = __import__("json").loads(lyrics.get_lyrics(
    "v1" * 11, title="GAZO - CARTIER", channel="Gazo", duration=225.6))
check("le 2e appel vient du cache (sources non re-appelees)",
      second["found"] and _lrclib_calls["n"] == 1 and _genius_calls["n"] == 0,
      f"lrclib={_lrclib_calls['n']} genius={_genius_calls['n']}")

print("\n[6] Pipeline : repli Genius (texte) quand LRCLIB ne sait pas")
_lrclib_calls = _mock_lrclib({"status": "miss"})
_genius_calls = _mock_genius({"status": "found", "payload": {
    "synced": False, "source": "genius", "instrumental": False,
    "title": "Some Song", "artist": "Some Artist",
    "lines": [{"time": None, "text": "Plain line"}]}})
out = __import__("json").loads(lyrics.get_lyrics(
    "v2" * 11, title="Some Artist - Some Song", channel="Some Artist"))
check("texte brut via Genius",
      out["found"] and not out["synced"] and out["source"] == "genius"
      and out["lines"][0]["time"] is None, str(out))

print("\n[7] Pipeline : aucune source -> cache negatif (duree connue requise)")
_lrclib_calls = _mock_lrclib({"status": "miss"})
_genius_calls = _mock_genius({"status": "miss"})
# Chaine = artiste : un seul candidat, donc 1 appel par source et par passe.
# La duree est connue (de vrai, pas 0) : le miss peut etre cache.
out = __import__("json").loads(lyrics.get_lyrics(
    "v3" * 11, title="Un truc inconnu - abc", channel="Un truc inconnu",
    duration=180))
check("miss propre sans erreur", not out["found"] and out["retryable"] is False,
      str(out))
second = __import__("json").loads(lyrics.get_lyrics(
    "v3" * 11, title="Un truc inconnu - abc", channel="Un truc inconnu",
    duration=180))
check("le miss est cache (aucun appel reseau)",
      _lrclib_calls["n"] == 1 and _genius_calls["n"] == 1,
      f"lrclib={_lrclib_calls['n']} genius={_genius_calls['n']}")
_expire("v3" * 11, days=8)
third = __import__("json").loads(lyrics.get_lyrics(
    "v3" * 11, title="Un truc inconnu - abc", channel="Un truc inconnu",
    duration=180))
check("apres le TTL negatif, les sources sont re-consultees",
      _lrclib_calls["n"] == 2 and _genius_calls["n"] == 2,
      f"lrclib={_lrclib_calls['n']} genius={_genius_calls['n']}")

print("\n[8] Pipeline : panne reseau -> retryable, jamais cachee")
_lrclib_calls = _mock_lrclib({"status": "network_error", "error": "LRCLIB injoignable"})
_genius_calls = _mock_genius({"status": "network_error", "error": "Genius injoignable"})
out = __import__("json").loads(lyrics.get_lyrics(
    "v4" * 11, title="GAZO - CARTIER", channel="Gazo"))
check("panne reseau = retryable", out["retryable"] is True and bool(out["message"]),
      str(out))
check("aucune entree de cache ecrite",
      engine_db.db_lyrics_get("v4" * 11) is None)
second = __import__("json").loads(lyrics.get_lyrics(
    "v4" * 11, title="GAZO - CARTIER", channel="Gazo"))
check("l'utilisateur peut reessayer a chaud (sources re-consultees)",
      _lrclib_calls["n"] == 2 and _genius_calls["n"] == 2,
      f"lrclib={_lrclib_calls['n']} genius={_genius_calls['n']}")

print("\n[9] Pipeline : titre inconnu du serveur -> repli client utilise")
_lrclib_calls = _mock_lrclib({"status": "found", "payload": {
    "synced": True, "source": "lrclib", "instrumental": False,
    "title": "CARTIER", "artist": "Gazo", "lines": [{"time": 1.0, "text": "x"}]}})
_genius_calls = _mock_genius({"status": "miss"})
out = __import__("json").loads(lyrics.get_lyrics(
    "v5" * 11, title="", channel=""))
check("sans titre, repli immediat sans reseau",
      not out["found"] and _lrclib_calls["n"] == 0, str(out))
out = __import__("json").loads(lyrics.get_lyrics(
    "v6" * 11, title="GAZO - CARTIER", channel="Gazo"))
check("titre passe par le client malgre une base vide",
      out["found"] and _lrclib_calls["n"] == 1, str(out))

print("\n[10] Instrumental")
_lrclib_calls = _mock_lrclib({"status": "found", "payload": {
    "synced": False, "source": "lrclib", "instrumental": True,
    "title": "Ocean", "artist": "Ambient", "lines": []}})
_genius_calls = _mock_genius({"status": "miss"})
out = __import__("json").loads(lyrics.get_lyrics(
    "v7" * 11, title="Ocean - Ambient", channel="Ambient"))
check("instrumental expose pour l'UI",
      out["found"] and out["instrumental"] and out["lines"] == [], str(out))

print("\n[11] Endpoint /api/lyrics (TestClient, sources mockees)")
from fastapi import FastAPI
from fastapi.testclient import TestClient
from routers import lyrics as lyrics_router

app = FastAPI()
app.include_router(lyrics_router.router)
client = TestClient(app)

resp = client.get("/api/lyrics", params={"video_id": "abc"})
check("video_id invalide -> 400", resp.status_code == 400, str(resp.status_code))

lyrics_router.LYRICS_ENABLED = False
resp = client.get("/api/lyrics", params={"video_id": "k" * 11})
data = resp.json().get("data", {})
check("paroles desactivees -> repli propre",
      resp.status_code == 200 and data.get("found") is False, str(data))
lyrics_router.LYRICS_ENABLED = True

real = lyrics.get_lyrics
lyrics.get_lyrics = lambda *a, **kw: __import__("json").dumps({
    "found": True, "synced": True, "source": "lrclib", "instrumental": False,
    "title": "CARTIER", "artist": "Gazo", "lines": [{"time": 6.89,
    "text": "Ready, ready, ready"}], "message": None}, ensure_ascii=False)
try:
    resp = client.get("/api/lyrics", params={
        "video_id": "k" * 11, "title": "GAZO - CARTIER", "channel": "Gazo",
        "duration": 225.6})
    data = resp.json().get("data", {})
    check("endpoint OK avec enveloppe standard",
          resp.status_code == 200 and data.get("found") and data["synced"],
          str(resp.json())[:120])
finally:
    lyrics.get_lyrics = real

print("\n[12] Statuts HTTP des sources (403/refus vs vrai miss)")
# Les sections precedentes ont remplace _lrclib/_genius par des fakes :
# on recharge le module pour retrouver les implementations reelles.
import importlib
importlib.reload(lyrics)


def _fake_json(responses):
    """Remplace _get_json par une table {sous-chaine: (data, code)}."""
    def fake(url):
        for needle, payload in responses:
            if needle in url:
                return payload
        return None, 404
    lyrics._get_json = fake


_fake_json([("/api/get?", (None, 404)), ("/api/search", ([], 200))])
res = lyrics._lrclib("A", "B", 180)
check("LRCLIB : 404 exact + recherche vide = miss honnete",
      res["status"] == "miss", str(res))
_fake_json([("/api/search", (None, 429))])
res = lyrics._lrclib("A", "B", 180)
check("LRCLIB : 429 = panne retryable, jamais cachee",
      res["status"] == "network_error", str(res))


def _fake_genius(search_response, page_response):
    lyrics._get_json = lambda url: search_response
    lyrics._request = lambda url: page_response


_fake_genius((None, 403), None)
res = lyrics._genius("A", "B", "chan")
check("Genius : 403 sur la recherche = panne retryable",
      res["status"] == "network_error", str(res))
_fake_genius(({}, 200), None)
res = lyrics._genius("A", "B", "chan")
check("Genius : recherche vide = miss honnete",
      res["status"] == "miss", str(res))
hit = {
    "response": {
        "sections": [
            {
                "type": "song",
                "hits": [
                    {
                        "result": {
                            "url": "https://genius.com/A-b-lyrics",
                            "full_title": "A - B",
                            "primary_artist": {"name": "A"},
                        }
                    }
                ],
            }
        ]
    }
}
lyrics._get_json = lambda url: (hit, 200)
lyrics._request = lambda url: (403, None)
res = lyrics._genius("A", "B", "chan")
check("Genius : page refusee (403) = panne retryable",
      res["status"] == "network_error", str(res))
lyrics._request = lambda url: (404, None)
res = lyrics._genius("A", "B", "chan")
check("Genius : page 404 = miss honnete",
      res["status"] == "miss", str(res))
lyrics._request = lambda url: (200, '<div data-lyrics-container="true">Couplet un<br/>Couplet deux</div>')
res = lyrics._genius("A", "B", "chan")
check("Genius : page 200 = paroles extraites",
      res["status"] == "found" and len(res["payload"]["lines"]) == 2,
      str(res.get("status")))

print("\n[13] Cas live LRCLIB (reseau) — SKIP si offline")
import importlib
importlib.reload(lyrics)
try:
    status, body = lyrics._request(
        "https://lrclib.net/api/search?q=GAZO+CARTIER", timeout=8)
    if status == 200 and "CARTIER" in (body or ""):
        check("LRCLIB repond et trouve GAZO - CARTIER", True)
    else:
        check("LRCLIB repond et trouve GAZO - CARTIER", False, f"status {status}")
except Exception as exc:
    skip("LRCLIB live", str(exc))

print("\n[14] Offset LRC + priorite synced au classement recherche")
importlib.reload(lyrics)

lrc_offset = lyrics._parse_lrc(
    "[offset:+500]\n[00:10.00] Trop tot\n[00:20.00] Suivante\n")
check("offset positif => paroles plus tot (temps -0,5 s)",
      [l["time"] for l in lrc_offset] == [9.5, 19.5], str(lrc_offset))
lrc_offset = lyrics._parse_lrc(
    "[offset:-1000]\n[00:03.00] Trop tard\n[00:20.00] Suivante\n")
check("offset negatif => paroles plus tard (temps +1 s)",
      [l["time"] for l in lrc_offset] == [4.0, 21.0], str(lrc_offset))
lrc_offset = lyrics._parse_lrc(
    "[offset:+4000]\n[00:02.00] Clampe a zero\n")
check("un debut negatif est clampe a 0 (jamais avant le depart)",
      lrc_offset[0]["time"] == 0.0, str(lrc_offset[0]))
check("la balise offset n'est pas une ligne de paroles",
      all(l["text"] != "[offset:+500]" for l in lrc_offset))

# Le synced choisi par la recherche : deux candidats proches mais distincts,
# ecart de duree identique aux yeux de la grille de score (meme palier 0.08),
# seul le bonus synced departage.
plainish = {"trackName": "CARTIER", "artistName": "Gazo", "duration": 200,
            "syncedLyrics": "", "plainLyrics": "Sans temps\nLigne deux"}
synced = {"trackName": "CARTIER", "artistName": "Gazo", "duration": 210,
          "syncedLyrics": "[00:05.00] Ligne\n[00:09.00] Deux", "plainLyrics": ""}
lyrics._get_json = lambda url: ([], 404) if "/api/get?" in url else ([plainish, synced], 200)
res = lyrics._lrclib("GAZO", "CARTIER", 225)
check("candidats proches : le synced est prefere",
      res["status"] == "found" and res["payload"]["synced"]
      and res["payload"]["lines"][0]["time"] == 5.0, str(res))

# Bonus borne : un match parfait hors-sync reste au-dessus du horodate.
perfect = {"trackName": "CARTIER", "artistName": "Gazo", "duration": 225,
           "syncedLyrics": "", "plainLyrics": "Exact\nMatch"}
lyrics._get_json = lambda url: ([], 404) if "/api/get?" in url else ([synced, perfect], 200)
res = lyrics._lrclib("GAZO", "CARTIER", 225)
check("le bonus est borne : un match parfait plain reste prefere",
      res["status"] == "found" and not res["payload"]["synced"]
      and res["payload"]["lines"][0]["text"] == "Exact", str(res))

print("\n[15] Synced prioritaire sur la signature exacte + cache sans duree")
importlib.reload(lyrics)

# (a) La signature exacte ne livre que du texte brut (syncedLyrics vide), comme
# c'etait le cas pour DREAMBOY (Lil Nas X), mais la recherche trouve une version
# horodatee au MEME niveau de confiance : c'est elle qui doit gagner.
lyrics._get_json = lambda url: (
    ({"trackName": "DREAMBOY", "artistName": "Lil Nas X", "duration": 216,
      "syncedLyrics": "", "plainLyrics": "Plain line"}, 200)
    if "/api/get?" in url else
    ([{"trackName": "DREAMBOY", "artistName": "Lil Nas X", "duration": 218,
       "syncedLyrics": "[00:05.00] Ligne\n[00:09.00] Deux", "plainLyrics": ""}], 200))
res = lyrics._lrclib("Lil Nas X", "DREAMBOY", 219)
check("exact plain + recherche synced au meme niveau : le synced prime",
      res["status"] == "found" and res["payload"]["synced"], str(res))

# (b) Match parfait plain = seuil de confiance : une version horodatee
# nettement moins bien scoree ne le bat pas (jamais une version moins sure).
lyrics._get_json = lambda url: (
    ({"trackName": "CARTIER", "artistName": "Gazo", "duration": 225,
      "syncedLyrics": "", "plainLyrics": "Exact"}, 200)
    if "/api/get?" in url else
    ([{"trackName": "CARTIER", "artistName": "Gazo", "duration": 170,
       "syncedLyrics": "[00:05.00] Ligne", "plainLyrics": ""}], 200))
res = lyrics._lrclib("GAZO", "CARTIER", 225)
check("le plain exact parfait reste le seuil (synced moins bon ecarte)",
      res["status"] == "found" and not res["payload"]["synced"]
      and res["payload"]["lines"][0]["text"] == "Exact", str(res))

# (c) Trouve SANS duree connue (mpv charge encore) : servi mais RIEN n'est
# ecrit. Une seconde requete re-consulte donc les sources.
_calls = _mock_lrclib({"status": "found", "payload": {
    "synced": True, "source": "lrclib", "instrumental": False,
    "title": "CARTIER", "artist": "Gazo",
    "lines": [{"time": 6.89, "text": "Ready, ready, ready"}]}})
_mock_genius({"status": "miss"})
out = __import__("json").loads(lyrics.get_lyrics(
    "v81" * 11, title="GAZO - CARTIER", channel="Gazo"))
check("trouve sans duree = servi mais pas cache",
      out["found"] and engine_db.db_lyrics_get("v81" * 11) is None, str(out))
out2 = __import__("json").loads(lyrics.get_lyrics(
    "v81" * 11, title="GAZO - CARTIER", channel="Gazo"))
check("sans cache, l'arrivee de la duree peut reconsulter (sources re-appelees)",
      out2["found"] and _calls["n"] == 2, f"lrclib={_calls['n']}")

# (d) Miss SANS duree : pas de cache negatif non plus, sinon 7 j de blocage
# pour un titre qui pourrait apparaitre une fois la signature arbitree.
_lrclib_calls = _mock_lrclib({"status": "miss"})
_genius_calls = _mock_genius({"status": "miss"})
out = __import__("json").loads(lyrics.get_lyrics(
    "v82" * 11, title="Inconnu - X", channel="X"))
out2 = __import__("json").loads(lyrics.get_lyrics(
    "v82" * 11, title="Inconnu - X", channel="X"))
check("miss sans duree = pas de cache negatif (re-consulte au besoin)",
      not out["found"] and not out2["found"]
      and engine_db.db_lyrics_get("v82" * 11) is None
      and _lrclib_calls["n"] == 2 and _genius_calls["n"] == 2,
      f"lrclib={_lrclib_calls['n']} genius={_genius_calls['n']}")

# (e) Panne reseau : l'UI recoit un message humain retryable, la cause
# technique (ex. « Genius refuse (HTTP 403) ») reste dans les logs [lyrics].
_mock_lrclib({"status": "network_error", "error": "LRCLIB injoignable"})
_mock_genius({"status": "network_error", "error": "Genius refuse (HTTP 403)"})
out = __import__("json").loads(lyrics.get_lyrics(
    "v83" * 11, title="GAZO - CARTIER", channel="Gazo"))
check("panne reseau = retryable, message honnete (pas de code brut)",
      out["retryable"] is True and "HTTP 403" not in (out["message"] or "")
      and "aucune parole" in (out["message"] or "").lower(), str(out["message"]))
check("la panne reseau ne laisse aucune trace en cache",
      engine_db.db_lyrics_get("v83" * 11) is None)

shutil.rmtree(SANDBOX, ignore_errors=True)

failures = CHECKS.count(False)
print(f"\n{len(CHECKS) - failures}/{len(CHECKS)} cas OK"
      + (f", {len(SKIPPED)} ignore(s) : {', '.join(SKIPPED)}" if SKIPPED else ""))
sys.exit(1 if failures else 0)