"use client";

import { useCallback, useEffect, useState } from "react";

import { api, type PlaylistLocal } from "@/lib/api";

/**
 * Téléchargement local d'une playlist : ce que le poste garde sur son disque.
 *
 * L'API est répartie en deux gestes distincts, et c'est volontaire :
 *
 * - `reload()` ne demande **rien**, il lit ce qui est déjà là. Ouvrir une
 *   playlist ne doit jamais déclencher un téléchargement ;
 * - `download()` lance les titres manquants, et relance l polled qui suit.
 *
 * Le polled tourne tant qu'il reste des titres absents : les fichiers arrivent en
 * arrière-plan, en quelques secondes chacun, et l'utilisateur doit voir la
 * pastille « sur cet appareil » se poser titre après titre — c'est ce qui
 * distingue un téléchargement en cours d'un échec.
 */
const POLL_MS = 2000;

export function usePlaylistLocal(playlistId: string | null) {
  const [local, setLocal] = useState<PlaylistLocal | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!playlistId) return null;
    try {
      const data = await api.playlistLocal(playlistId);
      setLocal(data);
      return data;
    } catch (err) {
      // L'endpoint est un bonus (économise un réemploi) : son absence ne doit
      // pas casser la lecture de la playlist. On se contente de ne rien afficher.
      setError(err instanceof Error ? err.message : null);
      return null;
    }
  }, [playlistId]);

  // Lecture initiale + polled tant qu'il manque des titres. Le polled s'arrête
  // dès que tout est là : inutile de sonder le disque pour une liste complète.
  useEffect(() => {
    if (!playlistId) return;
    let active = true;
    let timer: number | null = null;

    const tick = async () => {
      const data = await reload();
      if (!active) return;
      if (data && data.manquant > 0) timer = window.setTimeout(tick, POLL_MS);
    };
    void tick();

    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [playlistId, reload]);

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
        // Le polled repart tout seul s'il manque encore des titres.
        await reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Téléchargement impossible.");
      } finally {
        setDownloading(false);
      }
    },
    [playlistId, reload],
  );

  /** Un titre précis est-il sur le disque ? */
  const estPret = useCallback(
    (videoId: string) => local?.details.find((d) => d.video_id === videoId)?.etat === "pret",
    [local],
  );

  return { local, downloading, error, reload, download, estPret };
}
