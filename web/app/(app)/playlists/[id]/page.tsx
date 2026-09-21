import type { Metadata } from "next";

import { PlaylistView } from "@/components/library/playlist-view";

export const metadata: Metadata = { title: "Playlist — NeuroBeats" };

export default async function PlaylistPage({ params }: PageProps<"/playlists/[id]">) {
  const { id } = await params;
  return <PlaylistView playlistId={id} />;
}
