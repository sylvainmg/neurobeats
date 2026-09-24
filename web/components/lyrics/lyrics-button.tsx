"use client";

import { MicVocal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "cn";

/** Bascule du panneau paroles, logée dans la barre du lecteur (côté droit). */
export function LyricsButton({
  open,
  disabled = false,
  onToggle,
}: {
  open: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={open ? "Fermer les paroles" : "Afficher les paroles"}
      aria-pressed={open}
      disabled={disabled}
      onClick={onToggle}
      title={open ? "Fermer les paroles" : "Paroles"}
      className={cn(
        "rounded-full",
        open
          ? "bg-surface-hover text-primary hover:text-primary"
          : "text-muted-foreground hover:text-foreground disabled:opacity-40",
      )}
    >
      <MicVocal />
    </Button>
  );
}