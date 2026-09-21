import type { Metadata } from "next";
import { Inter } from "next/font/google";

import { RealtimeProvider } from "@/lib/realtime";
import { StoreProvider } from "@/lib/store";
import "./globals.css";

// Inter : standard des plateformes de streaming en dark mode (proche de
// la Circular de Spotify), lisible et neutre.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "NeuroBeats",
  description: "Lecteur musical intelligent — recommandations par IA",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="fr"
      className={`${inter.variable} dark h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="bg-background text-foreground h-full">
        {/* Monté à la racine : la connexion (et donc la musique) survit à la
            navigation, y compris vers les routes sans player (profil). */}
        <RealtimeProvider>
          <StoreProvider>{children}</StoreProvider>
        </RealtimeProvider>
      </body>
    </html>
  );
}
