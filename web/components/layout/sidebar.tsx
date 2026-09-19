"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Compass,
  Home,
  Library,
  ListMusic,
  Plus,
  Search,
  Sparkles,
} from "lucide-react";

import { cn } from "cn";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

const NAV = [
  { href: "/", label: "Accueil", icon: Home },
  { href: "/search", label: "Recherche", icon: Search },
  { href: "/discover", label: "Découvrir", icon: Compass },
  { href: "/library", label: "Bibliothèque", icon: Library },
];

const PLAYLISTS = [
  { href: "/playlists/rap-fr", label: "Rap FR" },
  { href: "/playlists/chill", label: "Chill" },
  { href: "/playlists/workout", label: "Workout" },
];

/** Barre latérale fixe (navigation + playlists), inspiration Spotify. */
export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden w-64 shrink-0 flex-col gap-2 md:flex">
      <nav className="bg-surface rounded-xl p-3">
        <ul className="space-y-1">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname === href;
            return (
              <li key={href}>
                <Link
                  href={href}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-semibold transition-colors",
                    active
                      ? "bg-surface-hover text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="size-5" />
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="bg-surface flex min-h-0 flex-1 flex-col rounded-xl">
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <span className="text-muted-foreground text-sm font-semibold">
            Ta bibliothèque
          </span>
          <button
            type="button"
            aria-label="Créer une playlist"
            className="text-muted-foreground hover:bg-surface-hover hover:text-foreground rounded-full p-1 transition-colors"
          >
            <Plus className="size-4" />
          </button>
        </div>

        <Separator className="bg-border" />

        <ScrollArea className="flex-1">
          <ul className="space-y-1 p-2">
            {PLAYLISTS.map(({ href, label }) => (
              <li key={href}>
                <Link
                  href={href}
                  className="text-muted-foreground hover:bg-surface-hover hover:text-foreground flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors"
                >
                  <ListMusic className="size-4 shrink-0" />
                  <span className="truncate">{label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </ScrollArea>

        <div className="border-border border-t p-3">
          <Link
            href="/discover"
            className="text-primary hover:text-accent flex items-center gap-2 rounded-md px-3 py-2 text-sm font-semibold transition-colors"
          >
            <Sparkles className="size-4" />
            Recommandations IA
          </Link>
        </div>
      </div>
    </aside>
  );
}
