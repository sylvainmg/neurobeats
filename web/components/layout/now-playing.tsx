"use client";

import {
  Play,
  Repeat,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";

/**
 * Barre de lecture basse (player), inspiration Spotify.
 * Phase layout : commandes visuelles, non connectées au backend.
 */
export function NowPlaying() {
  return (
    <footer className="border-border bg-surface flex h-20 shrink-0 items-center gap-4 border-t px-4">
      {/* Titre en cours */}
      <div className="flex w-56 min-w-0 items-center gap-3">
        <div className="bg-surface-hover size-12 shrink-0 rounded-md" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">Aucune lecture</p>
          <p className="text-muted-foreground truncate text-xs">
            Lance un titre pour commencer
          </p>
        </div>
      </div>

      {/* Contrôles + progression */}
      <div className="flex flex-1 flex-col items-center gap-1">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Aléatoire"
            className="text-muted-foreground hover:text-foreground"
          >
            <Shuffle />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Précédent"
            className="text-muted-foreground hover:text-foreground"
          >
            <SkipBack />
          </Button>
          <Button
            size="icon-lg"
            aria-label="Lecture"
            className="bg-primary text-primary-foreground hover:bg-primary/80 rounded-full"
          >
            <Play className="fill-current" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Suivant"
            className="text-muted-foreground hover:text-foreground"
          >
            <SkipForward />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Répéter"
            className="text-muted-foreground hover:text-foreground"
          >
            <Repeat />
          </Button>
        </div>
        <div className="flex w-full max-w-md items-center gap-2">
          <span className="text-muted-foreground w-8 text-right text-[10px] tabular-nums">
            0:00
          </span>
          <Slider defaultValue={[0]} max={100} step={1} className="flex-1" />
          <span className="text-muted-foreground w-8 text-[10px] tabular-nums">
            0:00
          </span>
        </div>
      </div>

      {/* Volume */}
      <div className="hidden w-56 items-center justify-end gap-2 lg:flex">
        <Volume2 className="text-muted-foreground size-4" />
        <Slider defaultValue={[70]} max={100} step={1} className="w-28" />
      </div>
    </footer>
  );
}
