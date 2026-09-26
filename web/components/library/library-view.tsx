"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ListMusic, Pencil, Plus, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TrackCover } from "@/components/track-cover";
import { usePlaylists } from "@/lib/playlists";
import { coverSizes } from "@/lib/track";
import { cn } from "cn";

/** Grille des playlists : création, renommage en ligne, suppression. */
export function LibraryView() {
  const router = useRouter();
  const { playlists, loading, error, createPlaylist, renamePlaylist, deletePlaylist } =
    usePlaylists();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const target = playlists.find((p) => p.id === pendingDelete) ?? null;

  async function submitCreate() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const created = await createPlaylist(name);
      setNewName("");
      setCreating(false);
      if (created?.id) router.push(`/playlists/${created.id}`);
    } finally {
      setBusy(false);
    }
  }

  async function submitRename(id: string) {
    const name = editName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await renamePlaylist(id, name);
      setEditingId(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-8 py-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <ListMusic className="text-primary size-7" />
          <h1 className="text-3xl font-bold tracking-tight">Bibliothèque</h1>
        </div>
        <Button
          onClick={() => setCreating((value) => !value)}
          className="hidden rounded-full sm:inline-flex"
        >
          <Plus className="size-4" />
          Nouvelle playlist
        </Button>
      </div>

      <section>
        <h2 className="mb-4 text-lg font-semibold">Tes playlists</h2>

        {error && (
          <p role="alert" className="text-destructive mb-4 text-sm">
            {error}
          </p>
        )}

        {loading ? (
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <li key={i} className="bg-surface rounded-xl p-3">
                <span className="bg-surface-hover mb-3 block aspect-square w-full animate-pulse rounded-md" />
                <span className="bg-surface-hover block h-3.5 w-3/4 animate-pulse rounded-full" />
              </li>
            ))}
          </ul>
        ) : (
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {/* Carte de création */}
            <li>
              {creating ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitCreate();
                  }}
                  className="border-border bg-surface flex h-full min-h-40 flex-col justify-center gap-2 rounded-xl border border-dashed p-3"
                >
                  <input
                    autoFocus
                    value={newName}
                    onChange={(event) => setNewName(event.target.value)}
                    placeholder="Nom de la playlist…"
                    aria-label="Nom de la nouvelle playlist"
                    className="bg-surface-hover text-foreground placeholder:text-muted-foreground h-9 rounded-lg px-3 text-sm outline-none"
                  />
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" disabled={busy || !newName.trim()}>
                      <Check className="size-4" />
                      Créer
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setCreating(false)}
                    >
                      Annuler
                    </Button>
                  </div>
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="border-border text-muted-foreground hover:border-primary/60 hover:text-foreground flex h-full min-h-40 w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-3 transition-colors"
                >
                  <Plus className="size-6" />
                  <span className="text-sm font-medium">Nouvelle playlist</span>
                </button>
              )}
            </li>

            {playlists.map((playlist) => {
              const href = `/playlists/${playlist.id}`;
              const editing = editingId === playlist.id;
              return (
                <li
                  key={playlist.id}
                  className="group bg-surface border-border hover:bg-surface-hover relative rounded-xl border border-transparent p-3 transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => router.push(href)}
                    className="block w-full text-left"
                  >
                    <span className="relative mb-3 block aspect-square w-full overflow-hidden rounded-md">
                      {playlist.cover ? (
                        <TrackCover
                          videoId={playlist.cover}
                          title={playlist.name}
                          sizes={coverSizes(200)}
                          className="size-full"
                          source="auto"
                        />
                      ) : (
                        <span className="bg-surface-hover flex size-full items-center justify-center">
                          <ListMusic className="text-muted-foreground size-6" />
                        </span>
                      )}
                    </span>
                    {!editing && (
                      <>
                        <span className="text-foreground block truncate text-sm font-medium">
                          {playlist.name}
                        </span>
                        <span className="text-muted-foreground block truncate text-xs">
                          {playlist.count} titre{playlist.count > 1 ? "s" : ""}
                          {playlist.mood ? ` · ${playlist.mood}` : ""}
                        </span>
                      </>
                    )}
                  </button>

                  {editing ? (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void submitRename(playlist.id);
                      }}
                      className="absolute inset-x-3 bottom-3 flex items-center gap-1"
                    >
                      <input
                        autoFocus
                        value={editName}
                        onChange={(event) => setEditName(event.target.value)}
                        aria-label="Nouveau nom de la playlist"
                        className="bg-surface-hover text-foreground h-8 min-w-0 flex-1 rounded-lg px-2 text-sm outline-none"
                      />
                      <button
                        type="submit"
                        aria-label="Valider le renommage"
                        disabled={busy || !editName.trim()}
                        className="text-muted-foreground hover:text-foreground disabled:opacity-40"
                      >
                        <Check className="size-4" />
                      </button>
                      <button
                        type="button"
                        aria-label="Annuler le renommage"
                        onClick={() => setEditingId(null)}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <X className="size-4" />
                      </button>
                    </form>
                  ) : (
                    <div className="absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 max-md:opacity-100 pointer-coarse:opacity-100">
                      <button
                        type="button"
                        aria-label={`Renommer la playlist « ${playlist.name} »`}
                        onClick={() => {
                          setEditingId(playlist.id);
                          setEditName(playlist.name);
                        }}
                        className="bg-background/80 text-muted-foreground hover:text-foreground rounded-full p-1.5"
                      >
                        <Pencil className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Supprimer la playlist « ${playlist.name} »`}
                        onClick={() => setPendingDelete(playlist.id)}
                        className="bg-background/80 text-muted-foreground hover:text-destructive rounded-full p-1.5"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {!loading && playlists.length === 0 && !creating && (
          <p className={cn("text-muted-foreground mt-4 text-sm")}>
            Aucune playlist pour l&apos;instant. Crée-en une pour commencer.
          </p>
        )}
      </section>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null);
        }}
        title={target ? `Supprimer « ${target.name} » ?` : "Supprimer la playlist ?"}
        description={
          target
            ? `Cette playlist et ses ${target.count} titre${target.count > 1 ? "s" : ""} seront définitivement supprimés.`
            : "Cette action est définitive."
        }
        onConfirm={async () => {
          if (pendingDelete) await deletePlaylist(pendingDelete);
          setPendingDelete(null);
        }}
      />
    </div>
  );
}
