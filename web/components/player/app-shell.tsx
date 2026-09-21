"use client";

import { PlayerProvider } from "@/components/player/player-context";
import { NowPlaying } from "@/components/layout/now-playing";
import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/top-bar";
import { ChatLauncher } from "@/components/chat/chat-launcher";
import { OverlaysProvider } from "@/lib/overlays";
import { PlaylistsProvider } from "@/lib/playlists";

/** Enveloppe client : fournit l'état de lecture et monte le layout Spotify. */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <PlayerProvider>
      <PlaylistsProvider>
        <OverlaysProvider>
          <div className="flex h-dvh flex-col gap-2 p-2">
            <div className="flex min-h-0 flex-1 gap-2">
              <Sidebar />
              <main className="bg-card flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl">
                <TopBar />
                <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
                  {children}
                </div>
              </main>
            </div>
            <NowPlaying />
          </div>
          <ChatLauncher />
        </OverlaysProvider>
      </PlaylistsProvider>
    </PlayerProvider>
  );
}
