"""Téléchargement local d'une playlist : ce que le bureau garde sur son disque.

Le cache audio existe déjà pour le transfert vers le téléphone
(`services.preparation`) : on ne le duplique pas, on l'expose simplement comme
une liste consultable par l'interface. Un titre « téléchargé » est un titre dont
le fichier est sur le disque du poste — donc écoutable sans réseau, contrairement
à un titre simplement connu par son `video_id`.

Deux services se répondent :

- `etats()` : l'état de chaque titre d'une playlist, pour afficher ce qui est
  déjà là, ce qui se télécharge, et ce qui reste à faire ;
- `telecharger()` : demande le téléchargement des titres manquants d'un coup.

Le téléchargement passe toujours par `preparation.demander` : c'est le même pool
de workers et les mêmes plafonds d'échec que le transfert, donc un titre déjà
préparé n'est jamais retéléchargé et une source morte ne boucle pas.
"""
import json

from services.db_access import _meta
from services.state import _tprint
from services import preparation


def etats(playlist_id: str) -> str:
    """État de téléchargement de chaque titre d'une playlist.

    Réponse : `{playlist, titres: N, pret: N, en_cours: N, manquant: N,
    octets: N, details: [{video_id, etat, taille, duree, format}]}`.

    Les états sont lus sans rien déclencher : consulter une playlist ne doit
    pas lancer un téléchargement. C'est `POST /telecharger` qui le demande.
    """
    from services.playlists import get_playlist

    trouve = json.loads(get_playlist(playlist_id))
    if trouve.get("error"):
        return json.dumps(trouve, ensure_ascii=False)
    # `get_playlist` enveloppe sous « playlist » : on travaille sur la fiche, pas
    # sur l'enveloppe d'API.
    playlist = trouve.get("playlist") or {}
    songs = [s for s in playlist.get("songs", []) if s.get("video_id")]

    details = []
    for song in songs:
        video_id = song["video_id"]
        pret = preparation.chemin(video_id)
        details.append({
            "video_id": video_id,
            "etat": "pret" if pret else "absent",
            "taille": (preparation.taille(video_id) or 0) if pret else 0,
            "duree": (preparation.duree(video_id) or 0) if pret else 0,
            "format": preparation.format_de(video_id) if pret else "",
        })

    pret = sum(1 for d in details if d["etat"] == "pret")
    return json.dumps({
        "playlist": playlist.get("name", playlist_id),
        "playlist_id": playlist_id,
        "titres": len(details),
        "pret": pret,
        "manquant": len(details) - pret,
        "octets": sum(d["taille"] for d in details if d["etat"] == "pret"),
        "details": details,
    }, ensure_ascii=False)


def telecharger(playlist_id: str, video_ids: list | None = None) -> str:
    """Demande le téléchargement des titres manquants d'une playlist.

    Les titres déjà sur le disque ne sont pas relancés : l'utilisateur peut
    re-cliquer sur « Télécharger » autant de fois qu'il veut sans jamais
    payer deux fois le même titre.

    Args:
        playlist_id: Id ou nom de la playlist.
        video_ids: Titres ciblés. Vide ou absent = toute la playlist.

    Returns:
        `{playlist, demandes: N, deja_pret: N, echecs: N}`.
    """
    from services.playlists import get_playlist

    trouve = json.loads(get_playlist(playlist_id))
    if trouve.get("error"):
        return json.dumps(trouve, ensure_ascii=False)
    # `get_playlist` enveloppe sous « playlist » (cf. `etats`).
    playlist = trouve.get("playlist") or {}
    songs = [s for s in playlist.get("songs", []) if s.get("video_id")]

    cibles = set(video_ids or [])
    if cibles:
        songs = [s for s in songs if s["video_id"] in cibles]
    if not songs:
        return json.dumps({"error": "Aucun titre à télécharger."}, ensure_ascii=False)

    demandes = 0
    deja_pret = 0
    echecs = 0
    for song in songs:
        video_id = song["video_id"]
        if preparation.chemin(video_id):
            deja_pret += 1
            continue
        meta = _meta(video_id) or {
            "video_id": video_id,
            "title": song.get("title", ""),
            "channel": song.get("channel", ""),
        }
        etat = preparation.demander(video_id, meta)
        if etat == "erreur":
            echecs += 1
        else:
            demandes += 1

    _tprint(f"[local] playlist « {playlist.get('name', playlist_id)} » : "
            f"{demandes} demande(s), {deja_pret} deja pret(s), {echecs} refus(s)")
    return json.dumps({
        "status": "ok",
        "playlist": playlist.get("name", playlist_id),
        "demandes": demandes,
        "deja_pret": deja_pret,
        "echecs": echecs,
    }, ensure_ascii=False)
