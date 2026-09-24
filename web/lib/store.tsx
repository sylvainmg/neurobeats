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
  type RatedTrack,
  type UserProfile,
} from "@/lib/api";
import { useRealtime } from "@/lib/realtime";

/**
 * Store unique des données du Profil — et des étoiles ★ de toute l'application.
 *
 * La vérité est côté serveur ; ce store n'en est qu'un miroir, et il se
 * resynchronise dès que le serveur signale un changement :
 *  - `statsRev`   : compteurs et statistiques d'écoute ;
 *  - `profileRev` : une note, un favori, une playlist, l'identité.
 *
 * L'historique d'écoute n'en fait pas partie : le modal de la page Profil le
 * charge lui-même, page par page (offset), pour ne jamais matérialiser tout en
 * mémoire.
 */
interface StoreValue {
  /** Identité, statistiques d'écoute et compteurs du profil. */
  profile: UserProfile | null;
  /** Notes ★ (liste + accès direct par video_id). */
  ratings: RatedTrack[];
  byId: Record<string, number>;
  favorites: string[];
  loading: boolean;
  error: string | null;
  rate: (
    track: { video_id: string; title: string; channel: string },
    rating: number,
  ) => Promise<void>;
  clearRating: (videoId: string) => Promise<void>;
  refresh: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [ratings, setRatings] = useState<RatedTrack[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Numéro de vague : une réponse arrivée après un rechargement plus récent est
  // ignorée (évite qu'une requête lente écrase une donnée fraîche).
  const wave = useRef(0);
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

  /** Recharge les données du profil ; `withRatings` évite de recharger toutes
   * les notes quand seul un changement d'écoute a été signalé. */
  const resync = useCallback(
    async (withRatings: boolean) => {
      const mine = (wave.current += 1);
      await applyProfile(mine);
      if (withRatings) await applyRatings(mine);
      if (mine === wave.current) setLoading(false);
    },
    [applyProfile, applyRatings],
  );

  const refresh = useCallback(() => resync(true), [resync]);
  /** Rechargement ciblé : profil (identité, stats, compteurs), sans recharger
   * toutes les notes quand elles ne sont pas concernées. */
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
      loading,
      error,
      rate,
      clearRating,
      refresh,
      refreshProfile,
    }),
    [
      profile,
      ratings,
      byId,
      favorites,
      loading,
      error,
      rate,
      clearRating,
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
