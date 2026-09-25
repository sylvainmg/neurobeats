"""Vérification du service de téléchargement local (hors app)."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services import localdownload, playlists, state  # noqa: E402

# Métadonnées connues : LAST_SEARCH est la source de vérité du moteur.
for i, vid in enumerate(("aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc")):
    state.LAST_SEARCH[vid] = {
        "video_id": vid, "title": f"Titre {i + 1}",
        "channel": "Artiste", "duration": 180,
    }

pid = json.loads(playlists.create_empty_playlist("PL test"))["playlist"]["id"]
for vid in ("aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"):
    playlists.add_track(pid, vid)

etats = json.loads(localdownload.etats(pid))
print("etats   ->", {k: etats[k] for k in ("playlist", "titres", "pret", "manquant", "octets")})
print("details ->", [d["etat"] for d in etats["details"]])

print("telech  ->", json.loads(localdownload.telecharger(pid)))
print("apres   ->", {k: json.loads(localdownload.etats(pid))[k] for k in ("pret", "manquant")})

# Retirer un titre : le disque est purgé seulement s'il n'est plus ailleurs.
retire = json.loads(playlists.remove_track(pid, "aaaaaaaaaaa"))
print("retrait ->", {k: retire.get(k) for k in ("status", "audio_supprime")})
print("après   ->", {k: json.loads(localdownload.etats(pid))[k] for k in ("titres", "manquant")})

# Une playlist inconnue doit renvoyer l'erreur, pas un vide silencieux.
print("inconnu ->", json.loads(localdownload.etats("nope")))
print("telech? ->", json.loads(localdownload.telecharger("nope")))
