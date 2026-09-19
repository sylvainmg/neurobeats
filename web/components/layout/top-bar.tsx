"use client";

import { ChevronLeft, ChevronRight, User } from "lucide-react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";

/** Barre supérieure : navigation historique + accès profil, inspiration Spotify. */
export function TopBar() {
  const router = useRouter();

  return (
    <header className="bg-background/80 sticky top-0 z-10 flex items-center justify-between gap-4 px-4 py-3 backdrop-blur">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Page précédente"
          onClick={() => router.back()}
          className="bg-surface text-muted-foreground hover:bg-surface-hover hover:text-foreground rounded-full"
        >
          <ChevronLeft />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Page suivante"
          onClick={() => router.forward()}
          className="bg-surface text-muted-foreground hover:bg-surface-hover hover:text-foreground rounded-full"
        >
          <ChevronRight />
        </Button>
      </div>

      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Profil"
        className="bg-surface text-muted-foreground hover:bg-surface-hover hover:text-foreground rounded-full"
      >
        <User />
      </Button>
    </header>
  );
}
