"use client";

import { useEffect } from "react";

import { LyricsOverlay } from "@/components/lyrics/lyrics-overlay";
import { useOverlays } from "@/lib/overlays";

/**
 * Orchestrateur des paroles : monte le grand panneau et ferme au clavier.
 * Monté après ChatLauncher dans l'AppShell pour que le panneau (z-40) couvre
 * le bouton flottant du chat (z-40 aussi, mais plus haut dans le DOM ici).
 */
export function LyricsLauncher() {
  const { lyricsOpen, setLyricsOpen } = useOverlays();

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setLyricsOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setLyricsOpen]);

  return <LyricsOverlay open={lyricsOpen} onClose={() => setLyricsOpen(false)} />;
}