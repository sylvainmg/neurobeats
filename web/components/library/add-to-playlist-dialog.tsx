"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Minus, Plus } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { TrackCover } from "@/components/track-cover";
import { usePlaylists } from "@/lib/playlists";
import { coverSizes } from "@/lib/track";
import { cn } from "cn";

export interface AddableTrack {
  video_id: string;
  title: string;
  channel: string;
}

/**
 * Modal « Ajouter à une playlist » (style Spotify) : liste les playlists du
 * store partagé et permet d'en créer une à la volée pour y ranger le son en
 * cours.
 *
 * Une playlist qui contient déjà le titre n'est plus une cible d'ajout :
 * l'action bascule sur « Retirer », ce qui évite un aller-retour pour revenir en
 * arrière. `contains` vient du même store que le reste de la liste — l'état
 * affiché et l'action proposée partagent donc une seule source de vérité.
 */
export function AddToPlaylistDialog({
  open,
  onOpenChange,
  track,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  track: AddableTrack | null;
}) {
  const { playlists, loading, refresh, createPlaylist, addTrack, removeTrack } =
    usePlaylists();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  // Garde synchrone : deux clics rapides ne doivent pas déclencher deux
  // mutations (l'état `busyId` ne bloque pas un second clic dans le même tick).
  const inFlight = useRef(false);

  const videoId = track?.video_id ?? "";

  // À l'ouverture : rafraîchit les résumés avec `contains` pour le titre courant.
  useEffect(() => {
    if (!open || !videoId) return;
    let active = true;
    void (async () => {
      await refresh(videoId);
      if (!active) return;
    })();
    return () => {
      active = false;
    };
  }, [open, videoId, refresh]);

  /**
   * Affiche un retour sans fermer le dialogue.
   *
   * Réservé au retrait : on reste ouvert parce qu'on enchaîne généralement
   * plusieurs retraits, et que la ligne vient de rebasculer sur « Ajouter » —
   * la refermer ferait perdre la vue de ce qu'on vient de modifier.
   */
  const announce = useCallback((message: string) => {
    setFeedback(message);
  }, []);

  /**
   * Affiche un retour puis referme.
   *
   * Réservé à l'ajout : une fois le titre rangé, il n'y a plus rien à décider
   * dans cette liste. Le délai laisse lire le message avant la fermeture.
   */
  const closeSoon = useCallback(
    (message: string) => {
      announce(message);
      window.setTimeout(() => onOpenChange(false), 700);
    },
    [announce, onOpenChange],
  );

  /** À la fermeture, on repart d'un état vierge pour la prochaine ouverture. */
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        setFeedback(null);
        setCreating(false);
        setNewName("");
        setBusyId(null);
      }
      onOpenChange(next);
    },
    [onOpenChange],
  );

  async function addTo(id: string, name: string) {
    if (!videoId || inFlight.current) return;
    inFlight.current = true;
    setBusyId(id);
    setFeedback(null);
    try {
      // Le store écrit la playlist renvoyée par le serveur : la coche et le
      // compteur se mettent à jour partout, sans rechargement.
      const result = await addTrack(id, videoId);
      if (result.status === "already_present") setFeedback(`Déjà dans « ${name} »`);
      else closeSoon(`Ajouté à « ${name} »`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : "Ajout impossible.");
    } finally {
      inFlight.current = false;
      setBusyId(null);
    }
  }

  async function removeFrom(id: string, name: string) {
    if (!videoId || inFlight.current) return;
    inFlight.current = true;
    setBusyId(id);
    setFeedback(null);
    try {
      // Même source de vérité que l'ajout : le store remplace la playlist par
      // celle du serveur, donc l'état « déjà présent » disparaît et le compteur
      // redescend. Le dialogue reste ouvert : l'utilisateur peut retirer le
      // titre d'une autre playlist sans rouvrir.
      await removeTrack(id, videoId);
      announce(`Retiré de « ${name} »`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : "Retrait impossible.");
    } finally {
      inFlight.current = false;
      setBusyId(null);
    }
  }

  async function createAndAdd() {
    const name = newName.trim();
    if (!name || !videoId || inFlight.current) return;
    inFlight.current = true;
    setBusyId("new");
    setFeedback(null);
    try {
      const playlist = await createPlaylist(name);
      if (playlist) {
        await addTrack(playlist.id, videoId);
        closeSoon(`Ajouté à « ${playlist.name} »`);
      }
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : "Création impossible.");
    } finally {
      inFlight.current = false;
      setBusyId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent aria-describedby="add-to-playlist-desc">
        <DialogHeader>
          <DialogTitle>Ajouter à une playlist</DialogTitle>
          <DialogDescription id="add-to-playlist-desc">
            {track
              ? "Ajoute le titre à une playlist, ou retire-le de celles qui le contiennent déjà."
              : "Aucun titre en cours."}
          </DialogDescription>

          {track && (
            <div className="mt-3 flex items-center gap-3">
              <TrackCover
                videoId={track.video_id}
                title={track.title}
                sizes={coverSizes(40)}
                className="size-10 shrink-0"
              />
              <span className="min-w-0">
                <span className="text-foreground block truncate text-sm font-medium">
                  {track.title}
                </span>
                <span className="text-muted-foreground block truncate text-xs">
                  {track.channel}
                </span>
              </span>
            </div>
          )}
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {loading && playlists.length === 0 ? (
            <p className="text-muted-foreground px-3 py-6 text-center text-sm">
              <Loader2 className="mx-auto size-4 animate-spin" />
            </p>
          ) : playlists.length === 0 ? (
            <p className="text-muted-foreground px-3 py-6 text-center text-sm">
              Aucune playlist pour l&apos;instant — crée-en une ci-dessous.
            </p>
          ) : (
            <ul className="space-y-1">
              {playlists.map((playlist) => {
                // `contains` est undefined tant que le rafraîchissement d'ouverture
                // n'est pas terminé : dans ce cas on laisse l'action d'ajout, qui
                // reste sûre (le backend refuse un doublon).
                const present = playlist.contains === true;
                const busy = busyId === playlist.id;
                return (
                  <li key={playlist.id}>
                    <div
                      className={cn(
                        "flex w-full items-center gap-3 rounded-lg p-2 transition-colors",
                        present && "bg-surface-hover/40",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() =>
                          void (present
                            ? removeFrom(playlist.id, playlist.name)
                            : addTo(playlist.id, playlist.name))
                        }
                        disabled={busyId !== null}
                        aria-label={
                          present
                            ? `Retirer « ${track?.title ?? "ce titre"} » de la playlist ${playlist.name}`
                            : `Ajouter « ${track?.title ?? "ce titre"} » à la playlist ${playlist.name}`
                        }
                        className={cn(
                          "flex min-w-0 flex-1 items-center gap-3 text-left",
                          !present && "hover:bg-surface-hover cursor-pointer rounded-md",
                          present && "cursor-pointer",
                        )}
                      >
                        <span className="relative block size-10 shrink-0 overflow-hidden rounded-md">
                          {playlist.cover ? (
                            <TrackCover
                              videoId={playlist.cover}
                              title={playlist.name}
                              sizes={coverSizes(40)}
                              className="size-10"
                            />
                          ) : (
                            <span className="bg-surface-hover block size-10" />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span
                            className={cn(
                              "block truncate text-sm font-medium",
                              present ? "text-muted-foreground" : "text-foreground",
                            )}
                          >
                            {playlist.name}
                          </span>
                          <span className="text-muted-foreground block truncate text-xs">
                            {present
                              ? "Déjà dans cette playlist"
                              : `${playlist.count} titre${playlist.count > 1 ? "s" : ""}`}
                          </span>
                        </span>
                      </button>

                      <span className="flex shrink-0 items-center gap-1 pr-1">
                        {busy ? (
                          <Loader2 className="text-muted-foreground size-4 animate-spin" />
                        ) : present ? (
                          <>
                            <span className="text-muted-foreground text-xs">Retirer</span>
                            <Minus className="text-muted-foreground size-4" />
                          </>
                        ) : (
                          <>
                            <span className="text-muted-foreground text-xs">Ajouter</span>
                            <Plus className="text-muted-foreground size-4" />
                          </>
                        )}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="border-border space-y-2 border-t p-3">
          {feedback && (
            <p aria-live="polite" className="text-primary text-xs">
              {feedback}
            </p>
          )}

          {creating ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void createAndAdd();
              }}
              className="flex items-center gap-2"
            >
              <input
                autoFocus
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder="Nom de la nouvelle playlist…"
                aria-label="Nom de la nouvelle playlist"
                className="bg-surface-hover text-foreground placeholder:text-muted-foreground h-9 min-w-0 flex-1 rounded-full px-4 text-sm outline-none"
              />
              <Button type="submit" size="sm" disabled={!newName.trim() || busyId !== null}>
                Créer et ajouter
              </Button>
            </form>
          ) : (
            <Button
              variant="ghost"
              onClick={() => setCreating(true)}
              className="w-full justify-start rounded-full"
              disabled={!track}
            >
              <Plus className="size-4" />
              Nouvelle playlist
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
