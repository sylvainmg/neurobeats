"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { CheckCircle2, Loader2, Play, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TrackCover } from "@/components/track-cover";
import { usePlayer } from "@/components/player/player-context";
import { api, type HistoryEntry } from "@/lib/api";
import { coverSizes } from "@/lib/track";
import { cn } from "cn";

/** Casse et accents ignorés, pour faire fusionner "GAZO" et "gazo". */
function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/**
 * Ne garde que la dernière occurrence de chaque titre parmis celles chargées.
 *
 * Les pages arrivent du plus récent au plus ancien (`ORDER BY id DESC`), chaque
 * page dans l'ordre : garder la première occurrence d'un titre donne donc son
 * écoute la plus récente, les doublons (relances) des pages suivantes tombent.
 */
function uniqueTitles(entries: HistoryEntry[]): HistoryEntry[] {
  const seen = new Set<string>();
  const out: HistoryEntry[] = [];
  for (const entry of entries) {
    const key = normalize(entry.title || "") || entry.video_id;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/** Moment de la dernière écoute : « aujourd'hui · 18:04 », « hier · 09:12 »… */
function listenedLabel(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const startOfDay = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  const time = date.toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (days === 0) return `aujourd'hui · ${time}`;
  if (days === 1) return `hier · ${time}`;
  return `${date.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} · ${time}`;
}

/** Taille de page : assez pour un écran, assez léger pour ne pas tout rendre. */
const PAGE = 100;

/**
 * Historique complet, listé dans un modal, chargé par pagination.
 *
 * Le modal est propriétaire de son chargement : chaque page arrive via
 * `GET /api/profile/history?limit=100&offset=…`, déclenchée au roulement de
 * la liste (scroll infini). Seules les pages visibles sont matérialisées dans
 * le DOM — pas 700 lignes d'un coup. Les titres rejoués ne comptent qu'une
 * fois (dédoublonnage à la volée, correct puisque les pages sont ordonnées du
 * plus récent au plus ancien) et le clic lance la lecture comme un résultat de
 * recherche.
 */
export function HistoryDialog({
  open,
  onOpenChange,
  totalPlays,
  onRemove,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Nombre d'écoutes totales (compteur du profil) pour l'en-tête du modal. */
  totalPlays: number;
  onRemove: (entryId: number) => void | Promise<void>;
}) {
  const { play, state } = usePlayer();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Titre en cours de lancement : le clic engage, mais le serveur répond en
  // plusieurs secondes — la ligne cliquée porte donc le feedback (« spiner »
  // + libellé) tant que la lecture n'a pas abouti.
  const [loadingId, setLoadingId] = useState<string | null>(null);
  // Reflets de l'état dans les fermetures de `loadMore`/scroll : un guard par
  // ref, sinon deux scrolls simultanés empileraient les requêtes.
  const loadingRef = useRef(false);
  const offsetRef = useRef(0);
  const finishedRef = useRef(false);

  const loadMore = useCallback(async () => {
    if (loadingRef.current || finishedRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const res = await api.profileHistory(PAGE, offsetRef.current);
      const chunk = res.entries ?? [];
      if (chunk.length === 0) {
        finishedRef.current = true;
        setFinished(true);
        return;
      }
      offsetRef.current += chunk.length;
      setItems((prev) => {
        // Aucun chevauchement attendu (les ids sont uniques par page) ; le
        // filtre garde la liste saine si une suppression a eu lieu entre-temps.
        const known = new Set(prev.map((entry) => entry.id));
        return [...prev, ...chunk.filter((entry) => !known.has(entry.id))];
      });
      setError(null);
      if (chunk.length < PAGE) {
        finishedRef.current = true;
        setFinished(true);
      }
    } catch {
      setError("Impossible de charger la suite de l'historique — réessaie.");
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, []);

  const resetAndLoad = useCallback(async () => {
    offsetRef.current = 0;
    loadingRef.current = false;
    finishedRef.current = false;
    setItems([]);
    setFinished(false);
    setError(null);
    await loadMore();
  }, [loadMore]);

  // Dédoublonnage sur les pages chargées, recherche sur les titres uniques.
  const unique = useMemo(() => uniqueTitles(items), [items]);
  const shown = useMemo(() => {
    const needle = normalize(query.trim());
    if (!needle) return unique;
    return unique.filter((entry) =>
      normalize(`${entry.title ?? ""} ${entry.channel ?? ""}`).includes(needle),
    );
  }, [unique, query]);

  const currentId = state?.video_id;
  // Dernier titre lancé : seule la ligne du lancement le plus récent porte le
  // feedback — la résolution d'une lecture annulée (supplantée par un clic
  // suivant) ne doit pas couper l'indicateur de la nouvelle.
  const launchRef = useRef<string | null>(null);

  /** Lance une écoute ; la ligne cliquée reste en « chargement » jusqu'à la
   * résolution de la lecture (bonne ou échouée — l'erreur est alors portée
   * par le lecteur, la ligne redevient cliquable). Un second clic annule la
   * requête précédente (abort du lecteur) : seul le dernier choix est joué. */
  function launch(entry: HistoryEntry) {
    launchRef.current = entry.video_id;
    setLoadingId(entry.video_id);
    void play(entry.video_id).finally(() => {
      if (launchRef.current === entry.video_id) setLoadingId(null);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Ouverture externe (bouton de la carte) : en mode contrôlé, Radix
          n'appelle jamais `onOpenChange(true)` — seulement les fermetures
          (Escape, voile). Le rechargement tient donc à l'événement d'ouverture
          du contenu, qui se déclenche à chaque montée de `open`. */}
      <DialogContent
        className="max-w-lg"
        onOpenAutoFocus={() => {
          setQuery("");
          void resetAndLoad();
        }}
      >
        <DialogHeader>
          <div className="space-y-1">
            <DialogTitle className="pr-8">Historique d’écoute</DialogTitle>
            <DialogDescription>
              {unique.length.toLocaleString("fr-FR")} titre
              {unique.length > 1 ? "s" : ""} chargé
              {unique.length > 1 ? "s" : ""} ·{" "}
              {totalPlays.toLocaleString("fr-FR")} écoute
              {totalPlays > 1 ? "s" : ""} au total. Clique sur un titre pour le
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
            aria-label="Rechercher dans l'historique"
          />

          {loading && unique.length === 0 ? (
            <p className="text-muted-foreground animate-pulse text-sm">
              Chargement de l’historique…
            </p>
          ) : shown.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {query.trim()
                ? "Aucun titre chargé ne correspond à cette recherche."
                : "Aucune écoute enregistrée. Lance un titre depuis la recherche ou l’accueil."}
            </p>
          ) : (
            <ScrollArea
              className="h-[50dvh]"
              onScroll={(event) => {
                const viewport = event.currentTarget;
                const nearBottom =
                  viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <
                  240;
                if (nearBottom && !loadingRef.current && !finishedRef.current) {
                  void loadMore();
                }
              }}
            >
              <ul className="space-y-0.5 pr-3">
                {shown.map((entry) => {
                  const isCurrent = currentId === entry.video_id;
                  const isLoading = loadingId === entry.video_id;
                  return (
                    <li key={entry.id} className="group relative">
                      <button
                        type="button"
                        onClick={() => {
                          if (isLoading) return;
                          launch(entry);
                        }}
                        aria-current={isCurrent ? "true" : undefined}
                        aria-busy={isLoading || undefined}
                        className="hover:bg-surface-hover focus-visible:ring-ring/60 flex w-full items-center gap-3 rounded-xl p-2 pr-9 text-left transition-colors focus-visible:ring-3 focus-visible:outline-none"
                      >
                        <span className="relative shrink-0">
                          <TrackCover
                            videoId={entry.video_id}
                            title={entry.title}
                            sizes={coverSizes(44)}
                            rounded="rounded-md"
                            className="size-11"
                          />
                          {/* Affordance de lecture, façon recherche au survol ;
                              spinner permanent sur la ligne en cours de chargement. */}
                          <span
                            className={cn(
                              "bg-primary text-primary-foreground absolute inset-0 grid place-items-center rounded-md transition-opacity",
                              isLoading
                                ? "opacity-100"
                                : "opacity-0 group-hover:opacity-100",
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
                            {entry.title || entry.video_id}
                          </span>
                          <span className="text-muted-foreground block truncate text-xs">
                            {isLoading
                              ? "Chargement du titre…"
                              : `${entry.channel} · ${listenedLabel(entry.timestamp)}`}
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-label={`Retirer l'écoute de ${entry.title || entry.video_id}`}
                        onClick={() => {
                          setItems((prev) => prev.filter((e) => e.id !== entry.id));
                          void onRemove(entry.id);
                        }}
                        className="text-muted-foreground hover:bg-surface-hover hover:text-destructive absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100 pointer-coarse:opacity-100"
                      >
                        <X className="size-4" aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </ScrollArea>
          )}

          {error ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void loadMore()}
              className="text-destructive mx-auto flex items-center gap-1.5 rounded-full text-xs"
            >
              {error}
            </Button>
          ) : loading ? (
            <p
              role="status"
              className="text-muted-foreground animate-pulse text-center text-xs"
            >
              Chargement de la suite…
            </p>
          ) : finished ? (
            <p className="text-muted-foreground flex items-center justify-center gap-1.5 text-xs">
              <CheckCircle2 className="size-3.5" aria-hidden="true" />
              Fin de l’historique
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