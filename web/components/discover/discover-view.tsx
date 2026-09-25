"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Compass, Play, RefreshCw, Save, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SectionSkeleton, TrackCard, type CardTrack } from "@/components/track-card";
import { TrackCover } from "@/components/track-cover";
import { usePlayer } from "@/components/player/player-context";
import {
  api,
  type ArtistGroup,
  type DiscoverPayload,
  type GenreSection,
  type RediscoverTrack,
} from "@/lib/api";
import { usePlaylists } from "@/lib/playlists";
import { coverSizes } from "@/lib/track";
import { cn } from "cn";

const RETRY_DELAY = 3000;
const MAX_RETRIES = 60; // le mix peut prendre 1-2 min (ytsearch + embeddings)

/** Horodatage relatif compact (« il y a 3 j », « hier »…) depuis un ISO. */
function formatRelative(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const days = Math.round((Date.now() - date.getTime()) / 86_400_000);
  if (days <= 0) return "aujourd'hui";
  if (days === 1) return "hier";
  if (days < 30) return `il y a ${days} j`;
  const months = Math.round(days / 30);
  return months < 12 ? `il y a ${months} mois` : `il y a ${Math.round(months / 12)} an(s)`;
}

/** Ligne compacte (Redécouvre, artistes) : vignette + titre + lecture. */
function TrackRow({
  track,
  subtitle,
  isCurrent,
  disabled,
  onPlay,
}: {
  track: CardTrack;
  subtitle: string;
  isCurrent: boolean;
  disabled: boolean;
  onPlay: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onPlay}
      aria-current={isCurrent ? "true" : undefined}
      className={cn(
        "focus-visible:ring-ring/60 group flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors focus-visible:ring-3 focus-visible:outline-none",
        isCurrent ? "bg-surface-hover" : "hover:bg-surface-hover",
        disabled && "opacity-60",
      )}
    >
      <TrackCover
        videoId={track.video_id}
        title={track.title}
        sizes={coverSizes(40)}
        className="size-10 shrink-0"
      />
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-sm font-medium", isCurrent && "text-primary")}>
          {track.title}
        </span>
        <span className="text-muted-foreground block truncate text-xs">{subtitle}</span>
      </span>
      <span className="bg-primary text-primary-foreground grid size-8 shrink-0 place-items-center rounded-full opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
        <Play className="size-3.5 fill-current" />
      </span>
    </button>
  );
}

