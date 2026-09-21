"use client";

import { Play } from "lucide-react";

import { TrackCover } from "@/components/track-cover";
import { cn } from "cn";

/** Titre minimal affichable en carte (Accueil, Découvrir, …). */
export interface CardTrack {
  video_id: string;
  title: string;
  channel: string;
}

/** Squelette de section : cartes en attente de contenu. */
export function SectionSkeleton({ cards }: { cards: number }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
      {Array.from({ length: cards }, (_, i) => (
        <div key={i} aria-hidden="true" className="bg-surface space-y-3 rounded-xl p-3">
          <span className="bg-surface-hover block aspect-square w-full animate-pulse rounded-lg" />
          <span className="bg-surface-hover block h-3.5 w-2/3 animate-pulse rounded-full" />
          <span className="bg-surface-hover block h-3 w-1/3 animate-pulse rounded-full" />
        </div>
      ))}
    </div>
  );
}

/**
 * Carte de recommandation : pochette carrée, lecture au survol/focus.
 *
 * `sizes` annonce la largeur à télécharger. La jaquette source est en 16/9 et
 * recadrée en carré par `object-cover` : c'est donc sa hauteur qui doit couvrir
 * la boîte, soit une source ~1.78× plus large que le carré affiché. Sous-estimer
 * cette valeur fait servir une image trop courte, que le navigateur agrandit —
 * d'où un rendu flou. Le défaut vise une grille à 4 colonnes ; une grille à 3
 * colonnes passe 1280px, la plus grande jaquette publiée par YouTube, ce qui
 * suréchantillonne sur écran non dense sans coûter plus cher à télécharger.
 */
export function TrackCard({
  track,
  index,
  isCurrent,
  disabled,
  onPlay,
  sizes = "(max-width: 640px) 80vw, 420px",
}: {
  track: CardTrack;
  index: number;
  isCurrent: boolean;
  disabled: boolean;
  onPlay: () => void;
  sizes?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onPlay}
      aria-current={isCurrent ? "true" : undefined}
      style={{ animationDelay: `${index * 40}ms` }}
      className={cn(
        "nb-rise group bg-surface hover:bg-surface-hover focus-visible:ring-ring/60 flex flex-col gap-3 rounded-xl p-3 text-left transition-colors focus-visible:ring-3 focus-visible:outline-none",
        disabled && "opacity-60",
      )}
    >
      <span className="relative block w-full">
        <TrackCover
          videoId={track.video_id}
          title={track.title}
          sizes={sizes}
          rounded="rounded-lg"
          className="aspect-square w-full"
          hq
        />
        {/* Affordance de lecture : bouton flottant façon Spotify. */}
        <span className="bg-primary text-primary-foreground absolute right-2 bottom-2 grid size-9 translate-y-1 place-items-center rounded-full opacity-0 shadow-lg transition-all group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100">
          <Play className="size-4 fill-current" />
        </span>
      </span>
      <span className="min-w-0 space-y-0.5">
        <span className={cn("block truncate text-sm font-medium", isCurrent && "text-primary")}>
          {track.title}
        </span>
        <span className="text-muted-foreground block truncate text-xs">{track.channel}</span>
      </span>
    </button>
  );
}
