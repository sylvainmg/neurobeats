"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Coordination des surfaces flottantes : panneaux latéraux droits (assistant,
 * file de lecture) et grand panneau paroles. Ils couvrent le même espace au
 *-dessus de la barre du lecteur : ouvrir l'un ferme les autres.
 */
interface OverlaysValue {
  chatOpen: boolean;
  queueOpen: boolean;
  lyricsOpen: boolean;
  setChatOpen: (open: boolean) => void;
  setQueueOpen: (open: boolean) => void;
  setLyricsOpen: (open: boolean) => void;
}

const OverlaysContext = createContext<OverlaysValue | null>(null);

export function OverlaysProvider({ children }: { children: ReactNode }) {
  const [chatOpen, setChatOpenState] = useState(false);
  const [queueOpen, setQueueOpenState] = useState(false);
  const [lyricsOpen, setLyricsOpenState] = useState(false);

  const setChatOpen = useCallback((open: boolean) => {
    setChatOpenState(open);
    if (open) {
      setQueueOpenState(false);
      setLyricsOpenState(false);
    }
  }, []);

  const setQueueOpen = useCallback((open: boolean) => {
    setQueueOpenState(open);
    if (open) {
      setChatOpenState(false);
      setLyricsOpenState(false);
    }
  }, []);

  const setLyricsOpen = useCallback((open: boolean) => {
    setLyricsOpenState(open);
    if (open) {
      setChatOpenState(false);
      setQueueOpenState(false);
    }
  }, []);

  const value = useMemo(
    () => ({ chatOpen, queueOpen, lyricsOpen, setChatOpen, setQueueOpen, setLyricsOpen }),
    [chatOpen, queueOpen, lyricsOpen, setChatOpen, setQueueOpen, setLyricsOpen],
  );

  return <OverlaysContext.Provider value={value}>{children}</OverlaysContext.Provider>;
}

export function useOverlays(): OverlaysValue {
  const context = useContext(OverlaysContext);
  if (!context) throw new Error("useOverlays doit être utilisé dans un OverlaysProvider");
  return context;
}