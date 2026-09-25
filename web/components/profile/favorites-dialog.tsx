"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, X } from "lucide-react";

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
import { ScrollArea } from "@/components/ui/scroll-area";
import { useStore } from "@/lib/store";

/** Casse et accents ignorés, pour faire fusionner "GAZO" et "gazo". */
function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/** Palier de rendu : le DOM ne reçoit qu'une fenêtre, la donnée reste entière
 *  dans le store (aucune requête réseau). */
const PAGE = 40;

/**
 * Tous les artistes favoris, listés dans un modal.
 *
 * Même logique que les notes (recherche locale + roulement au scroll) : la
 * source est le store, on ne matérialise qu'un palier dans le DOM. Le retrait
 * passe par le parent (api + resync) ; la ligne est masquée en local pour un
 * feedback immédiat, le store se réconcilie ensuite.
 */
export function FavoritesDialog({
  open,
  onOpenChange,
  onRemove,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRemove: (channel: string) => void | Promise<void>;
}) {
  const { favorites } = useStore();
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  // Canaux retirés dans cette ouverture : masqués sans attendre la resync
  // réseau, réinitialisés à chaque ouverture.
  const [removed, setRemoved] = useState<string[]>([]);

  const { items, total } = useMemo(() => {
    const active = favorites.filter((channel) => !removed.includes(channel));
    const needle = normalize(query.trim());
    const source = needle
      ? active.filter((channel) => normalize(channel).includes(needle))
      : active;
    return { items: source.slice(0, limit), total: source.length };
  }, [query, favorites, limit, removed]);
  const finished = items.length >= total;

  function remove(channel: string) {
    setRemoved((prev) => [...prev, channel]);
    void onRemove(channel);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg"
        onOpenAutoFocus={() => {
          setQuery("");
          setLimit(PAGE);
          setRemoved([]);
        }}
      >
        <DialogHeader>
          <div className="space-y-1">
            <DialogTitle className="pr-8">Mes artistes favoris</DialogTitle>
            <DialogDescription>
              {favorites.length.toLocaleString("fr-FR")} artiste
              {favorites.length > 1 ? "s" : ""} favori
              {favorites.length > 1 ? "s" : ""} — une note ★ ≥ 4 ajoute
              l&apos;artiste automatiquement.
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Rechercher un artiste…"
            aria-label="Rechercher dans les artistes favoris"
          />

          {items.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {query.trim()
                ? "Aucun artiste ne correspond à cette recherche."
                : "Aucun favori pour l'instant. Note un titre ★ ≥ 4 pour ajouter son artiste ici."}
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
                {items.map((channel) => (
                  <li
                    key={channel}
                    className="group/row hover:bg-surface-hover flex items-center gap-3 rounded-xl p-2 transition-colors"
                  >
                    <span className="bg-background/60 text-muted-foreground grid size-9 shrink-0 place-items-center rounded-lg text-sm font-semibold">
                      {channel.charAt(0).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {channel}
                    </span>
                    <button
                      type="button"
                      aria-label={`Retirer ${channel} des favoris`}
                      onClick={() => remove(channel)}
                      className="text-muted-foreground hover:text-destructive shrink-0 rounded-full p-1.5"
                    >
                      <X className="size-4" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          )}

          {finished && items.length > 0 ? (
            <p className="text-muted-foreground flex items-center justify-center gap-1.5 text-xs">
              <CheckCircle2 className="size-3.5" aria-hidden="true" />
              Fin des artistes
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