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
 * Coordination des panneaux flottants de droite (assistant, file de lecture).
 * Ils occupent la même zone : ouvrir l'un ferme l'autre.
 */
interface OverlaysValue {
  chatOpen: boolean;
  queueOpen: boolean;
  setChatOpen: (open: boolean) => void;
  setQueueOpen: (open: boolean) => void;
}

const OverlaysContext = createContext<OverlaysValue | null>(null);

export function OverlaysProvider({ children }: { children: ReactNode }) {
  const [chatOpen, setChatOpenState] = useState(false);
  const [queueOpen, setQueueOpenState] = useState(false);

  const setChatOpen = useCallback((open: boolean) => {
    setChatOpenState(open);
    if (open) setQueueOpenState(false);
  }, []);

  const setQueueOpen = useCallback((open: boolean) => {
    setQueueOpenState(open);
    if (open) setChatOpenState(false);
  }, []);

  const value = useMemo(
    () => ({ chatOpen, queueOpen, setChatOpen, setQueueOpen }),
    [chatOpen, queueOpen, setChatOpen, setQueueOpen],
  );

  return <OverlaysContext.Provider value={value}>{children}</OverlaysContext.Provider>;
}

export function useOverlays(): OverlaysValue {
  const context = useContext(OverlaysContext);
  if (!context) throw new Error("useOverlays doit être utilisé dans un OverlaysProvider");
  return context;
}
