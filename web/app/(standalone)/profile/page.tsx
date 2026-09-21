import type { Metadata } from "next";

import { ProfileView } from "@/components/profile/profile-view";

export const metadata: Metadata = { title: "Profil — NeuroBeats" };

/** Page Profil : identité, statistiques, assistant des goûts et données récoltées. */
export default function ProfilePage() {
  return <ProfileView />;
}
