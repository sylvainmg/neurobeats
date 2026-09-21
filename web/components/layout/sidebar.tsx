"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Check,
  Compass,
  Home,
  Library,
  ListMusic,
  Plus,
  Search,
  Sparkles,
  TrendingUp,
  X,
} from "lucide-react";

import { cn } from "cn";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Logo } from "@/components/layout/logo";
import { TrackCover } from "@/components/track-cover";
import { usePlaylists } from "@/lib/playlists";
import { coverSizes } from "@/lib/track";

const NAV = [
  { href: "/", label: "Accueil", icon: Home },
  { href: "/search", label: "Recherche", icon: Search },
  { href: "/discover", label: "Découvrir", icon: Compass },
  { href: "/library", label: "Bibliothèque", icon: Library },
];

/** Barre latérale fixe (marque + navigation + bibliothèque), style Spotify. */
export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { playlists, loading, createPlaylist } = usePlaylists();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  async function submitCreate() {
    const name = newName.trim();
    if (!name) return;
    try {
      const created = await createPlaylist(name);
      setNewName("");
      setCreating(false);
      if (created?.id) router.push(`/playlists/${created.id}`);
    } catch {
      // L'erreur est exposée par le store ; on laisse le champ ouvert pour réessayer.
    }
  }

  return (
    <aside className="hidden w-64 shrink-0 flex-col gap-2 md:flex">
      {/* Marque */}
      <div className="bg-surface flex items-center rounded-xl px-4 py-3.5">
        <Link href="/" aria-label="NeuroBeats — accueil">
          <Logo />
        </Link>
      </div>

      {/* Navigation principale */}
      <nav className="bg-surface rounded-xl p-2">
        <ul className="space-y-0.5">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname === href;
            return (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-semibold transition-colors",
                    active
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {/* Barre d'accent de l'onglet actif */}
                  <span
                    className={cn(
                      "bg-primary absolute top-1/2 left-0 h-5 w-1 -translate-y-1/2 rounded-r-full transition-opacity",
                      active ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <Icon
                    className={cn(
                      "size-5 transition-colors",
                      active ? "text-primary" : "group-hover:text-foreground",
                    )}
                  />
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Bibliothèque */}
      <div className="bg-surface flex min-h-0 flex-1 flex-col rounded-xl">
        <div className="flex items-center justify-between p-3 pl-4">
          <span className="text-muted-foreground flex items-center gap-2 text-sm font-semibold">
            <Library className="size-4" />
            Ta bibliothèque
          </span>
          <button
            type="button"
            aria-label={creating ? "Annuler la création" : "Créer une playlist"}
            aria-expanded={creating}
            onClick={() => setCreating((value) => !value)}
            className="text-muted-foreground hover:bg-surface-hover hover:text-foreground rounded-full p-1.5 transition-colors"
          >
            {creating ? <X className="size-4" /> : <Plus className="size-4" />}
          </button>
        </div>

        {creating && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submitCreate();
            }}
            className="px-2 pb-2"
          >
            <div className="bg-surface-hover flex items-center gap-1 rounded-lg px-2">
              <input
                autoFocus
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder="Nom de la playlist…"
                aria-label="Nom de la nouvelle playlist"
                className="text-foreground placeholder:text-muted-foreground h-8 min-w-0 flex-1 bg-transparent text-sm outline-none"
              />
              <button
                type="submit"
                aria-label="Créer la playlist"
                disabled={!newName.trim()}
                className="text-muted-foreground hover:text-foreground disabled:opacity-40"
              >
                <Check className="size-4" />
              </button>
            </div>
          </form>
        )}

        <ScrollArea className="min-h-0 flex-1">
          <ul className="space-y-1 px-2 pb-2">
            {playlists.length === 0 && !loading && (
              <li className="text-muted-foreground px-2 py-3 text-xs">
                Aucune playlist. Crée-en une avec « + ».
              </li>
            )}
            {playlists.map((playlist) => {
              const href = `/playlists/${playlist.id}`;
              const active = pathname === href;
              return (
                <li key={playlist.id}>
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "group hover:bg-surface-hover flex items-center gap-3 rounded-lg p-2 transition-colors",
                      active && "bg-surface-hover",
                    )}
                  >
                    <span className="relative block size-10 shrink-0 overflow-hidden rounded-md">
                      {playlist.cover ? (
                        <TrackCover
                          videoId={playlist.cover}
                          title={playlist.name}
                          sizes={coverSizes(40)}
                          className="size-10"
                        />
                      ) : (
                        <span className="bg-surface-hover flex size-10 items-center justify-center">
                          <ListMusic className="text-muted-foreground size-4" />
                        </span>
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="text-foreground block truncate text-sm font-medium">
                        {playlist.name}
                      </span>
                      <span className="text-muted-foreground block truncate text-xs">
                        {playlist.count} titre{playlist.count > 1 ? "s" : ""}
                        {playlist.mood ? ` · ${playlist.mood}` : ""}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </ScrollArea>

        {/* Recommandations IA */}
        <div className="border-border border-t p-2">
          <Link
            href="/discover"
            className="from-primary/20 to-accent/10 border-primary/30 hover:border-primary/60 group flex items-center gap-3 rounded-lg border bg-gradient-to-r p-3 transition-colors"
          >
            <span className="bg-primary/20 text-primary group-hover:bg-primary group-hover:text-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-full transition-colors">
              <Sparkles className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-foreground block truncate text-sm font-semibold">
                Recommandations IA
              </span>
              <span className="text-muted-foreground block truncate text-xs">
                Basé sur tes écoutes
              </span>
            </span>
            <TrendingUp className="text-primary size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
          </Link>
        </div>
      </div>
    </aside>
  );
}
