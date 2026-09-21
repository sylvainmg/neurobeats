"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  api,
  type HistoryEntry,
  type RatedTrack,
  type UserProfile,
} from "@/lib/api";
import { useRealtime } from "@/lib/realtime";

const HISTORY_PAGE = 60;
const HISTORY_MAX = 500; // plafond de l'API /api/profile/history

/**
 * Store unique des données du Profil — et des étoiles ★ de toute l'application.
 *
 * La vérité est côté serveur ; ce store n'en est qu'un miroir, et il se
 * resynchronise dès que le serveur signale un changement :
 *  - `statsRev`   : une écoute (historique + compteurs) ;
 *  - `profileRev` : une note, un favori, une playlist, l'identité.
 *
 * Conséquence : une action faite ailleurs (assistant, autre onglet, autre
 * appareil) se répercute ici sans rechargement. Aucun composant ne garde sa
 * propre copie : tout lit et écrit via ce store, sinon l'affichage peut mentir.
 * La reconnexion du WebSocket suffit à rattraper les événements manqués, le
 * snapshot renvoyant les révisions courantes.
 */
interface StoreValue {
  /** Identité, statistiques d'écoute et compteurs du profil. */
  profile: UserProfile | null;
  /** Notes ★ (liste + accès direct par video_id). */
  ratings: RatedTrack[];
  byId: Record<string, number>;
  favorites: string[];
  history: HistoryEntry[];
  historyLimit: number;
  loading: boolean;
  error: string | null;
  rate: (
    track: { video_id: string; title: string; channel: string },
    rating: number,
  ) => Promise<void>;
  clearRating: (videoId: string) => Promise<void>;
  ensureHistory: () => Promise<void>;
  loadMoreHistory: () => Promise<void>;
  resetHistory: () => Promise<void>;
  refresh: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [ratings, setRatings] = useState<RatedTrack[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Numéro de vague : une réponse arrivée après un rechargement plus récent est
  // ignorée (évite qu'une requête lente écrase une donnée fraîche).
  const wave = useRef(0);
  const limitRef = useRef(HISTORY_PAGE);
  const historyLoaded = useRef(false);
  const { statsRev, profileRev } = useRealtime();

  const applyProfile = useCallback(async (mine: number) => {
    try {
      const [data, favs] = await Promise.all([
        api.getProfile(),
        api.listFavorites(),
      ]);
      if (mine !== wave.current) return;
      setProfile(data);
      setFavorites(favs.favorites ?? []);
      setError(null);
    } catch (err) {
      if (mine === wave.current) {
        setError(err instanceof Error ? err.message : "Profil indisponible.");
      }
    }
  }, []);

  const applyRatings = useCallback(async (mine: number) => {
    try {
      const data = await api.listPreferences();
      if (mine !== wave.current) return;
      setRatings(data.ratings ?? []);
    } catch {
      // Réseau indisponible : on garde ce qui est affiché.
    }
  }, []);

  const applyHistory = useCallback(async (mine: number) => {
    try {
      const data = await api.profileHistory(limitRef.current);
      if (mine !== wave.current) return;
      setHistory(data.entries ?? []);
    } catch {
      // Réseau indisponible : on garde ce qui est affiché.
    }
  }, []);

  /** Recharge les données du profil ; `withRatings` évite de recharger toutes
   * les notes quand seul un changement d'écoute a été signalé. */
  const resync = useCallback(
    async (withRatings: boolean) => {
      const mine = (wave.current += 1);
      await applyProfile(mine);
      if (withRatings) await applyRatings(mine);
      if (historyLoaded.current) await applyHistory(mine);
      if (mine === wave.current) setLoading(false);
    },
    [applyProfile, applyRatings, applyHistory],
  );

  const refresh = useCallback(() => resync(true), [resync]);
  /** Rechargement ciblé : profil (identité, stats, compteurs) + historique, sans
   * recharger toutes les notes quand elles ne sont pas concernées. */
  const refreshProfile = useCallback(() => resync(false), [resync]);

  // Chargement initial.
  useEffect(() => {
    let active = true;
    void (async () => {
      await refresh();
      if (!active) return;
    })();
    return () => {
      active = false;
    };
  }, [refresh]);

  // Resynchronisation sur révision serveur.
  const seenStats = useRef(statsRev);
  const seenProfile = useRef(profileRev);
  useEffect(() => {
    const statsChanged = seenStats.current !== statsRev;
    const profileChanged = seenProfile.current !== profileRev;
    seenStats.current = statsRev;
    seenProfile.current = profileRev;
    if (!statsChanged && !profileChanged) return;
    let active = true;
    void (async () => {
      await resync(profileChanged || !statsChanged);
      if (!active) return;
    })();
    return () => {
      active = false;
    };
  }, [statsRev, profileRev, resync]);

  const rate = useCallback(
    async (
      track: { video_id: string; title: string; channel: string },
      rating: number,
    ) => {
      // Optimiste : l'étoile réagit tout de suite, le serveur fait foi ensuite.
      setRatings((prev) => [
        { ...track, rating },
        ...prev.filter((r) => r.video_id !== track.video_id),
      ]);
      try {
        await api.setPreference(track.video_id, rating);
      } finally {
        await resync(true);
      }
    },
    [resync],
  );

  const clearRating = useCallback(
    async (videoId: string) => {
      setRatings((prev) => prev.filter((r) => r.video_id !== videoId));
      try {
        await api.deletePreference(videoId);
      } finally {
        await resync(true);
      }
    },
    [resync],
  );

  const ensureHistory = useCallback(async () => {
    if (historyLoaded.current) return;
    historyLoaded.current = true;
    await applyHistory(wave.current);
  }, [applyHistory]);

  const loadMoreHistory = useCallback(async () => {
    const next = Math.min(limitRef.current + HISTORY_PAGE, HISTORY_MAX);
    if (next === limitRef.current) return;
    limitRef.current = next;
    setHistoryLimit(next);
    historyLoaded.current = true;
    await applyHistory(wave.current);
  }, [applyHistory]);

  const resetHistory = useCallback(async () => {
    limitRef.current = HISTORY_PAGE;
    setHistoryLimit(HISTORY_PAGE);
    historyLoaded.current = true;
    await applyHistory(wave.current);
  }, [applyHistory]);

  const byId = useMemo(() => {
    const map: Record<string, number> = {};
    for (const rated of ratings) map[rated.video_id] = rated.rating;
    return map;
  }, [ratings]);

  const value = useMemo(
    () => ({
      profile,
      ratings,
      byId,
      favorites,
      history,
      historyLimit,
      loading,
      error,
      rate,
      clearRating,
      ensureHistory,
      loadMoreHistory,
      resetHistory,
      refresh,
      refreshProfile,
    }),
    [
      profile,
      ratings,
      byId,
      favorites,
      history,
      historyLimit,
      loading,
      error,
      rate,
      clearRating,
      ensureHistory,
      loadMoreHistory,
      resetHistory,
      refresh,
      refreshProfile,
    ],
  );

  return (
    <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
  );
}

/** Données du profil et notes ★, depuis la source unique. */
export function useStore(): StoreValue {
  const context = useContext(StoreContext);
  if (!context) {
    throw new Error("useStore doit être utilisé dans un StoreProvider");
  }
  return context;
}
