"use client";

import { Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "cn";

/** Bouton flottant d'accès au chatbot de l'agent IA. */
export function ChatFab({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      type="button"
      size="icon-lg"
      aria-label={open ? "Fermer l'assistant" : "Ouvrir l'assistant"}
      aria-expanded={open}
      onClick={onToggle}
      className={cn(
        "fixed right-5 bottom-36 z-40 size-11 rounded-full shadow-[0_8px_24px_rgba(0,0,0,0.5)] transition-all md:bottom-28",
        "bg-primary text-primary-foreground hover:bg-primary/90 hover:scale-105",
      )}
    >
      {open ? <X className="size-5" /> : <Sparkles className="size-5" />}
    </Button>
  );
}
