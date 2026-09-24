import type { Metadata } from "next";

import { ProfileView } from "@/components/profile/profile-view";
import { PlayerProvider } from "@/components/player/player-context";

export const metadata: Metadata = { title: "Profil — NeuroBeats" };

/**
 * Page Profil : identité, statistiques, assistant des goûts et données.
 *
 * `PlayerProvider` est monté ici (la page est hors `AppShell`) pour que le
 * lancement d'un titre depuis l'historique joue le même chemin que la
 * recherche : `play(videoId)` → POST /api/play sur le daemon de lecture.
 */
export default function ProfilePage() {
  return (
    <PlayerProvider>
      <ProfileView />
    </PlayerProvider>
  );
}
