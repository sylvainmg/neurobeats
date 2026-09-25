import type { Metadata } from "next";
import { Suspense } from "react";

import { ProfileView } from "@/components/profile/profile-view";
import { PlayerProvider } from "@/components/player/player-context";
import { OnlineProvider } from "@/lib/online";

export const metadata: Metadata = { title: "Profil — NeuroBeats" };

/**
 * Page Profil : identité, statistiques, assistant des goûts et données.
 *
 * `PlayerProvider` est monté ici (la page est hors `AppShell`) pour que le
 * lancement d'un titre depuis l'historique joue le même chemin que la
 * recherche : `play(videoId)` → POST /api/play sur le daemon de lecture.
 * `OnlineProvider` suit le même ressort : l'assistant des goûts consomme
 * `useOnline()` pour inerter sa zone de saisie hors ligne.
 *
 * `Suspense` est requis : le composant lit la query (`?tab=ia`) pour que le
 * bandeau « Configurer » ouvre bien l'onglet IA depuis la page elle-même.
 */
export default function ProfilePage() {
  return (
    <PlayerProvider>
      <OnlineProvider>
        <Suspense fallback={null}>
          <ProfileView />
        </Suspense>
      </OnlineProvider>
    </PlayerProvider>
  );
}
