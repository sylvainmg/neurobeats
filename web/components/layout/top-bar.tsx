"use client";

import Link from "next/link";
import { Menu, User } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";

/**
 * Barre supérieure : burger (navigation mobile) + accès profil.
 *
 * Le burger n'existe qu'en dessous de `md` : au-delà, la sidebar reprend la
 * navigation. Le bouton profil affiche la photo quand il y en a une (même
 * store que la page Profil : elle se met à jour dès la modification), sinon
 * l'icône.
 */
export function TopBar({
  menuOpen,
  onMenuClick,
}: {
  menuOpen: boolean;
  onMenuClick: () => void;
}) {
  const { profile } = useStore();
  const avatar = profile?.identity?.avatar ?? "";

  return (
    <header className="flex items-center justify-between px-4 py-3">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={menuOpen ? "Fermer le menu" : "Ouvrir le menu"}
        aria-expanded={menuOpen}
        aria-controls="app-nav"
        onClick={onMenuClick}
        className="bg-surface text-muted-foreground hover:bg-surface-hover hover:text-foreground size-10 rounded-full md:hidden"
      >
        <Menu />
      </Button>

      <Button
        asChild
        variant="ghost"
        size="icon-sm"
        aria-label="Profil"
        className="ml-auto bg-surface text-muted-foreground hover:bg-surface-hover hover:text-foreground overflow-hidden rounded-full max-md:size-10"
      >
        <Link href="/profile">
          {avatar ? (
            // eslint-disable-next-line @next/next/no-img-element -- data URL locale, pas d'optimisation Next
            <img src={avatar} alt="" className="size-full object-cover" />
          ) : (
            <User />
          )}
        </Link>
      </Button>
    </header>
  );
}