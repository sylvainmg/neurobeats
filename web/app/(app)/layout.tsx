import { AppShell } from "@/components/player/app-shell";

/** Layout de l'application : sidebar + contenu + player (inspiration Spotify). */
export default function AppLayout({ children }: LayoutProps<"/">) {
  return <AppShell>{children}</AppShell>;
}
