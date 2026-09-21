"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  api,
  ApiError,
  type NowPlayingState,
  type RepeatMode,
} from "@/lib/api";
import { useRealtime } from "@/lib/realtime";

interface PlayerContextValue {
  state: NowPlayingState | null;
  loading: boolean;
  error: string | null;
  play: (videoId: string) => Promise<void>;
  playNow: (query: string) => Promise<void>;
  stop: () => Promise<void>;
  skip: () => Promise<void>;
  previous: () => Promise<void>;
  jump: (index: number) => Promise<void>;
  togglePause: () => Promise<void>;
  seek: (position: number) => Promise<void>;
  setVolume: (volume: number) => Promise<void>;
  setShuffle: (shuffle: boolean) => Promise<void>;
  setRepeat: (mode: RepeatMode) => Promise<void>;
  refresh: () => Promise<void>;
}

const PlayerContext = createContext<PlayerContextValue | null>(null);

/** Types d'`<input>` ou l'espace ne saisit rien : il doit y garder son effet natif. */
const NON_TEXT_INPUTS = new Set([
  "button", "checkbox", "radio", "range", "file", "submit", "reset", "color",
]);

/**
 * True si la frappe a lieu dans un champ de saisie.
 *
 * C'est la seule exception au raccourci : ailleurs, l'espace doit basculer la
 * lecture, mais dans un champ il doit rester un espace (sinon impossible de
 * taper une phrase).
 */
function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    return !NON_TEXT_INPUTS.has((el as HTMLInputElement).type);
  }
  return false;
}

/** Fournit l'état de lecture global (titre courant, position) et les actions. */
export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const [restState, setRestState] = useState<NowPlayingState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { now, connected } = useRealtime();
  // Source principale : l'etat pousse par le WebSocket. Repli REST sinon.
  const state = connected && now ? now : restState;

  const refresh = useCallback(async () => {
    try {
      setRestState(await api.now());
    } catch {
      // silencieux : le polling ne doit pas polluer l'UI
    }
  }, []);

  const run = useCallback(
    async (fn: () => Promise<NowPlayingState | unknown>) => {
      setLoading(true);
      setError(null);
      try {
        await fn();
        await refresh();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Erreur inattendue");
      } finally {
        setLoading(false);
      }
    },
    [refresh],
  );

  const play = useCallback(
    (videoId: string) => run(() => api.play(videoId)),
    [run],
  );
  const playNow = useCallback(
    (query: string) => run(() => api.playNow(query)),
    [run],
  );
  // `streamStop` (et non `/api/stop`) : coupe le flux infini en plus de mpv, sinon
  // la boucle de streaming enchaîne le titre suivant juste après.
  const stop = useCallback(() => run(() => api.streamStop()), [run]);
  // Pas de `run()` ici : bloquer l'UI le temps de l'action empecherait un
  // "Suivant" repete. Le moteur bascule en ~100ms, donc on relit l'etat juste
  // apres au lieu d'attendre le polling 1s.
  //
  // L'echec n'est plus avale : un "Suivant" qui ne fait rien en silence etait
  // indiscernable d'un bouton casse. Si la file se construit encore cote serveur
  // (`queue_filling`), on rejoue le clic une seule fois jusqu'a ce qu'un titre
  // soit pret — c'est la suite de l'action de l'utilisateur, pas une lecture qui
  // s'invite.
  const skipRetrying = useRef(false);
  const skip = useCallback(async () => {
    let res: { status?: string } | null = null;
    try {
      res = await api.streamSkip();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Impossible de passer au titre suivant",
      );
      return;
    }
    window.setTimeout(() => void refresh(), 200);
    if (res?.status !== "queue_filling" || skipRetrying.current) return;
    skipRetrying.current = true;
    const deadline = Date.now() + 15000;
    try {
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 800));
        const again = await api.streamSkip();
        if (again?.status !== "queue_filling") {
          window.setTimeout(() => void refresh(), 200);
          break;
        }
      }
    } catch {
      // Le premier clic a deja ete traite : on s'arrete sans bruit ici, l'erreur
      // durable remonterait a la prochaine action.
    } finally {
      skipRetrying.current = false;
    }
  }, [refresh]);
  // "Previous" : rejoue le titre precedent (ou revient au debut du courant).
  // Meme UX que `skip` : pas de blocage, relecture rapide.
  const previous = useCallback(async () => {
    try {
      await api.streamPrevious();
    } catch {
      return;
    }
    window.setTimeout(() => void refresh(), 300);
  }, [refresh]);
  // Saut direct a une position de la file : le titre est lance par le moteur,
  // puis le flux reprend avec la file restante.
  const jump = useCallback(async (index: number) => {
    try {
      await api.streamJump(index);
    } catch {
      return;
    }
    window.setTimeout(() => void refresh(), 300);
  }, [refresh]);
  const togglePause = useCallback(() => run(() => api.pause()), [run]);
  const seek = useCallback(
    (position: number) => run(() => api.seek(position)),
    [run],
  );
  const setVolume = useCallback(async (volume: number) => {
    try {
      await api.volume(volume);
    } catch {
      // silencieux : le volume ne doit pas bloquer l'UI
    }
  }, []);
  const setShuffle = useCallback(async (shuffle: boolean) => {
    try {
      await api.setShuffle(shuffle);
    } catch {
      // silencieux : l'état réel est resynchronisé par le polling de /api/now
    }
  }, []);
  const setRepeat = useCallback(async (mode: RepeatMode) => {
    try {
      await api.setRepeat(mode);
    } catch {
      // silencieux : l'état réel est resynchronisé par le polling de /api/now
    }
  }, []);

  // Chargement initial : récupère l'état courant même sans action utilisateur
  // (sinon "Aucune lecture" après un rechargement pendant la lecture).
  useEffect(() => {
    const id = window.setTimeout(refresh, 0);
    return () => window.clearTimeout(id);
  }, [refresh]);

  // Repli REST uniquement si la connexion temps réel est absente (polling lent).
  useEffect(() => {
    if (connected || !state?.playing) return;
    const id = window.setInterval(refresh, 2000);
    return () => window.clearInterval(id);
  }, [connected, state?.playing, refresh]);

  // Les erreurs sont transitoires : elles s'effacent d'elles-memes, sinon un
  // message reste affiche jusqu'a la prochaine action de l'utilisateur.
  useEffect(() => {
    if (!error) return;
    const id = window.setTimeout(() => setError(null), 6000);
    return () => window.clearTimeout(id);
  }, [error]);

  // Espace = lecture/pause, comme dans les lecteurs web. `preventDefault` est
  // indispensable : sans lui, un bouton resté focus (après un clic) serait
  // activé en plus du raccourci, soit deux actions pour une frappe.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.code !== "Space" && event.key !== " ") return;
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTextEntry(event.target)) return;
      event.preventDefault();
      void togglePause();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [togglePause]);

  return (
    <PlayerContext.Provider
      value={{
        state,
        loading,
        error,
        play,
        playNow,
        stop,
        skip,
        previous,
        jump,
        togglePause,
        seek,
        setVolume,
        setShuffle,
        setRepeat,
        refresh,
      }}
    >
      {children}
    </PlayerContext.Provider>
  );
}

/** Accès au contexte de lecture. */
export function usePlayer() {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error("usePlayer doit être utilisé dans PlayerProvider");
  return ctx;
}
