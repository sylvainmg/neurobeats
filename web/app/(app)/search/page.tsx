"use client";

import { useEffect, useRef, useState } from "react";
import {
  AudioLines,
  CircleAlert,
  EllipsisVertical,
  ListPlus,
  Loader2,
  Music2,
  Play,
  Search as SearchIcon,
  SearchX,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Rating } from "@/components/layout/rating";
import { AddToPlaylistDialog } from "@/components/library/add-to-playlist-dialog";
import { usePlayer } from "@/components/player/player-context";
import { TrackCover } from "@/components/track-cover";
import { api, ApiError, type SearchSuggestion, type Track } from "@/lib/api";
import { coverSizes, formatDuration } from "@/lib/track";
import { cn } from "cn";

type Status = "idle" | "loading" | "done" | "error";

const RESULT_LIMIT = 10;
const SKELETON_ROWS = 6;

/** Ligne de resultat : jaquette, titre, chaine, genre, duree + lecture au survol. */
function ResultRow({
  track,
  index,
  isCurrent,
  disabled,
  loading,
  onPlay,
  onAddToPlaylist,
}: {
  track: Track;
  index: number;
  isCurrent: boolean;
  disabled: boolean;
  /** La lecture de ce résultat est en vol : la ligne porte le feedback. */
  loading: boolean;
  onPlay: (videoId: string) => void;
  onAddToPlaylist: (track: Track) => void;
}) {
  const duration = formatDuration(track.duration);
  // Le menu est portalé : sans cet état, la ligne perdrait son survol à
  // l'ouverture et le déclencheur disparaîtrait sous son propre menu.
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <li
      className="nb-rise group/row relative"
      style={{ animationDelay: `${Math.min(index, 9) * 22}ms` }}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          // Ligne déjà en chargement : le clic suivant doit viser ailleurs
          // (l'abort du choix précédent est géré par le lecteur).
          if (loading) return;
          onPlay(track.video_id);
        }}
        aria-current={isCurrent ? "true" : undefined}
        aria-busy={loading || undefined}
        className={cn(
          "group focus-visible:ring-ring/60 flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors focus-visible:ring-3 focus-visible:outline-none",
          isCurrent ? "bg-surface-hover" : "hover:bg-surface-hover",
          disabled && "opacity-60",
        )}
      >
        {/* Jaquette : la vignette du titre, identique partout dans l'app. */}
        <span className="relative block size-12 shrink-0">
          <TrackCover
            videoId={track.video_id}
            title={track.title}
            sizes={coverSizes(48)}
            className="size-12"
          />
          <span
            className={cn(
              "absolute inset-0 grid place-items-center rounded-md bg-black/50 transition-opacity",
              // Chargement : spinner permanent ; sinon affordance au survol.
              loading
                ? "opacity-100"
                : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
            )}
          >
            {loading ? (
              <Loader2 className="size-4 animate-spin text-white" aria-hidden="true" />
            ) : (
              <Play className="size-4 fill-current text-white" />
            )}
          </span>
        </span>

        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "flex items-center gap-2 text-sm font-medium",
              isCurrent && "text-primary",
            )}
          >
            <span className="truncate">{track.title}</span>
            {isCurrent && (
              <AudioLines
                className="text-primary size-3.5 shrink-0"
                aria-hidden="true"
              />
            )}
          </span>
          <span className="text-muted-foreground mt-0.5 truncate text-xs">
            {loading ? "Chargement du titre…" : track.channel}
          </span>
        </span>

        {duration && (
          <span className="text-muted-foreground max-sm:hidden shrink-0 text-xs tabular-nums">
            {duration}
          </span>
        )}
      </button>

      {/* Note ★ et menu d'options : posés À CÔTÉ de la ligne (jamais imbriqués
          dans son bouton), affichés au survol/focus pour ne pas charger la
          lecture. Le menu étant portalé, il reste ouvert même quand la ligne
          n'est plus survolée. Sur mobile et tactile, le voile est permanent :
          les étoiles et le menu doivent rester accessibles sans survol. */}
      <div
        className={cn(
          "pointer-events-none absolute inset-y-0 right-2 flex items-center gap-0.5 bg-[var(--card)] bg-gradient-to-l from-[var(--card)] via-[var(--card)] to-transparent pl-6",
          "opacity-100 md:opacity-0 md:transition-opacity md:group-hover/row:opacity-100 md:focus-within:opacity-100 md:pointer-coarse:opacity-100",
          menuOpen && "opacity-100 md:opacity-100",
        )}
      >
        <Rating
          videoId={track.video_id}
          title={track.title}
          channel={track.channel}
          className="pointer-events-auto"
        />
        <DropdownMenu onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Autres actions pour ${track.title}`}
              className="text-muted-foreground hover:text-foreground pointer-events-auto rounded-full"
            >
              <EllipsisVertical />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onAddToPlaylist(track)}>
              <ListPlus className="size-4" aria-hidden="true" />
              Ajouter à une playlist
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

export default function SearchPage() {
  const { play, state } = usePlayer();
  const inputRef = useRef<HTMLInputElement>(null);
  // Contrôleur de la recherche en vol : une nouvelle recherche annule la
  // précédente (dernier choix gagne), elle ne part jamais deux requêtes de front.
  const searchAbort = useRef<AbortController | null>(null);
  // Numéro de la recherche en cours : invalide une réponse arrivée après coup
  // (ex. l'utilisateur vide le champ pendant le chargement).
  const searchSeq = useRef(0);

  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [results, setResults] = useState<Track[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  // Points de départ libellés par l'IA (jamais une liste figée).
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  // Titre ciblé par « Ajouter à une playlist » (menu des résultats).
  const [addTrack, setAddTrack] = useState<Track | null>(null);
  // Titre en cours de lancement : la ligne cliquée porte le feedback
  // (spinner + libellé) tant que la lecture n'a pas abouti.
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const busy = status === "loading";

  // Dernier titre lancé : seule la ligne du lancement le plus récent porte le
  // feedback — la résolution d'une lecture annulée (supplantée par un clic
  // suivant) ne doit pas couper l'indicateur de la nouvelle.
  const launchRef = useRef<string | null>(null);

  /** Lance la lecture ; un second clic annule la requête précédente encore en
   * vol (abort géré par `play` du lecteur) : seul le dernier choix est joué. */
  function launch(videoId: string) {
    launchRef.current = videoId;
    setLoadingId(videoId);
    void play(videoId).finally(() => {
      if (launchRef.current === videoId) setLoadingId(null);
    });
  }

  // Le serveur construit les libellés en arrière-plan : on repasse tant qu'il
  // travaille. Liste vide = aucun libellé fiable → on n'affiche rien.
  useEffect(() => {
    let active = true;
    let timer: number | null = null;
    let tries = 0;

    async function load() {
      try {
        const data = await api.searchSuggestions();
        if (!active) return;
        setSuggestions(data.suggestions ?? []);
        if (data.building && tries < 40) {
          tries += 1;
          timer = window.setTimeout(() => void load(), 3000);
        }
      } catch {
        // silencieux : la recherche manuelle reste disponible
      }
    }

    void load();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  async function runSearch(raw: string) {
    const q = raw.trim();
    if (!q) return;
    const seq = ++searchSeq.current;
    // Toute recherche en cours devient obsolète : on l'annule et on repart.
    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;
    setStatus("loading");
    setError(null);
    setSubmitted(q);
    try {
      const data = await api.search(q, RESULT_LIMIT, controller.signal);
      if (seq !== searchSeq.current) return;
      setResults(data);
      setStatus("done");
    } catch (err) {
      // Requête supplantée (nouvelle recherche) : aucun message à afficher.
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (seq !== searchSeq.current) return;
      setResults([]);
      setError(
        err instanceof ApiError ? err.message : "La recherche a échoué.",
      );
      setStatus("error");
    }
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    void runSearch(query);
  }

  function pickGenre(genreQuery: string) {
    setQuery(genreQuery);
    void runSearch(genreQuery);
  }

  function reset() {
    searchSeq.current += 1;
    searchAbort.current?.abort();
    setQuery("");
    setSubmitted("");
    setResults([]);
    setError(null);
    setStatus("idle");
    inputRef.current?.focus();
  }

  const statusMessage =
    status === "loading"
      ? `Recherche de ${submitted} en cours.`
      : status === "done"
        ? `${results.length} résultat${results.length > 1 ? "s" : ""} pour ${submitted}.`
        : status === "error"
          ? "La recherche a échoué."
          : "";

  return (
    <div className="mx-auto max-w-5xl space-y-8 py-6">
      <header className="space-y-1">
        <div className="flex items-center gap-3">
          <SearchIcon className="text-primary size-7" aria-hidden="true" />
          <h1 className="text-3xl font-bold tracking-tight">Recherche</h1>
        </div>
        <p className="text-muted-foreground text-sm">
          Trouve un titre, un artiste ou un genre à écouter.
        </p>
      </header>

      <form
        role="search"
        aria-label="Rechercher un titre"
        onSubmit={onSubmit}
        className="flex flex-col gap-2 sm:flex-row"
      >
        <div className="relative flex-1">
          <label htmlFor="search-input" className="sr-only">
            Rechercher un titre, un artiste ou un genre
          </label>
          <SearchIcon
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2"
            aria-hidden="true"
          />
          <Input
            id="search-input"
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => {
              const value = e.target.value;
              setQuery(value);
              // Champ vidé : on efface aussi les résultats affichés, sinon ils
              // restent visibles alors que la requête a disparu du champ.
              if (value === "" && status !== "idle") reset();
            }}
            placeholder="Titres, artistes, genres…"
            autoComplete="off"
            className="bg-surface placeholder:text-muted-foreground h-11 rounded-full pr-10 pl-10 text-base [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Effacer la recherche"
              onClick={reset}
              className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2 rounded-full"
            >
              <X />
            </Button>
          )}
        </div>
        <Button
          type="submit"
          size="lg"
          disabled={!query.trim()}
          className="h-11 rounded-full px-6"
        >
          Rechercher
        </Button>
      </form>

      {/* Annonce aux lecteurs d'ecran (visuelle : la ligne de compte ci-dessous). */}
      <p aria-live="polite" className="sr-only">
        {statusMessage}
      </p>

      {status === "idle" && suggestions.length > 0 && (
        <section aria-labelledby="genres-title" className="space-y-4">
          <div>
            <h2 id="genres-title" className="text-lg font-semibold">
              Explorer par genre
            </h2>
            <p className="text-muted-foreground text-sm">
              Choisis un genre pour lancer une recherche.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((suggestion) => (
              <Button
                key={suggestion.label}
                type="button"
                variant="outline"
                onClick={() => pickGenre(suggestion.query)}
                className="bg-surface hover:bg-surface-hover h-9 rounded-full border-transparent px-4"
              >
                {suggestion.label}
              </Button>
            ))}
          </div>
        </section>
      )}

      {busy && (
        <section aria-label="Recherche en cours" className="space-y-3">
          <p className="text-muted-foreground text-sm">
            Recherche de « {submitted} »…
          </p>
          <ul className="space-y-1">
            {Array.from({ length: SKELETON_ROWS }, (_, i) => (
              <li
                key={i}
                aria-hidden="true"
                className="flex items-center gap-3 p-2"
              >
                <span className="bg-surface-hover size-12 shrink-0 animate-pulse rounded-md" />
                <span className="min-w-0 flex-1 space-y-2">
                  <span className="bg-surface-hover block h-3.5 w-1/2 animate-pulse rounded-full" />
                  <span className="bg-surface-hover block h-3 w-1/3 animate-pulse rounded-full" />
                </span>
                <span className="bg-surface-hover h-3 w-8 shrink-0 animate-pulse rounded-full" />
              </li>
            ))}
          </ul>
        </section>
      )}

      {status === "error" && (
        <section
          role="alert"
          className="bg-surface flex flex-col items-start gap-3 rounded-xl p-6"
        >
          <CircleAlert className="text-destructive size-6" aria-hidden="true" />
          <div className="space-y-1">
            <h2 className="font-semibold">La recherche a échoué</h2>
            <p className="text-muted-foreground text-sm">
              {error} Réessaie dans un instant.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void runSearch(submitted)}
            className="rounded-full"
          >
            Réessayer
          </Button>
        </section>
      )}

      {status === "done" && results.length === 0 && (
        <section className="bg-surface flex flex-col items-start gap-3 rounded-xl p-6">
          <SearchX
            className="text-muted-foreground size-6"
            aria-hidden="true"
          />
          <div className="space-y-1">
            <h2 className="font-semibold">
              Aucun résultat pour « {submitted} »
            </h2>
            <p className="text-muted-foreground text-sm">
              Vérifie l’orthographe, essaie un autre artiste, ou pars d’un
              genre.
            </p>
          </div>
          {suggestions.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {suggestions.map((suggestion) => (
                <Button
                  key={suggestion.label}
                  type="button"
                  variant="outline"
                  onClick={() => pickGenre(suggestion.query)}
                  className="bg-background/40 h-9 rounded-full border-transparent px-4"
                >
                  {suggestion.label}
                </Button>
              ))}
            </div>
          )}
        </section>
      )}

      {status === "done" && results.length > 0 && (
        <section aria-labelledby="results-title" className="space-y-3">
          <div className="flex items-baseline justify-between gap-4">
            <h2 id="results-title" className="text-sm font-medium">
              {results.length} résultat{results.length > 1 ? "s" : ""} pour «{" "}
              {submitted} »
            </h2>
            <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <Music2 className="size-3.5" aria-hidden="true" />
              Clique un titre pour l’écouter
            </span>
          </div>
          <ul aria-label="Résultats de recherche" className="space-y-1">
            {results.map((track, index) => (
              <ResultRow
                key={track.video_id}
                track={track}
                index={index}
                isCurrent={state?.video_id === track.video_id}
                disabled={false}
                loading={loadingId === track.video_id}
                onPlay={launch}
                onAddToPlaylist={setAddTrack}
              />
            ))}
          </ul>
        </section>
      )}

      {/* Ajout à une playlist : piloté par la ligne survolée (menu « … »). */}
      <AddToPlaylistDialog
        open={addTrack !== null}
        onOpenChange={(next) => {
          if (!next) setAddTrack(null);
        }}
        track={addTrack}
      />
    </div>
  );
}
