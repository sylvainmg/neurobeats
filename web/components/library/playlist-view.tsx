"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  Download,
  HardDriveDownload,
  ListMusic,
  Loader2,
  Pencil,
  Play,
  Plus,
  Search,
  Smartphone,
  Trash2,
  X,
} from "lucide-react";

import { BackButton } from "@/components/ui/back-button";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  TransferDialog,
  useTransferTicket,
} from "@/components/library/transfer-dialog";
import { TrackCover } from "@/components/track-cover";
import { ApiError, api, type Track } from "@/lib/api";
import { usePlaylists } from "@/lib/playlists";
import { usePlaylistLocal } from "@/lib/use-playlist-local";
import { useOnline } from "@/lib/online";
import { coverSizes } from "@/lib/track";
import { cn } from "cn";

function formatDate(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
}

/** Détail d'une playlist : lecture, renommage, ajout/retrait de titres, suppression. */
export function PlaylistView({ playlistId }: { playlistId: string }) {
  const router = useRouter();
  // Les titres viennent du store partagé : la vue est toujours alignée sur le
  // réel (modifications par l'UI, par l'assistant ou depuis un autre onglet).
  const {
    playlist: cachedPlaylist,
    loadPlaylist,
    renamePlaylist,
    deletePlaylist,
    addTrack,
    removeTrack,
  } = usePlaylists();
  const playlist = cachedPlaylist(playlistId);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [editName, setEditName] = useState("");
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Track[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  // Index du titre dont le son se charge (le backend ne répond qu'au démarrage).
  const [pendingIndex, setPendingIndex] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const transfer = useTransferTicket(playlistId);
  // Téléchargement local : ce que ce poste garde sur son disque pour cette
  // playlist. `manquant` pilote le bouton, `estPret` la pastille par titre.
  const { local, downloading, download, estPret } = usePlaylistLocal(playlistId);
  // Hors ligne, aucun téléchargement ne peut aboutir : le bouton reste visible
  // (il annonce l'état réel) mais inerte, et le bandeau explique pourquoi.
  const online = useOnline();

  // Charge le détail tant que le store ne l'a pas (ou s'il est périmé).
  useEffect(() => {
    if (playlist) return;
    let active = true;
    void (async () => {
      try {
        await loadPlaylist(playlistId);
      } catch (err) {
        if (!active) return;
        if (err instanceof ApiError && err.status === 404) setNotFound(true);
        else setError(err instanceof Error ? err.message : "Playlist indisponible.");
      }
    })();
    return () => {
      active = false;
    };
  }, [playlist, playlistId, loadPlaylist]);

  async function submitRename() {
    const name = editName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await renamePlaylist(playlistId, name);
      setRenaming(false);
    } finally {
      setBusy(false);
    }
  }

  async function remove(videoId: string) {
    setBusy(true);
    try {
      await removeTrack(playlistId, videoId);
    } finally {
      setBusy(false);
    }
  }

  async function search(event: React.FormEvent) {
    event.preventDefault();
    const text = query.trim();
    if (!text) return;
    setSearching(true);
    try {
      setResults(await api.search(text, 6));
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  async function add(videoId: string) {
    setBusy(true);
    try {
      await addTrack(playlistId, videoId);
    } finally {
      setBusy(false);
    }
  }

  async function play(start = 0) {
    if (!playlist) return;
    // Le backend ne répond qu'une fois le son réellement démarré (résolution
    // yt-dlp + lecture) : on l'annonce au lieu de laisser l'écran muet.
    setPendingIndex(start);
    setError(null);
    try {
      await api.playPlaylist(playlist.id, start);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lecture impossible.");
    } finally {
      setPendingIndex(null);
    }
  }

  if (!playlist && !notFound && !error) {
    return (
      <div className="space-y-8 py-6">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-end">
          <span className="bg-surface-hover aspect-square w-40 shrink-0 animate-pulse rounded-lg" />
          <div className="space-y-3">
            <span className="bg-surface-hover block h-3 w-16 animate-pulse rounded-full" />
            <span className="bg-surface-hover block h-9 w-56 animate-pulse rounded-lg" />
          </div>
        </div>
      </div>
    );
  }

  if (notFound || !playlist) {
    return (
      <div className="text-muted-foreground py-16 text-center text-sm">
        {notFound ? "Cette playlist n'existe pas ou a été supprimée." : error}
      </div>
    );
  }

  const songs = playlist.songs ?? [];
  const cover = songs[0]?.video_id ?? "";

  return (
    <div className="space-y-8 py-6">
      {/* Retour à la bibliothèque : cet écran est atteint depuis la grille/sidebar. */}
      <BackButton href="/library" />

      <header className="flex flex-col gap-6 sm:flex-row sm:items-end">
        <span className="relative block aspect-square w-40 shrink-0 overflow-hidden rounded-lg">
          {cover ? (
            <TrackCover videoId={cover} title={playlist.name} sizes={coverSizes(160)} className="size-full" hq />
          ) : (
            <span className="bg-surface-hover flex size-full items-center justify-center">
              <ListMusic className="text-muted-foreground size-8" />
            </span>
          )}
        </span>

        <div className="min-w-0 space-y-3">
          <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
            Playlist
          </p>

          {renaming ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submitRename();
              }}
              className="flex items-center gap-2"
            >
              <input
                autoFocus
                value={editName}
                onChange={(event) => setEditName(event.target.value)}
                aria-label="Nouveau nom de la playlist"
                className="bg-surface-hover text-foreground h-11 min-w-0 flex-1 rounded-lg px-3 text-2xl font-bold outline-none"
              />
              <Button type="submit" size="icon" aria-label="Valider" disabled={busy || !editName.trim()}>
                <Check className="size-4" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label="Annuler"
                onClick={() => setRenaming(false)}
              >
                <X className="size-4" />
              </Button>
            </form>
          ) : (
            <h1 className="truncate text-4xl font-bold tracking-tight">{playlist.name}</h1>
          )}

          <p className="text-muted-foreground text-sm">
            {songs.length} titre{songs.length > 1 ? "s" : ""}
            {playlist.mood ? ` · ${playlist.mood}` : ""}
            {playlist.created ? ` · créée le ${formatDate(playlist.created)}` : ""}
            {/* L'état local se dit dans la même ligne que le compte : « 12
                titres, 4 sur cet appareil » est l'information qui décide si un
                téléchargement est utile. */}
            {local && local.pret > 0
              ? ` · ${local.pret} sur cet appareil${
                  local.manquant > 0 ? `, ${local.manquant} à télécharger` : ""
                }`
              : ""}
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              className="rounded-full"
              size="lg"
              disabled={songs.length === 0 || pendingIndex !== null}
              onClick={() => void play(0)}
            >
              {pendingIndex !== null ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <Play className="fill-current" />
              )}
              {pendingIndex !== null ? "Chargement…" : "Lecture"}
            </Button>
            {/* Téléchargement local : le libellé porte le compte, donc le
                bouton dit ce qu'il va faire et non « peut-être ». Compléter un
                téléchargement en cours est toujours possible (il ne relance que
                les titres absents) ; hors ligne, le geste ne peut pas aboutir. */}
            {songs.length > 0 && (
              <Button
                variant="secondary"
                size="lg"
                className="rounded-full"
                disabled={!online || downloading || (local?.manquant ?? songs.length) === 0}
                title={
                  !online
                    ? "Téléchargement impossible hors ligne"
                    : local?.manquant === 0
                      ? "Tous les titres sont sur cet appareil"
                      : undefined
                }
                onClick={() => void download()}
              >
                {downloading ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : (
                  <Download aria-hidden="true" />
                )}
                {downloading
                  ? "Téléchargement…"
                  : local?.manquant === 0
                    ? "Téléchargée"
                    : local && local.pret > 0
                      ? `Compléter (${local.manquant})`
                      : "Télécharger"}
              </Button>
            )}
            <Button
              variant="ghost"
              size="lg"
              className="rounded-full"
              onClick={() => {
                if (adding) {
                  // Fermeture : on repart d'une recherche vierge.
                  setQuery("");
                  setResults([]);
                  setAdding(false);
                } else {
                  setAdding(true);
                }
              }}
            >
              <Plus />
              Ajouter des titres
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setTransferOpen(true);
                void transfer.start();
              }}
              disabled={!playlist.songs.length}
            >
              <Smartphone />
              Transférer vers le téléphone
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Renommer la playlist"
              onClick={() => {
                setEditName(playlist.name);
                setRenaming(true);
              }}
            >
              <Pencil className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Supprimer la playlist"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>
      </header>

      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}

      {adding && (
        <section className="bg-surface space-y-3 rounded-xl p-4">
          <form onSubmit={search} className="flex items-center gap-2">
            <Search className="text-muted-foreground size-4 shrink-0" />
            <input
              value={query}
              onChange={(event) => {
                const value = event.target.value;
                setQuery(value);
                // Champ vidé : on retire les suggestions précédentes (sinon elles
                // restent affichées alors qu'elles ne correspondent plus à rien).
                if (!value.trim()) setResults([]);
              }}
              placeholder="Rechercher un titre à ajouter…"
              aria-label="Rechercher un titre à ajouter"
              className="bg-surface-hover text-foreground placeholder:text-muted-foreground h-9 min-w-0 flex-1 rounded-full px-4 text-sm outline-none"
            />
            <Button type="submit" size="sm" disabled={searching || !query.trim()}>
              Chercher
            </Button>
          </form>

          {results.length > 0 && (
            <ul className="space-y-1">
              {results.map((track) => {
                const already = songs.some((s) => s.video_id === track.video_id);
                return (
                  <li
                    key={track.video_id}
                    className="hover:bg-surface-hover flex items-center gap-3 rounded-lg p-2"
                  >
                    <TrackCover
                      videoId={track.video_id}
                      title={track.title}
                      sizes={coverSizes(40)}
                      className="size-10 shrink-0"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{track.title}</span>
                      <span className="text-muted-foreground block truncate text-xs">
                        {track.channel}
                      </span>
                    </span>
                    <Button
                      size="sm"
                      variant={already ? "ghost" : "default"}
                      disabled={already || busy}
                      onClick={() => void add(track.video_id)}
                    >
                      {already ? "Déjà ajouté" : "Ajouter"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {/* Annonce pour les lecteurs d'écran : la ligne porte déjà le spinner,
          mais un `role="status"` reste la seule chose que le narrateur lit
          quand le focus est ailleurs. On ne répète pas le visuel complet. */}
      {pendingIndex !== null && pendingIndex < songs.length && (
        <p role="status" className="sr-only">
          Chargement de {songs[pendingIndex]?.title}…
        </p>
      )}

      {songs.length === 0 ? (
        <div className="text-muted-foreground bg-surface rounded-lg p-8 text-center text-sm">
          Cette playlist est vide. Ajoute des titres depuis la recherche.
        </div>
      ) : (
        <ul className="space-y-1">
          {songs.map((song, index) => {
            const isPending = pendingIndex === index;
            return (
              <li
                key={song.video_id}
                className="group hover:bg-surface-hover flex items-center gap-3 rounded-lg p-2"
              >
                <button
                  type="button"
                  onClick={() => void play(index)}
                  disabled={pendingIndex !== null}
                  aria-busy={isPending || undefined}
                  aria-label={
                    isPending ? `Chargement de ${song.title}` : `Lire ${song.title}`
                  }
                  className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-wait"
                >
                  <span className="text-muted-foreground w-5 shrink-0 text-right text-xs tabular-nums">
                    {index + 1}
                  </span>
                  <span className="relative size-10 shrink-0">
                    <TrackCover
                      videoId={song.video_id}
                      title={song.title}
                      sizes={coverSizes(40)}
                      className="size-10"
                    />
                    {/* Le titre demandé porte le seul indicateur animé : on sait
                        lequel charge, même dans une longue playlist. Le voile est
                        celui de l'historique d'écoute, pour que le geste se lise
                        pareil partout. */}
                    <span
                      className={cn(
                        "bg-background/60 absolute inset-0 grid place-items-center rounded-lg transition-opacity",
                        isPending ? "opacity-100" : "opacity-0",
                      )}
                    >
                      <Loader2 className="text-primary size-4 animate-spin" aria-hidden="true" />
                    </span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block truncate text-sm font-medium",
                        isPending && "text-primary",
                      )}
                    >
                      {song.title}
                    </span>
                    <span className="text-muted-foreground block truncate text-xs">
                      {/* Le sous-titre bascule sur l'état, comme dans l'historique :
                          l'utilisateur sait que le clic a pris, et non qu'il a
                          échoué, tant que le son n'a pas démarré. */}
                      {isPending ? "Chargement du titre…" : song.channel}
                    </span>
                  </span>
                  {/* Pastille « sur cet appareil » : le seul endroit où l'on voit
                      d'un coup d'œil ce qu'on peut écouter sans réseau. Discrète
                      (jamais une couleur alone), elle vaut pour le fichier
                      réellement présent sur le disque. */}
                  {local && estPret(song.video_id) && (
                    <span
                      title="Sur cet appareil — écoutable hors ligne"
                      className="bg-primary/15 text-primary inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
                    >
                      <HardDriveDownload className="size-3" aria-hidden="true" />
                      Sur cet appareil
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  aria-label={`Retirer ${song.title} de la playlist`}
                  disabled={busy}
                  onClick={() => void remove(song.video_id)}
                  className="text-muted-foreground hover:text-destructive shrink-0 rounded-full p-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-40 max-md:opacity-100 pointer-coarse:opacity-100"
                >
                  <X className="size-4" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <TransferDialog
        open={transferOpen}
        onOpenChange={setTransferOpen}
        ticket={transfer.ticket}
        error={transfer.error}
        pending={transfer.pending}
        onRetry={() => void transfer.start()}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Supprimer « ${playlist.name} » ?`}
        description={`Cette playlist et ses ${songs.length} titre${songs.length > 1 ? "s" : ""} seront définitivement supprimés.`}
        onConfirm={async () => {
          await deletePlaylist(playlist.id);
          router.push("/library");
        }}
      />
    </div>
  );
}
