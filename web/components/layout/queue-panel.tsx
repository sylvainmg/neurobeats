"use client";

import { useEffect, useRef } from "react";
import { ListMusic, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TrackCover } from "@/components/track-cover";
import type { QueueTrack } from "@/lib/api";
import { coverSizes } from "@/lib/track";
import { cn } from "cn";

const PLACEHOLDER: QueueTrack[] = [];
const TARGET_ROWS = 8;

/** Panneau latéral droit : timeline linéaire de lecture. */
export function QueuePanel({
  open,
  onClose,
  tracks = PLACEHOLDER,
  currentIndex: currentIndexProp = -1,
  remaining = 0,
  filling = false,
  onSelect,
  onRemove,
}: {
  open: boolean;
  onClose: () => void;
  /** Séquence complète : titres joués + courant + titres à venir. */
  tracks?: QueueTrack[];
  /** Index du titre en lecture dans `tracks` (-1 si vide). */
  currentIndex?: number;
  /** Nombre de titres à venir (pour dimensionner le skeleton). */
  remaining?: number;
  filling?: boolean;
  onSelect?: (index: number) => void;
  /** Retrait d'un titre à venir (index dans `tracks`, identifiant du titre). */
  onRemove?: (index: number, videoId: string) => void;
}) {
  const currentRef = useRef<HTMLLIElement | null>(null);

  // Un titre ne figure qu'une fois dans la timeline : le serveur retire son
  // occurrence précédente quand il est rejoué, et le curseur recule sur place.
  // La position reste dans la clé React, pour rester robuste si jamais deux
  // entrées identiques remontaient.
  const items = tracks.filter((track) => track?.video_id);
  const currentIndex = currentIndexProp;
  const itemCount = items.length;

  // Garde le titre courant visible quand la timeline défile (longue session).
  useEffect(() => {
    if (!open) return;
    currentRef.current?.scrollIntoView({ block: "nearest" });
  }, [open, currentIndex, itemCount]);

  const skeletonCount = filling ? Math.max(0, TARGET_ROWS - remaining) : 0;

  return (
    <>
      {/* Voile tactile : sur mobile, la file devient un panneau fenêtré dont le
          fond est recouvert ; la fermer se fait d'un tap hors du panneau. Le
          voile est absent sur desktop : les overlays y sont secondaires. */}
      <div
        onClick={onClose}
        aria-hidden
        className={cn(
          "fixed inset-0 z-40 bg-black/50 transition-opacity md:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      <aside
        aria-label="File de lecture"
        className={cn(
          "bg-surface border-border fixed top-2 right-2 bottom-32 z-40 flex w-80 max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-xl border shadow-[0_8px_24px_rgba(0,0,0,0.5)] transition-transform duration-300 md:bottom-24",
        open ? "translate-x-0" : "translate-x-[calc(100%+0.5rem)]",
      )}
    >
      <header className="border-border flex items-center justify-between border-b px-4 py-3">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <ListMusic className="text-primary size-4" />
          File de lecture
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Fermer la file de lecture"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground rounded-full"
        >
          <X />
        </Button>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        {items.length === 0 && skeletonCount === 0 ? (
          <p className="text-muted-foreground px-4 py-10 text-center text-sm">
            La file est vide. Lance un titre pour commencer.
          </p>
        ) : (
          <ul className="space-y-1 p-2">
            {items.map((track, index) => {
              const isCurrent = index === currentIndex;
              const isPlayed = index < currentIndex;
              // Le titre courant est déjà en lecture ; tout le reste est jouable :
              // les suivants sautent en avant, les précédents se rejouent (ils
              // restent dans la timeline, on ne bloque donc pas le clic).
              const clickable = !isCurrent;
              // Seuls les titres à venir sont retirables : ni le courant (il joue),
              // ni les joués (ils racontent ce qui a déjà été écouté).
              const removable = !isCurrent && !isPlayed && !!onRemove;
              return (
                <li
                  key={`${track.video_id}#${index}`}
                  ref={isCurrent ? currentRef : undefined}
                  className="group relative"
                >
                  <button
                    type="button"
                    aria-current={isCurrent ? "true" : undefined}
                    disabled={!clickable}
                    title={isPlayed ? "Rejouer ce titre" : undefined}
                    onClick={clickable ? () => onSelect?.(index) : undefined}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors",
                      removable && "pr-10",
                      clickable && "hover:bg-surface-hover cursor-pointer",
                      !clickable && "cursor-default",
                    )}
                  >
                    <span className="relative block size-10 shrink-0">
                      <TrackCover
                        videoId={track.video_id}
                        title={track.title}
                        sizes={coverSizes(40)}
                        className={cn("size-10", isPlayed && "opacity-60")}
                      />
                      <span
                        className={cn(
                          "absolute inset-0 grid place-items-center text-xs font-medium tabular-nums",
                          isCurrent
                            ? "text-primary bg-black/60"
                            : "bg-black/45",
                          isPlayed && "text-muted-foreground",
                        )}
                      >
                        {index + 1}
                      </span>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "block truncate text-sm font-medium",
                          isCurrent && "text-primary",
                          isPlayed && "text-muted-foreground/60",
                        )}
                      >
                        {track.title}
                      </span>
                      <span
                        className={cn(
                          "text-muted-foreground block truncate text-xs",
                          isPlayed && "text-muted-foreground/50",
                        )}
                      >
                        {track.channel}
                      </span>
                    </span>
                  </button>
                  {removable && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Retirer ${track.title} de la file`}
                      title="Retirer de la file"
                      onClick={() => onRemove?.(index, track.video_id)}
                      className="text-muted-foreground hover:text-foreground absolute top-1/2 right-1 -translate-y-1/2 rounded-full opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
                    >
                      <Trash2 />
                    </Button>
                  )}
                </li>
              );
            })}
            {skeletonCount > 0 &&
              Array.from({ length: skeletonCount }, (_, i) => (
                <li key={`sk-${itemCount + i}`}>
                  <div
                    className="flex items-center gap-3 rounded-lg p-2"
                    style={{ animationDelay: `${i * 70}ms` }}
                  >
                    <span className="bg-surface-hover size-10 shrink-0 animate-pulse rounded-md" />
                    <span className="flex-1 space-y-1.5">
                      <span className="bg-surface-hover block h-3 w-4/5 animate-pulse rounded-full" />
                      <span className="bg-surface-hover block h-2.5 w-1/3 animate-pulse rounded-full" />
                    </span>
                  </div>
                </li>
              ))}
          </ul>
        )}
      </ScrollArea>
    </aside>
    </>
  );
}
