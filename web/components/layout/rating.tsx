"use client";

import { useState } from "react";
import { Star } from "lucide-react";

import { useStore } from "@/lib/store";
import { cn } from "cn";

const VALUES = [1, 2, 3, 4, 5];

/**
 * Note ★ d'un titre (1-5), persistée côté serveur.
 *
 * Cliquer une étoile enregistre la note ; recliquer la note courante l'efface
 * (retour à « non noté »). L'aperçu au survol permet de viser sans engager, et
 * l'état vient du store unique : la même note s'affiche partout (recherche,
 * barre de lecture, Profil) et se met à jour si elle change ailleurs.
 */
export function Rating({
  videoId,
  title = "",
  channel = "",
  size = "sm",
  className,
}: {
  videoId: string;
  title?: string;
  channel?: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const { byId, rate, clearRating } = useStore();
  const [hovered, setHovered] = useState(0);
  const current = byId[videoId] ?? 0;
  const shown = hovered || current;
  const starSize = size === "md" ? "size-5" : "size-4";

  function pick(value: number) {
    if (value === current) void clearRating(videoId);
    else void rate({ video_id: videoId, title, channel }, value);
  }

  return (
    <div
      role="radiogroup"
      aria-label={current > 0 ? `Note : ${current} sur 5` : "Noter ce titre"}
      className={cn("flex items-center gap-0.5", className)}
      onMouseLeave={() => setHovered(0)}
    >
      {VALUES.map((value) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={current === value}
          aria-label={`${value} étoile${value > 1 ? "s" : ""}`}
          onClick={(event) => {
            // Le widget est souvent posé sur une ligne cliquable : on isole le clic.
            event.stopPropagation();
            event.preventDefault();
            pick(value);
          }}
          onMouseEnter={() => setHovered(value)}
          className="focus-visible:ring-ring/60 rounded p-0.5 transition-transform hover:scale-110 focus-visible:ring-3 focus-visible:outline-none"
        >
          <Star
            className={cn(
              starSize,
              "transition-colors",
              value <= shown
                ? "fill-primary text-primary"
                : "text-muted-foreground/60 hover:text-foreground",
            )}
          />
        </button>
      ))}
    </div>
  );
}
