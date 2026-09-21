"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

import { api, type Playlist, type PlaylistSummary } from "@/lib/api";
import { useRealtime } from "@/lib/realtime";

/**
 * Store des playlists partagé par toute l'application.
 *
 * Il détient les **résumés** (bibliothèque, barre latérale) ET un **cache des
 * playlists complètes** (titres inclus), pour qu'une même playlist soit rendue à
 * l'identique partout et se mette à jour partout dès qu'elle change.
 *
 * Synchronisation avec le réel :
 * - toute mutation écrit la playlist renvoyée par le serveur dans le cache ;
 * - la révision poussée par le WebSocket (`playlistsRev`) déclenche un
 *   rafraîchissement dès qu'une playlist change — y compris quand c'est
 *   l'assistant IA qui l'a modifiée ;
 * - le cache de détail est **invalidé par témoin** : si l'`updated` du résumé ne
 *   correspond plus à celui du détail, le détail est périmé.
 */
interface PlaylistsValue {
  playlists: PlaylistSummary[];
  loading: boolean;
  error: string | null;
  /** Playlist complète en cache (null si absente ou périmée). */
  playlist: (id: string) => Playlist | null;
  /** Charge (ou recharge) le détail d'une playlist. */
  loadPlaylist: (id: string) => Promise<Playlist | null>;
  /** Recharge les résumés ; `videoId` ajoute `contains` (déjà présente ?). */
  refresh: (videoId?: string) => Promise<void>;
  createPlaylist: (name: string, mood?: string) => Promise<Playlist | null>;
  renamePlaylist: (id: string, name: string) => Promise<void>;
  deletePlaylist: (id: string) => Promise<void>;
  addTrack: (id: string, videoId: string) => Promise<{ status: string }>;
  removeTrack: (id: string, videoId: string) => Promise<void>;
}

const PlaylistsContext = createContext<PlaylistsValue | null>(null);

function toSummary(playlist: Playlist): PlaylistSummary {
  return {
    id: playlist.id,
    name: playlist.name,
    mood: playlist.mood ?? "",
    count: playlist.songs?.length ?? 0,
    cover: playlist.songs?.[0]?.video_id ?? "",
    created: playlist.created,
    updated: playlist.updated,
  };
}

