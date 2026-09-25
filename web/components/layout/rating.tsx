"use client";

import { useState } from "react";
import { Star, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useStore } from "@/lib/store";
import { cn } from "cn";

const VALUES = [1, 2, 3, 4, 5];

/**
 * Note ★ d'un titre (1-5), persistée côté serveur.
 *
 * Deux rendus selon l'écran :
 * - Desktop (`md+`) : rangée de 5 étoiles cliquables, avec aperçu au survol —
 *   adaptée au pointeur précis.
 * - Mobile (`< md`) : un bouton compact (étoile + note courante) qui ouvre une
 *   modale de grandes étoiles — des cibles tactiles confortables au lieu de
 *   cinq petits boutons entassés dans les colonnes d'action.
 *
 * Recliquer la note courante l'efface (retour à « non noté »). L'état vient du
 * store unique : la même note s'affiche partout (recherche, barre de lecture,
 * Profil) et se met à jour si elle change ailleurs.
 */
export function Rating({
  videoId,
  title = "",
  channel = "",
  size = "sm",
  inline = false,
  className,
}: {
  videoId: string;
  title?: string;
  channel?: string;
  size?: "sm" | "md";
  /** Toujours la rangée d'étoiles inline : pour les listes déjà dans une
   *  modale (Profil → « Mes notes »), où une modale imbriquée n'aurait pas de
   *  sens — les étoiles y corrigent la note directement. */
  inline?: boolean;
  className?: string;
}) {
  const { byId, rate, clearRating } = useStore();
  const [hovered, setHovered] = useState(0);
  const [open, setOpen] = useState(false);
  const current = byId[videoId] ?? 0;
  const shown = hovered || current;
  const starSize = size === "md" ? "size-5" : "size-4";

  function pick(value: number) {
    if (value === current) void clearRating(videoId);
    else void rate({ video_id: videoId, title, channel }, value);
    setOpen(false);
  }

  // Rangée desktop : 5 étoiles cliquables avec aperçu au survol.
  const stars = (
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

  // Bouton compact mobile : ouvre la modale de notation.
  const trigger = (
    <Button
      type="button"
      variant="ghost"
      aria-haspopup="dialog"
      aria-label={
        current > 0 ? `Note : ${current} sur 5 — modifier` : "Noter ce titre"
      }
      onClick={(event) => {
        // Semble sur une ligne cliquable (résultats) : on isole le clic.
        event.stopPropagation();
        event.preventDefault();
        setOpen(true);
      }}
      className={cn(
        "text-muted-foreground hover:text-foreground gap-1 rounded-full px-1.5",
        current > 0 && "text-primary hover:text-primary",
        className,
      )}
    >
      <Star className={cn("size-4", current > 0 && "fill-current")} />
      {current > 0 && <span className="text-xs font-medium">{current}</span>}
    </Button>
  );

  const dialog = (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Note ce titre</DialogTitle>
          <DialogDescription className="max-w-full truncate">
            {title || "Titre inconnu"}
            {channel ? (
              <span className="text-muted-foreground/70"> — {channel}</span>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4 p-5">
          {/* Grandes étoiles : cibles tactiles confortables (40 px). */}
          <div
            role="radiogroup"
            aria-label="Choisir une note de 1 à 5"
            className="flex items-center gap-2"
          >
            {VALUES.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={current === value}
                aria-label={`${value} étoile${value > 1 ? "s" : ""}`}
                onClick={() => pick(value)}
                onMouseEnter={() => setHovered(value)}
                onMouseLeave={() => setHovered(0)}
                className="focus-visible:ring-ring/60 flex size-10 items-center justify-center rounded-full transition-transform hover:scale-110 active:scale-95 focus-visible:ring-3 focus-visible:outline-none"
              >
                <Star
                  className={cn(
                    "size-7 transition-colors",
                    value <= shown
                      ? "fill-primary text-primary"
                      : "text-muted-foreground/60 hover:text-foreground",
                  )}
                />
              </button>
            ))}
          </div>

          {current > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void clearRating(videoId);
                setOpen(false);
              }}
              className="text-muted-foreground hover:text-destructive rounded-full"
            >
              <Trash2 className="size-3.5" />
              Retirer la note ({current}/5)
            </Button>
          ) : (
            <p className="text-muted-foreground text-xs">
              Touche une étoile pour noter ce titre.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );

  if (inline) return stars;

  return (
    <>
      {/* Mobile : bouton compact + modale. Desktop : rangée directe. */}
      <div className="md:hidden">{trigger}</div>
      <div className="hidden md:flex">{stars}</div>
      {dialog}
    </>
  );
}