"use client";

import { useState } from "react";

import { PlayerProvider } from "@/components/player/player-context";
import { NowPlaying } from "@/components/layout/now-playing";
import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/top-bar";
import { MobileDrawer } from "@/components/layout/mobile-drawer";
import { ChatLauncher } from "@/components/chat/chat-launcher";
import { LyricsLauncher } from "@/components/lyrics/lyrics-launcher";
import { OverlaysProvider } from "@/lib/overlays";
import { PlaylistsProvider } from "@/lib/playlists";

/** Enveloppe client : fournit l'état de lecture et monte le layout Spotify. */
export function AppShell({ children }: { children: React.ReactNode }) {
  // État du tiroir de navigation mobile, partagé entre le burger (TopBar) et
  // le tiroir lui-même (monté après les launchers pour couvrir tout l'écran).
  const [navOpen, setNavOpen] = useState(false);

  return (
    <PlayerProvider>
      <PlaylistsProvider>
        <OverlaysProvider>
          <div className="flex h-dvh flex-col gap-2 p-2">
            <div className="flex min-h-0 flex-1 gap-2">
              <Sidebar />
              <main className="bg-card flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl">
                <TopBar
                  menuOpen={navOpen}
                  onMenuClick={() => setNavOpen((open) => !open)}
                />
                {/* Padding mobile réduit : plus de largeur utile pour les
                    grilles (2 colonnes) sur petit écran. */}
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 sm:px-6 sm:pb-6">
                  {children}
                </div>
              </main>
            </div>
            <NowPlaying />
          </div>
          <ChatLauncher />
          {/* Monté après ChatLauncher : le panneau paroles (z-40) couvre le
              bouton flottant du chat lorsqu'il est ouvert. */}
          <LyricsLauncher />
          {/* Tiroir mobile monté en dernier : il repasse les surfaces flottantes
              au premier plan unique (voir useOverlays) et sa couche z-50 est
              au-dessus des panneaux z-40. */}
          <MobileDrawer open={navOpen} onClose={() => setNavOpen(false)} />
        </OverlaysProvider>
      </PlaylistsProvider>
    </PlayerProvider>
  );
}