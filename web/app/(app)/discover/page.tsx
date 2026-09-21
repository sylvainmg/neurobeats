import type { Metadata } from "next";

import { DiscoverView } from "@/components/discover/discover-view";

export const metadata: Metadata = { title: "Découvrir — NeuroBeats" };

export default function DiscoverPage() {
  return <DiscoverView />;
}