export function DiscoverView() {
  const { play, togglePause, loading, state } = usePlayer();
  const { refresh: refreshLibrary } = usePlaylists();
  const [data, setData] = useState<DiscoverPayload | null>(null);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openGenre, setOpenGenre] = useState<string | null>(null);
  const [sections, setSections] = useState<Record<string, GenreSection>>({});
  const retryRef = useRef({ timer: null as number | null, tries: 0 });
  const genreTries = useRef<Record<string, number>>({});

  // Le serveur construit en arrière-plan : on repasse tant qu'il travaille.
  const load = useCallback(async () => {
    async function attempt(tries: number) {
      try {
        const payload = await api.discover();
        setData(payload);
        setFailed(false);
        if (payload.building && tries < MAX_RETRIES) {
          retryRef.current.tries = tries + 1;
          retryRef.current.timer = window.setTimeout(
            () => void attempt(tries + 1),
            RETRY_DELAY,
          );
        }
      } catch {
        setFailed(true);
      }
    }
    await attempt(0);
  }, []);

  useEffect(() => {
    const retry = retryRef.current;
    void load();
    return () => {
      if (retry.timer) window.clearTimeout(retry.timer);
    };
  }, [load]);

  /** Charge une tuile de genre, en repassant tant que le serveur la construit. */
  const loadGenre = useCallback(async (genre: string, force = false) => {
    async function attempt(tries: number) {
      try {
        const section = await api.discoverGenre(genre, force);
        setSections((prev) => ({ ...prev, [genre]: section }));
        if (!section.ready && section.building && tries < MAX_RETRIES) {
          genreTries.current[genre] = tries + 1;
          window.setTimeout(() => void attempt(tries + 1), RETRY_DELAY);
        }
      } catch {
        setSections((prev) => ({
          ...prev,
          [genre]: { genre, label: genre, ready: false, building: false, tracks: [] },
        }));
      }
    }
    await attempt(0);
  }, []);

  function playTrack(track: CardTrack) {
    const isCurrent = state?.video_id === track.video_id;
    if (isCurrent && state?.paused) {
      void togglePause();
      return;
    }
    void play(track.video_id);
  }

  async function saveAsPlaylist(name: string, tracks: CardTrack[]) {
    if (tracks.length === 0) return;
    setBusy(true);
    try {
      await api.createPlaylist({ name, video_ids: tracks.map((t) => t.video_id) });
      await refreshLibrary();
      setNotice(`Playlist « ${name} » enregistrée.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Enregistrement impossible.");
    } finally {
      setBusy(false);
    }
  }

  async function regenerate() {
    setBusy(true);
    try {
      await api.refreshDiscover();
      setData(null);
      setSections({});
      setOpenGenre(null);
      genreTries.current = {};
      retryRef.current.tries = 0;
      await load();
      setNotice("Nouvelles propositions en préparation…");
    } finally {
      setBusy(false);
    }
  }

  async function startGenreStream(genre: string, label: string) {
    try {
      await api.streamStart(genre, true);
      setNotice(`Flux ${label} lancé.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Impossible de lancer le flux.");
    }
  }

  const mix = data?.mix;
  const genres = data?.genres?.items ?? [];
  const rediscover = data?.rediscover?.tracks ?? [];
  const artists = data?.artists?.items ?? [];
  const currentId = state?.video_id ?? "";
  const noHistory = Boolean(data) && !mix?.tracks.length && rediscover.length === 0 && artists.length === 0;
  // Tuile de genre ouverte : en cours de génération, ou terminée sans résultat
  // (vivier du genre épuisé) — deux états à distinguer pour l'utilisateur.
  const openSection = openGenre ? sections[openGenre] : undefined;
  const tileLoading = Boolean(openGenre) && (!openSection || openSection.building);
  const tileEmpty = openSection ? !openSection.building && !openSection.ready : false;

  return (
    <div className="mx-auto max-w-5xl space-y-10 py-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Compass className="text-primary size-7" />
          <h1 className="text-3xl font-bold tracking-tight">Découvrir</h1>
        </div>
        <Button
          variant="ghost"
          onClick={() => void regenerate()}
          disabled={busy}
          className="rounded-full"
        >
          <RefreshCw className={cn("size-4", busy && "animate-spin")} />
          Régénérer
        </Button>
      </header>

      <p aria-live="polite" className="text-primary -mt-6 min-h-4 text-xs">
        {notice}
      </p>

      {failed && (
        <p role="alert" className="text-muted-foreground text-sm">
          Impossible de charger Découvrir pour l’instant. Réessaie dans un moment.
        </p>
      )}

      {!data && !failed && <SectionSkeleton cards={3} />}

      {noHistory && (
        <div className="bg-surface flex flex-col items-start gap-2 rounded-xl p-6">
          <p className="font-medium">Rien à proposer pour l’instant</p>
          <p className="text-muted-foreground text-sm">
            Écoute quelques titres pour que l’IA apprenne tes goûts.
          </p>
        </div>
      )}

      {/* 1. Mix personnel — affiché seulement s'il a du contenu, ou pendant sa
          construction : un mix vide et définitif ne laisse pas de squelette. */}
      {mix && (mix.tracks.length > 0 || Boolean(data?.building)) && (
        <section aria-labelledby="mix-title" aria-busy={!mix.ready}>
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <h2 id="mix-title" className="text-xl font-semibold">
              {mix.headline || "Ton mix"}
            </h2>
            {mix.ready && (
              <span className="text-muted-foreground flex items-center gap-1 text-xs">
                <Sparkles className="size-3.5" aria-hidden="true" />
                proposé par l’IA
              </span>
            )}
          </div>
          {mix.intro && <p className="text-muted-foreground mb-4 text-sm">{mix.intro}</p>}

          {mix.ready ? (
            <>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {mix.tracks.map((track, index) => (
                  <TrackCard
                    key={track.video_id}
                    track={track}
                    index={index}
                    isCurrent={track.video_id === currentId}
                    disabled={loading}
                    onPlay={() => playTrack(track)}
                  />
                ))}
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void saveAsPlaylist(mix.headline || "Mon mix", mix.tracks)}
                className="mt-4 rounded-full"
              >
                <Save className="size-4" />
                Enregistrer en playlist
              </Button>
            </>
          ) : (
            <SectionSkeleton cards={4} />
          )}
        </section>
      )}

      {/* 2. Explorer par genre */}
      {genres.length > 0 && (
        <section aria-labelledby="genres-title">
          <h2 id="genres-title" className="mb-4 text-xl font-semibold">
            Explorer par genre
          </h2>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {genres.map((tile) => {
              const open = openGenre === tile.genre;
              return (
                <li key={tile.genre}>
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => {
                      if (open) {
                        setOpenGenre(null);
                        return;
                      }
                      setOpenGenre(tile.genre);
                      if (!sections[tile.genre]?.ready) void loadGenre(tile.genre);
                    }}
                    className={cn(
                      "from-primary/25 border-border hover:border-primary/60 flex h-24 w-full flex-col items-start justify-end rounded-xl border bg-gradient-to-br to-transparent p-3 text-left transition-colors",
                      open && "border-primary/60",
                    )}
                  >
                    <span className="text-sm font-semibold">{tile.label}</span>
                    <span className="text-muted-foreground text-xs">
                      {(() => {
                        const section = sections[tile.genre];
                        if (section?.ready) return `${section.tracks.length} titres`;
                        if (section && !section.building) return "Aucun titre";
                        if (open) return "Génération…";
                        return tile.ready ? "Prêt" : "À explorer";
                      })()}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {openGenre && (
            <div
              className="bg-surface mt-4 rounded-xl p-4"
              aria-busy={tileLoading}
            >
              {tileLoading ? (
                <div className="space-y-3">
                  <p className="text-muted-foreground text-sm">
                    Génération en cours… (le moteur cherche des titres 100 %{" "}
                    {(openSection?.label ?? openGenre).toLowerCase()})
                  </p>
                  <SectionSkeleton cards={4} />
                </div>
              ) : tileEmpty ? (
                <div className="flex flex-col items-start gap-3">
                  <p className="text-muted-foreground text-sm">
                    Aucun nouveau titre dans ce genre pour l’instant : le vivier est
                    momentanément épuisé (les titres déjà écoutés sont exclus).
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-full"
                    onClick={() => void loadGenre(openGenre, true)}
                  >
                    <RefreshCw className="size-4" />
                    Réessayer
                  </Button>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                    {(openSection?.tracks ?? []).map((track, index) => (
                      <TrackCard
                        key={track.video_id}
                        track={track}
                        index={index}
                        isCurrent={track.video_id === currentId}
                        disabled={loading}
                        onPlay={() => playTrack(track)}
                      />
                    ))}
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      className="rounded-full"
                      onClick={() =>
                        void startGenreStream(
                          openSection!.genre,
                          openSection!.label,
                        )
                      }
                    >
                      <Play className="size-4 fill-current" />
                      Lancer le flux {openSection!.label}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      className="rounded-full"
                      onClick={() =>
                        void saveAsPlaylist(
                          `${openSection!.label} (Découvrir)`,
                          openSection!.tracks,
                        )
                      }
                    >
                      <Save className="size-4" />
                      Enregistrer en playlist
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </section>
      )}

      {/* 3. Redécouvre */}
      {rediscover.length > 0 && (
        <section aria-labelledby="rediscover-title">
          <h2 id="rediscover-title" className="mb-1 text-xl font-semibold">
            Redécouvre
          </h2>
          <p className="text-muted-foreground mb-4 text-sm">
            Des titres de tes écoutes passées que tu n’as pas réécoutés depuis un moment.
          </p>
          <ul className="space-y-1">
            {rediscover.map((track: RediscoverTrack) => (
              <li key={track.video_id}>
                <TrackRow
                  track={track}
                  subtitle={`${track.channel} · écouté ${formatRelative(track.last_played)}`}
                  isCurrent={track.video_id === currentId}
                  disabled={loading}
                  onPlay={() => playTrack(track)}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 4. Artistes favoris */}
      {artists.length > 0 && (
        <section aria-labelledby="artists-title">
          <h2 id="artists-title" className="mb-4 text-xl font-semibold">
            Artistes favoris
          </h2>
          <div className="space-y-6">
            {artists.map((group: ArtistGroup) => (
              <div key={group.channel}>
                <p className="mb-2 flex items-baseline gap-2">
                  <span className="text-sm font-medium">{group.channel}</span>
                  <span className="text-muted-foreground text-xs">
                    {group.plays} écoute{group.plays > 1 ? "s" : ""}
                  </span>
                </p>
                <ul className="space-y-1">
                  {group.tracks.map((track) => (
                    <li key={track.video_id}>
                      <TrackRow
                        track={track}
                        subtitle={track.channel}
                        isCurrent={track.video_id === currentId}
                        disabled={loading}
                        onPlay={() => playTrack(track)}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