export function PlaylistsProvider({ children }: { children: ReactNode }) {
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [details, setDetails] = useState<Record<string, Playlist>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** video_id pour lequel `contains` a été calculé ("" = non calculé). */
  const containmentFor = useRef("");
  /** Dernière révision serveur vue. */
  const seenRev = useRef(0);
  const { playlistsRev } = useRealtime();

  const applySummaries = useCallback((list: PlaylistSummary[]) => {
    setPlaylists(list);
    setError(null);
    setLoading(false);
  }, []);

  const failWith = useCallback((err: unknown) => {
    setError(err instanceof Error ? err.message : "Bibliothèque indisponible.");
    setLoading(false);
  }, []);

  /** Écrit une playlist renvoyée par le serveur dans le cache + les résumés. */
  const putPlaylist = useCallback((playlist: Playlist, contains?: boolean) => {
    setDetails((prev) => ({ ...prev, [playlist.id]: playlist }));
    setSummariesAndMerge(setPlaylists, playlist, contains);
  }, []);

  const refresh = useCallback(
    async (videoId?: string) => {
      try {
        const data = await api.listPlaylists(videoId);
        if (videoId) containmentFor.current = videoId;
        applySummaries(data.playlists ?? []);
      } catch (err) {
        failWith(err);
      }
    },
    [applySummaries, failWith],
  );

  /** Charge le détail ; laisse remonter les erreurs (404 géré par l'appelant). */
  const loadPlaylist = useCallback(
    async (id: string) => {
      const data = await api.getPlaylist(id);
      putPlaylist(data.playlist);
      return data.playlist;
    },
    [putPlaylist],
  );

  /** Playlist complète, seulement si le cache correspond à la révision du résumé. */
  const playlist = useCallback(
    (id: string): Playlist | null => {
      const detail = details[id];
      if (!detail) return null;
      const summary = playlists.find((s) => s.id === id);
      if (summary && summary.updated !== detail.updated) return null; // périmé
      return detail;
    },
    [details, playlists],
  );

  // Chargement initial.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const data = await api.listPlaylists();
        if (active) applySummaries(data.playlists ?? []);
      } catch (err) {
        if (active) failWith(err);
      }
    })();
    return () => {
      active = false;
    };
  }, [applySummaries, failWith]);

  // Resynchronisation pilotée par le serveur : la révision change dès qu'une
  // playlist est modifiée (UI, assistant IA, autre onglet).
  useEffect(() => {
    if (playlistsRev === seenRev.current) return;
    seenRev.current = playlistsRev;
    void (async () => {
      await refresh(containmentFor.current || undefined);
    })();
  }, [playlistsRev, refresh]);

  // Filet de sécurité si le WebSocket est indisponible.
  useEffect(() => {
    function onFocus() {
      void (async () => {
        await refresh(containmentFor.current || undefined);
      })();
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const createPlaylist = useCallback(
    async (name: string, mood?: string) => {
      const result = await api.createPlaylist({ name, mood: mood ?? "" });
      const created = result.playlist ?? null;
      if (created) putPlaylist(created, false);
      return created;
    },
    [putPlaylist],
  );

  const renamePlaylist = useCallback(
    async (id: string, name: string) => {
      const result = await api.renamePlaylist(id, name);
      if (result.playlist) putPlaylist(result.playlist);
    },
    [putPlaylist],
  );

  const deletePlaylist = useCallback(async (id: string) => {
    await api.deletePlaylist(id);
    setDetails((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setPlaylists((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const addTrack = useCallback(
    async (id: string, videoId: string) => {
      const result = await api.addPlaylistTrack(id, videoId);
      // La playlist renvoyée fait foi : plus de divergence avec le serveur.
      if (result.playlist) putPlaylist(result.playlist, true);
      return { status: result.status };
    },
    [putPlaylist],
  );

  const removeTrack = useCallback(
    async (id: string, videoId: string) => {
      const result = await api.removePlaylistTrack(id, videoId);
      if (result.playlist) {
        const known = containmentFor.current === videoId;
        putPlaylist(result.playlist, known ? false : undefined);
      }
    },
    [putPlaylist],
  );

  const value = useMemo(
    () => ({
      playlists,
      loading,
      error,
      playlist,
      loadPlaylist,
      refresh,
      createPlaylist,
      renamePlaylist,
      deletePlaylist,
      addTrack,
      removeTrack,
    }),
    [
      playlists, loading, error, playlist, loadPlaylist, refresh,
      createPlaylist, renamePlaylist, deletePlaylist, addTrack, removeTrack,
    ],
  );

  return <PlaylistsContext.Provider value={value}>{children}</PlaylistsContext.Provider>;
}

/** Upsert du résumé d'une playlist sans perdre `contains` s'il n'est pas fourni. */
function setSummariesAndMerge(
  setPlaylists: Dispatch<SetStateAction<PlaylistSummary[]>>,
  playlist: Playlist,
  contains?: boolean,
) {
  setPlaylists((prev) => {
    const summary: PlaylistSummary = {
      ...toSummary(playlist),
      ...(contains === undefined ? {} : { contains }),
    };
    const index = prev.findIndex((s) => s.id === playlist.id);
    if (index === -1) return [summary, ...prev];
    const next = [...prev];
    next[index] = { ...prev[index], ...summary };
    return next;
  });
}

export function usePlaylists(): PlaylistsValue {
  const context = useContext(PlaylistsContext);
  if (!context) throw new Error("usePlaylists doit être utilisé dans un PlaylistsProvider");
  return context;
}
