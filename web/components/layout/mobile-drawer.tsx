"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Sparkles, TrendingUp, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { NAV } from "@/components/layout/nav-items";
import { Logo } from "@/components/layout/logo";
import { useOverlays } from "@/lib/overlays";
import { cn } from "cn";

/**
 * Navigation mobile : tiroir gauche ouvert par le burger de la barre du haut.
 *
 * Même patron que le panneau du chat (voile + transition sur le bord), mais
 * côté gauche. Le contenu reprend la navigation principale de la sidebar
 * (source unique `NAV`) et le raccourci Recommandations IA ; les playlists
 * restent dans Bibliothèque, pour garder un tiroir léger sur petit écran.
 *
 * L'ouverture ferme les autres surfaces flottantes (chat, file, paroles) :
 * une seule surface de premier plan à la fois, comme le fait déjà le store.
 * Desktop (`md:`), le tiroir et sa voile sont démontés : la sidebar reprend.
 */
export function MobileDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const pathname = usePathname();
  const { setChatOpen, setQueueOpen, setLyricsOpen } = useOverlays();
  const firstLinkRef = useRef<HTMLAnchorElement | null>(null);
  // Élément qui a ouvert le tiroir : le focus y revient à la fermeture.
  const openerRef = useRef<HTMLElement | null>(null);

  // L'ouverture du menu repasse les surfaces flottantes au premier plan unique.
  useEffect(() => {
    if (!open) return;
    setChatOpen(false);
    setQueueOpen(false);
    setLyricsOpen(false);
  }, [open, setChatOpen, setQueueOpen, setLyricsOpen]);

  // Focus : pose sur le premier lien à l'ouverture, retour à l'élément
  // déclencheur (le burger) à la fermeture.
  useEffect(() => {
    if (open) {
      openerRef.current = document.activeElement as HTMLElement | null;
      firstLinkRef.current?.focus();
    } else if (openerRef.current) {
      openerRef.current.focus();
      openerRef.current = null;
    }
  }, [open]);

  // Échap ferme le tiroir.
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      {/* Voile : mobile uniquement (md : la sidebar reprend la main). */}
      <div
        onClick={onClose}
        aria-hidden
        className={cn(
          "fixed inset-0 z-50 bg-black/50 transition-opacity md:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />

      <aside
        id="app-nav"
        aria-label="Navigation principale"
        inert={!open}
        className={cn(
          "bg-surface border-border fixed inset-y-2 left-2 z-50 flex w-64 flex-col overflow-hidden rounded-xl border shadow-[0_8px_24px_rgba(0,0,0,0.5)] transition-transform duration-300 md:hidden",
          open ? "translate-x-0" : "-translate-x-[calc(100%+0.5rem)]",
        )}
      >
        <header className="border-border flex items-center justify-between border-b px-4 py-3">
          <Link href="/" aria-label="NeuroBeats — accueil" onClick={onClose}>
            <Logo />
          </Link>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Fermer le menu"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground rounded-full"
          >
            <X />
          </Button>
        </header>

        {/* Navigation principale, même rendu que la sidebar. */}
        <nav className="p-2">
          <ul className="space-y-0.5">
            {NAV.map(({ href, label, icon: Icon }, index) => {
              const active = pathname === href;
              return (
                <li key={href}>
                  <Link
                    href={href}
                    ref={index === 0 ? firstLinkRef : undefined}
                    onClick={onClose}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors",
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

        {/* Recommandations IA : même carte que dans la sidebar. */}
        <div className="border-border mt-auto border-t p-2">
          <Link
            href="/discover"
            onClick={onClose}
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
      </aside>
    </>
  );
}