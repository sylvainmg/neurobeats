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
import { LocalFilter, correspond } from "@/components/library/local-filter";
import { usePlayer } from "@/components/player/player-context";
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
  return date.toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** Détail d'une playlist : lecture, renommage, ajout/retrait de titres, suppression. */
export function PlaylistView({ playlistId }: { playlistId: string }) {
  const router = useRouter();
  // L'état temps réel du lecteur, seul à savoir quel titre est réellement en
  // cours : `pendingIndex` retombe à null dès que le son démarre, donc sans
  // lui la ligne jouée perdrait tout marquage.
  const { state: nowPlaying } = usePlayer();
  const currentId = nowPlaying?.video_id ?? "";
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
  // Recherche pour AJOUTER un titre (réseau, backend). Distincte de
  // `filtreTitres`, qui ne fait que trier l'affichage de la liste en place.
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Track[]>([]);
  const [searching, setSearching] = useState(false);
  const [filtreTitres, setFiltreTitres] = useState("");
  const [busy, setBusy] = useState(false);
  // Index du titre dont le son se charge (le backend ne répond qu'au démarrage).
  const [pendingIndex, setPendingIndex] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const transfer = useTransferTicket(playlistId);
  // Téléchargement local : ce que ce poste garde sur son disque pour cette
  // playlist. `manquant` pilote le bouton, `estPret` la pastille par titre.
  const { local, downloading, download, estPret } =
    usePlaylistLocal(playlistId);
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
        else
          setError(
            err instanceof Error ? err.message : "Playlist indisponible.",
          );
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

  // Compte de téléchargement, déduit de l'état local ET de la playlist affichée.
  //
  // Le seul `local` ne suffit pas : tant que le premier GET n'est pas revenu il
  // est `null`, et `local.manquant === 0` ferait afficher « Téléchargée » alors
  // qu'on n'a rien vérifié du tout. `songs.length` sert donc de plancher — tant
  // qu'on ignore lesquels des titres sont sur le disque, tout est à traiter.
  //
  // Ces valeurs sont calculées AVANT les retours anticipés : elles ne dépendent
  // que d'un store, jamais de `playlist`, et le reste du composant s'en sert.
  const songs = playlist?.songs ?? [];
  // Ce que la liste affiche. `songs` reste la référence pour les compteurs :
  // filtrer ne change pas le nombre réel de titres, seulement ceux visibles.
  const songsVisibles = filtreTitres
    ? songs.filter((song) => correspond(filtreTitres, song.title, song.channel))
    : songs;
  // videoId → position réelle. `play()` et le titre du bouton « Lecture »
  // visent la position dans la playlist entière ; filtrer ne doit pas les
  // décaler, sinon cliquer « 1 » en filtré jouerait le titre filtré.
  //
  // La Map est reconstruite à chaque rendu. C'est O(n) une fois, contre un
  // `indexOf` O(n) par ligne rendue. Le React Compiler refuse d'ailleurs de
  // mémoïser ici : `songs` change d'identité à chaque rendu (`?? []`).
  const positionReelle = new Map(
    songs.map((song, position) => [song.video_id, position]),
  );
  const pret = local?.pret ?? 0;
  const manquant = Math.max(local?.manquant ?? 0, songs.length - pret);
  // « En cours » ne se déduit PAS du seul fait qu'il manque des titres : sinon
  // le bouton serait figé sur « Téléchargement… » avant tout clic, et
  // « Compléter » n'apparaîtrait jamais. Il faut le geste — et il doit survivre
  // au retour de la requête, qui arrive AVANT que le serveur ait téléchargé quoi
  // que ce soit (d'où le double-clic qu'on corrige ici).
  //
  // La demande s'éteint d'elle-même quand le disque a rattrapé : c'est la seule
  // information qui dit « c'est bon ». Sa réinitialisation se fait par CLÉ, et
  // non dans un effet — le linter refuse à juste titre qu'un rendu écrive
  // l'état qu'il vient de lire, et cela évite un rendu de plus. Un échec réseau
  // la laisse visible : c'est honnête, l'utilisateur peut relancer.
  const [demandePour, setDemandePour] = useState(0);
  if (demandePour > 0 && manquant === 0) setDemandePour(0);
  const enCours = downloading || (demandePour > 0 && manquant > 0);

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

  const cover = songs[0]?.video_id ?? "";

  /** Lance (ou relance) le téléchargement des titres absents. */
  function telecharger() {
    setDemandePour(Date.now());
    void download();
  }

  return (
    <div className="space-y-8 py-6">
      {/* Retour à la bibliothèque : cet écran est atteint depuis la grille/sidebar. */}
      <BackButton href="/library" />

      <header className="flex flex-col gap-6 sm:flex-row sm:items-end">
        <span className="relative block aspect-square w-40 shrink-0 overflow-hidden rounded-lg">
          {cover ? (
            <TrackCover
              videoId={cover}
              title={playlist.name}
              sizes={coverSizes(160)}
              className="size-full"
              source="auto"
            />
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
              <Button
                type="submit"
                size="icon"
                aria-label="Valider"
                disabled={busy || !editName.trim()}
              >
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
            <h1 className="truncate text-4xl font-bold tracking-tight">
              {playlist.name}
            </h1>
          )}

          <p className="text-muted-foreground text-sm">
            {songs.length} titre{songs.length > 1 ? "s" : ""}
            {playlist.mood ? ` · ${playlist.mood}` : ""}
            {playlist.created
              ? ` · créée le ${formatDate(playlist.created)}`
              : ""}
            {/* L'état local se dit dans la même ligne que le compte : « 12
                titres, 4 sur cet appareil » est l'information qui décide si un
                téléchargement est utile. */}
            {pret > 0
              ? ` · ${pret} sur cet appareil${manquant > 0 ? `, ${manquant} à télécharger` : ""}`
              : ""}
          </p>

          {/* Les libellés ci-dessous changent d'état (« Lecture » →
              « Chargement… »). Sans largeur réservée, le bouton grandit et la
              rangée entière se décale — visible surtout à droite, où les
              boutons sont déjà proches du bord. `min-w-` fige la boîte ;
              l'animation porte sur la couleur et l'icône, jamais sur la
              géométrie. */}
          <div className="flex flex-wrap items-center gap-3">
            {/* `min-w` est un plancher, pas un verrou : si le libellé le
                plus long le dépasse, le bouton grandit quand même et la
                rangée se décale. Mesuré : « Chargement… » fait 139 px, d'où
                10rem plutôt que 8rem — la marge couvre le plus long état,
                pas celui au repos. */}
            <Button
              className="min-w-40 rounded-full"
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
                bouton dit ce qu'il va faire et non « peut-être ». `enCours`
                (calculé plus haut) tient l'état pendant que le disque rattrape :
                sans lui, le bouton retombait sur « Compléter (N) » avec le même
                compte, et l'utilisateur devait recliquer. */}
            {songs.length > 0 && (
              <Button
                variant="secondary"
                size="lg"
                // Le libellé passe par quatre états (« Télécharger »,
                // « Compléter (12) », « Téléchargement… », « Téléchargée »).
                // Sans largeur réservée, chaque changement déplace la rangée ;
                // 13rem couvre le plus long d'entre eux sans laisser de vide
                // sur les états courts.
                className="min-w-52 rounded-full"
                disabled={!online || enCours || manquant === 0}
                title={
                  !online
                    ? "Téléchargement impossible hors ligne"
                    : manquant === 0
                      ? "Tous les titres sont sur cet appareil"
                      : undefined
                }
                onClick={telecharger}
              >
                {enCours ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : (
                  <Download aria-hidden="true" />
                )}
                {enCours
                  ? "Téléchargement…"
                  : manquant === 0
                    ? "Téléchargée"
                    : pret > 0
                      ? `Compléter (${manquant})`
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
            <Button
              type="submit"
              size="sm"
              disabled={searching || !query.trim()}
            >
              Chercher
            </Button>
          </form>

          {results.length > 0 && (
            <ul className="space-y-1">
              {results.map((track) => {
                const already = songs.some(
                  (s) => s.video_id === track.video_id,
                );
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
                      <span className="block truncate text-sm font-medium">
                        {track.title}
                      </span>
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
        <>
          {/* Filtre local, sur les titres déjà chargés : pas de réseau, donc
              instantané même sur une longue playlist. Le compte reste fondé sur
              `songs`, jamais sur la vue filtrée : « 12 sur 40 » décrit la
              playlist entière, pas l'affichage. */}
          <LocalFilter
            label="Rechercher un titre dans cette playlist"
            placeholder="Rechercher un titre…"
            singulier="titre"
            pluriel="titres"
            total={songs.length}
            shown={songsVisibles.length}
            onQuery={setFiltreTitres}
            className="mb-3"
          />

          {songsVisibles.length === 0 ? (
            <div className="text-muted-foreground bg-surface rounded-lg p-8 text-center text-sm">
              Aucun titre ne correspond à « {filtreTitres} ».
            </div>
          ) : (
            <ul className="space-y-1">
              {songsVisibles.map((song, indexAffiche) => {
                // L'index affiché et l'index réel ne coïncident plus dès qu'un
                // filtre est actif : `play()` et le titre du bouton « Lecture »
                // visent la position dans la playlist entière, pas dans la vue.
                // Sans cette conversion, cliquer « 1 » en filtré jouerait le
                // titre filtré — et « Lecture » démarrerait le mauvais morceau.
                const index = positionReelle.get(song.video_id) ?? indexAffiche;
                const isPending = pendingIndex === index;
                // Titre réellement en cours : suit l'état temps réel, donc le
                // marquage reste juste même après un changement de source.
                const isCurrent = currentId === song.video_id;
                return (
                  <li
                    key={song.video_id}
                    className={cn(
                      // `items-start` porte sur le <li> : c'est lui qui
                      // aligne ses enfants. Le <button> étant `flex-1`, un
                      // alignement posé plus bas n'aurait aucun effet — la
                      // pochette restait centrée sur la ligne.
                      "group flex items-start gap-3 rounded-lg p-2",
                      isCurrent ? "bg-surface-hover" : "hover:bg-surface-hover",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => void play(index)}
                      disabled={pendingIndex !== null}
                      aria-busy={isPending || undefined}
                      aria-current={isCurrent ? "true" : undefined}
                      aria-label={
                        isPending
                          ? `Chargement de ${song.title}`
                          : `Lire ${song.title}`
                      }
                      className="flex min-w-0 flex-1 gap-3 text-left disabled:cursor-wait"
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
                          <Loader2
                            className="text-primary size-4 animate-spin"
                            aria-hidden="true"
                          />
                        </span>
                      </span>
                      {/* Pas de centrage vertical ici : le <button> est
                          `flex-1`, sa hauteur est donc celle de la pochette
                          (40 px), et ses enfants sont étirés. Un
                          `justify-center` recentrait le bloc de texte dans
                          cette hauteur — c'est lui qui gardait la pochette
                          « plus basse » que le texte. `justify-start` aligne
                          le texte en haut, la pochette comprise. */}
                      <span className="flex min-w-0 flex-1 flex-col justify-start">
                        <span
                          className={cn(
                            "flex items-center gap-1.5 truncate text-sm font-medium",
                            (isCurrent || isPending) && "text-primary",
                          )}
                        >
                          <span className="truncate">{song.title}</span>
                          {/* Barres battant à côté du titre : même repère que dans
                              l'historique et la recherche, pour que « en cours »
                              se lise pareil partout. La classe `nb-eq` porte
                              déjà la keyframe et le repli `prefers-reduced-motion`. */}
                          {isCurrent && !isPending && (
                            <span
                              className="flex h-3 shrink-0 items-end gap-px"
                              aria-hidden="true"
                            >
                              {[
                                { duree: "900ms", decalage: "0ms" },
                                { duree: "1150ms", decalage: "180ms" },
                                { duree: "780ms", decalage: "90ms" },
                                { duree: "1020ms", decalage: "270ms" },
                              ].map((barre) => (
                                <span
                                  key={barre.duree}
                                  className="nb-eq bg-primary h-full w-px"
                                  style={{
                                    animationDuration: barre.duree,
                                    animationDelay: barre.decalage,
                                  }}
                                />
                              ))}
                            </span>
                          )}
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
                      {pret > 0 && estPret(song.video_id) && (
                        <span
                          title="Sur cet appareil — écoutable hors ligne"
                          className="bg-primary/15 text-primary inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
                        >
                          <HardDriveDownload
                            className="size-3"
                            aria-hidden="true"
                          />
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
        </>
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
