"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { api, type PlaylistLocal } from "@/lib/api";
import { useRealtime } from "@/lib/realtime";

/**
 * Téléchargement local d'une playlist : ce que le poste garde sur son disque.
 *
 * L'API est répartie en deux gestes distincts, et c'est volontaire :
 *
 * - `reload()` ne demande **rien**, il lit ce qui est déjà là. Ouvrir une
 *   playlist ne doit jamais déclencher un téléchargement ;
 * - `download()` lance les titres manquants, et relance la surveillance.
 *
 * ## Pourquoi la surveillance ne s'arrête jamais d'elle-même
 *
 * Deux événements peuvent ajouter un titre à télécharger, et aucun des deux ne
 * passe par ce hook :
 *
 * 1. **le téléchargement en cours** : les fichiers arrivent en quelques
 *    secondes, et l'utilisateur doit voir la pastille « sur cet appareil » se
 *    poser titre après titre ;
 * 2. **la playlist elle-même** : l'utilisateur peut ajouter un titre à la
 *    playlist sans quitter la page (bouton d'ajout, assistant IA, autre onglet
 *    via le WebSocket).
 *
 * Surveiller « tant qu'il manque des titres » paraît suffire, mais ça rate les
 * deux cas : au clic, le serveur n'a rien téléchargé d'inutilisable, donc le
 * compteur est encore à zéro et la surveillance s'éteint — le bouton reste
 * alors figé jusqu'au prochain clic. C'est ce double-clic que l'utilisateur
 * voit.
 *
 * On surveille donc en continu, à intervalle court, tant que le composant vit.
 * Un GET de quelques centaines d'octets toutes les 2 s sur un poste local ne
 * coûte rien, et c'est le seul moyen d'être juste : l'UI ne devine jamais, elle
 * relit la source de vérité.
 */
const POLL_MS = 2000;

export function usePlaylistLocal(playlistId: string | null) {
  const [local, setLocal] = useState<PlaylistLocal | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // `playlistsRev` change dès qu'une playlist est modifiée (UI, assistant IA,
  // autre onglet) : c'est le signal qui couvre le cas 2 ci-dessus. Le
  // compiler de dépendances le fait resynchroniser dans la foulée, donc la
  // pastille et le bouton suivent l'ajout sans que l'utilisateur refresh.
  const { playlistsRev } = useRealtime();
  const vuRev = useRef(playlistsRev);

  const reload = useCallback(async () => {
    if (!playlistId) return null;
    try {
      const data = await api.playlistLocal(playlistId);
      setLocal(data);
      return data;
    } catch (err) {
      // L'endpoint est un bonus : son absence ne doit pas casser la lecture de
      // la playlist. On se contente de ne rien afficher plutôt que d'afficher
      // une erreur que l'utilisateur ne peut pas agir.
      setError(err instanceof Error ? err.message : null);
      return null;
    }
  }, [playlistId]);

  // Surveillance continue : elle se relance sur chaque tick, et le timer est
  // unique (clearTimeout au cleanup) — pas d'empilement si le composant
  // remonte.
  useEffect(() => {
    if (!playlistId) return;
    let active = true;
    let timer: number | null = null;

    const tick = async () => {
      if (!active) return;
      await reload();
      if (!active) return;
      timer = window.setTimeout(tick, POLL_MS);
    };
    void tick();

    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [playlistId, reload]);

  // Un titre ajouté à la playlist change le compte de « à télécharger ». On
  // relit tout de suite, plutôt que d'attendre le tick suivant : l'utilisateur
  // vient d'ajouter, il veut voir le bouton passer à « Compléter » tout de
  // suite.
  useEffect(() => {
    if (playlistsRev === vuRev.current) return;
    vuRev.current = playlistsRev;
    void reload();
  }, [playlistsRev, reload]);

  const download = useCallback(
    async (videoIds: string[] = []) => {
      if (!playlistId) return;
      setDownloading(true);
      setError(null);
      try {
        const res = await api.downloadPlaylistLocal(playlistId, videoIds);
        // Le message ne parle que de ce qui vient d'être demandé : les titres
        // déjà présents ne sont pas comptés, sinon l'interface dirait « 0
        // téléchargé » alors que tout est là.
        setError(
          res.demandes === 0 && res.echecs === 0
            ? null
            : res.echecs > 0
              ? `${res.echecs} titre(s) n'ont pas pu être téléchargés.`
              : null,
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Téléchargement impossible.");
      } finally {
        setDownloading(false);
        // La surveillance permanente relit dans 2 s : pas besoin d'un reload
        // ici, qui arriverait avant que le serveur ait quoi que ce soit à
        // dire sur un titre qu'il vient de commencer à télécharger.
      }
    },
    [playlistId],
  );

  /** Un titre précis est-il sur le disque ? */
  const estPret = useCallback(
    (videoId: string) => local?.details.find((d) => d.video_id === videoId)?.etat === "pret",
    [local],
  );

  return { local, downloading, error, reload, download, estPret };
}
