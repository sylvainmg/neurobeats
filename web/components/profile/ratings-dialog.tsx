"use client";

import { useMemo, useRef, useState } from "react";
import { CheckCircle2, Loader2, Play, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Rating } from "@/components/layout/rating";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TrackCover } from "@/components/track-cover";
import { usePlayer } from "@/components/player/player-context";
import { type RatedTrack } from "@/lib/api";
import { useStore } from "@/lib/store";
import { coverSizes } from "@/lib/track";
import { cn } from "cn";

/** Casse et accents ignorés, pour faire fusionner "GAZO" et "gazo". */
function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/** Taille de palier. Les notes tiennent déjà en entier dans le store (aucune
 *  requête réseau) : le palier borne le DOM, pas la donnée. */
const PAGE = 40;

/**
 * Toutes les notes ★, listées dans un modal.
 *
 * Même logique que l'historique (recherche + roulement au scroll), mais sans
 * pagination serveur : le store possède la liste complète, on ne matérialise
 * qu'un palier dans le DOM. La suppression et la correction de note passent
 * par le store (source unique) : le dialogue se met à jour en direct.
 */
export function RatingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { play, state } = usePlayer();
  const { ratings, clearRating } = useStore();
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);

  // Recherche locale, puis fenêtrage : le scroll borné, la donnée reste entière.
  const { items, total } = useMemo(() => {
    const needle = normalize(query.trim());
    const source = needle
      ? ratings.filter((rated) =>
          normalize(`${rated.title ?? ""} ${rated.channel ?? ""}`).includes(needle),
        )
      : ratings;
    return { items: source.slice(0, limit), total: source.length };
  }, [query, ratings, limit]);
  const finished = items.length >= total;

  const currentId = state?.video_id;
  // Dernier titre lancé : seule la ligne du lancement le plus récent porte le
  // feedback — la résolution d'une lecture annulée ne coupe pas l'indicateur
  // d'une nouvelle (même garde que dans l'historique).
  const launchRef = useRef<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  function launch(rated: RatedTrack) {
    launchRef.current = rated.video_id;
    setLoadingId(rated.video_id);
    void play(rated.video_id).finally(() => {
      if (launchRef.current === rated.video_id) setLoadingId(null);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg"
        onOpenAutoFocus={() => {
          setQuery("");
          setLimit(PAGE);
        }}
      >
        <DialogHeader>
          <div className="space-y-1">
            <DialogTitle className="pr-8">Mes notes</DialogTitle>
            <DialogDescription>
              {ratings.length.toLocaleString("fr-FR")} titre
              {ratings.length > 1 ? "s" : ""} noté
              {ratings.length > 1 ? "s" : ""}. Clique sur un titre pour le
              lancer.
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Rechercher un titre ou un artiste…"
            aria-label="Rechercher dans les notes"
          />

          {items.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {query.trim()
                ? "Aucun titre ne correspond à cette recherche."
                : "Aucune note pour l'instant. Note un titre depuis la recherche ou la barre de lecture."}
            </p>
          ) : (
            <ScrollArea
              className="h-[50dvh]"
              onScroll={(event) => {
                const viewport = event.currentTarget;
                const nearBottom =
                  viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <
                  240;
                if (nearBottom && !finished) setLimit((current) => current + PAGE);
              }}
            >
              <ul className="space-y-0.5 pr-3">
                {items.map((rated) => {
                  const isCurrent = currentId === rated.video_id;
                  const isLoading = loadingId === rated.video_id;
                  return (
                    <li
                      key={rated.video_id}
                      className="group/row hover:bg-surface-hover flex items-center gap-3 rounded-xl p-2 transition-colors"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          if (isLoading) return;
                          launch(rated);
                        }}
                        aria-current={isCurrent ? "true" : undefined}
                        aria-busy={isLoading || undefined}
                        className="focus-visible:ring-ring/60 flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left focus-visible:ring-3 focus-visible:outline-none"
                      >
                        <span className="relative shrink-0">
                          <TrackCover
                            videoId={rated.video_id}
                            title={rated.title}
                            sizes={coverSizes(44)}
                            rounded="rounded-md"
                            className="size-11"
                          />
                          {/* Affordance de lecture au survol ; spinner permanent
                              sur la ligne en cours de chargement. */}
                          <span
                            className={cn(
                              "bg-primary text-primary-foreground absolute inset-0 grid place-items-center rounded-md transition-opacity",
                              isLoading
                                ? "opacity-100"
                                : "opacity-0 group-hover/row:opacity-100",
                            )}
                          >
                            {isLoading ? (
                              <Loader2
                                className="size-4 animate-spin"
                                aria-hidden="true"
                              />
                            ) : (
                              <Play
                                className="size-4 fill-current"
                                aria-hidden="true"
                              />
                            )}
                          </span>
                        </span>
                        <span className="min-w-0 flex-1">
                          <span
                            className={cn(
                              "block truncate text-sm font-medium",
                              isCurrent && "text-primary",
                            )}
                          >
                            {rated.title || rated.video_id}
                          </span>
                          <span className="text-muted-foreground block truncate text-xs">
                            {isLoading
                              ? "Chargement du titre…"
                              : rated.channel}
                          </span>
                        </span>
                      </button>

                      {/* Étoiles au survol/focus : on peut corriger la note
                          sans quitter la liste ; toujours visibles au tactile.
                          `inline` : on est déjà dans une modale, pas de
                          modale imbriquée — la rangée reste directe. */}
                      <Rating
                        videoId={rated.video_id}
                        title={rated.title}
                        channel={rated.channel}
                        inline
                        className="shrink-0 opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 pointer-coarse:opacity-100"
                      />

                      <button
                        type="button"
                        aria-label={`Retirer la note de ${rated.title || rated.video_id}`}
                        onClick={() => void clearRating(rated.video_id)}
                        className="text-muted-foreground hover:text-destructive shrink-0 rounded-full p-1.5"
                      >
                        <X className="size-4" aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </ScrollArea>
          )}

          {finished && items.length > 0 ? (
            <p className="text-muted-foreground flex items-center justify-center gap-1.5 text-xs">
              <CheckCircle2 className="size-3.5" aria-hidden="true" />
              Fin des notes
            </p>
          ) : null}
        </div>

        <div className="border-border border-t p-4">
          <DialogClose asChild>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground w-full text-xs"
            >
              Fermer
            </Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}