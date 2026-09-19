import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { NowPlaying } from "@/components/layout/now-playing";
import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/top-bar";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
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
      className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="bg-background text-foreground h-full">
        {/* Structure Spotify : contenu scrollable + player bar fixe en bas */}
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
      </body>
    </html>
  );
}
