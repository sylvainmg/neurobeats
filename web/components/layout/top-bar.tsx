"use client";

import Link from "next/link";
import { User } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";

/**
 * Barre supérieure : accès profil.
 *
 * Affiche la photo du profil quand il y en a une (même store que la page
 * Profil : elle se met donc à jour dès que la photo change), sinon l'icône.
 */
export function TopBar() {
  const { profile } = useStore();
  const avatar = profile?.identity?.avatar ?? "";

  return (
    <header className="flex items-center justify-end px-4 py-3">
      <Button
        asChild
        variant="ghost"
        size="icon-sm"
        aria-label="Profil"
        className="bg-surface text-muted-foreground hover:bg-surface-hover hover:text-foreground overflow-hidden rounded-full"
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
