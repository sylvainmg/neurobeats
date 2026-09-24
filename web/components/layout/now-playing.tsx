"use client";

import { useEffect, useRef, useState } from "react";
import {
  ListMusic,
  ListPlus,
  LoaderCircle,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { QueuePanel } from "@/components/layout/queue-panel";
import { Rating } from "@/components/layout/rating";
import { AddToPlaylistDialog } from "@/components/library/add-to-playlist-dialog";
import { usePlayer } from "@/components/player/player-context";
import {
  api,
  type QueueState,
  type RepeatMode,
} from "@/lib/api";
import { TrackCover } from "@/components/track-cover";
import { useRealtime } from "@/lib/realtime";
import { useOverlays } from "@/lib/overlays";
import { LyricsButton } from "@/components/lyrics/lyrics-button";
import { coverSizes } from "@/lib/track";
import { cn } from "cn";

/**
 * Formate des secondes en `m:ss`.
 *
 * Borné à 0 : mpv peut rapporter une position très légèrement négative pendant
 * un seek (surtout vers le début), ce qui produirait un affichage absurde
 * (`-1:-1`) sans ce plancher.
 */
function formatTime(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds)) return "0:00";
  const safe = Math.max(0, seconds);
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Barre de lecture basse (player), connectée au backend.
 * La lecture est continue par défaut : l'enchaînement est géré côté moteur.
 */
export function NowPlaying() {
  const {
    state,
    loading,
    error: playerError,
    skip,
    previous: playPrevious,
    jump,
    togglePause,
    seek,
    setVolume: setBackendVolume,
    setShuffle: setShuffleBackend,
    setRepeat: setRepeatBackend,
  } = usePlayer();
  const { queue: liveQueue, connected } = useRealtime();
  const { queueOpen, setQueueOpen, lyricsOpen, setLyricsOpen } = useOverlays();
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<RepeatMode>("off");
  const [volume, setVolume] = useState(70);
  // Interaction avec la barre de progression. Tout est porté par un seul état
  // étiqueté par titre : un changement de titre invalide automatiquement la
  // position locale, sans effet de resynchronisation.
  // - `dragging` : l'utilisateur tient le curseur, la position réelle est ignorée ;
  // - sinon `target` : position visée, tenue jusqu'à confirmation du serveur —
  //   sans quoi le curseur reviendrait brièvement sur l'ancienne position.
  const [seekState, setSeekState] = useState<{
    videoId: string;
    target: number;
    dragging: boolean;
  } | null>(null);
  const [queue, setQueue] = useState<QueueState | null>(null);
  // Titres retires de la file : masques immediatement, sans attendre la diffusion
  // temps reel (le serveur les a deja retires de son cote).
  const [removedFromQueue, setRemovedFromQueue] = useState<string[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  // Initialise Aléatoire/Loop depuis le backend une seule fois (évite que le
  // polling n'écrase l'état local après un clic).
  const modesSeeded = useRef(false);

  // Échap ferme la file de lecture (sauf si le modal d'ajout est ouvert : il gère
  // déjà Échap pour lui-même).
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !addOpen) setQueueOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setQueueOpen, addOpen]);

  // File de lecture : poussée par le WebSocket ; repli REST si la connexion est
  // absente (et seulement quand le panneau est ouvert).
  useEffect(() => {
    if (connected || !queueOpen) return;
    let active = true;
    const load = async () => {
      try {
        const q = await api.queue();
        if (active) setQueue(q);
      } catch {
        /* silencieux */
      }
    };
    load();
    const id = window.setInterval(load, 3000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [connected, queueOpen]);

  const displayQueue = connected ? liveQueue : queue;
  const queueFilling = displayQueue?.filling ?? false;

  // Un titre retire quitte l'affichage tout de suite ; si le serveur refuse le
  // retrait, il reapparait — la file reste la source de verite.
  const visibleTracks = (displayQueue?.tracks ?? []).filter(
    (track) => !removedFromQueue.includes(track.video_id),
  );

  // Le panneau raisonne en position parmi les titres a venir (comme `jump`).
  // Seules ces lignes sont retirables : le curseur ne bouge donc jamais.
  async function removeFromQueue(index: number, videoId: string) {
    setRemovedFromQueue((prev) => [...prev, videoId]);
    try {
      await api.queueRemove(index - (displayQueue?.current_index ?? 0));
    } catch {
      setRemovedFromQueue((prev) => prev.filter((id) => id !== videoId));
    }
  }

  // Aligne les modes sur l'état backend au premier chargement.
  useEffect(() => {
    if (modesSeeded.current || !state) return;
    modesSeeded.current = true;
    setShuffle(state.shuffle);
    setRepeat(state.repeat);
  }, [state]);

  function toggleShuffle() {
    const next = !shuffle;
    setShuffle(next);
    void setShuffleBackend(next);
  }

  function cycleRepeat() {
    const next: RepeatMode =
      repeat === "off" ? "all" : repeat === "all" ? "one" : "off";
    setRepeat(next);
    void setRepeatBackend(next);
  }

  // "Précédent" : le serveur rejoue le titre précédent de la session, ou
  // revient au début du titre courant s'il vient de commencer.
  function previous() {
    void playPrevious();
  }

  const repeatLabel = repeat === "one" ? "Répéter le titre" : "Répéter la file";
  const playing = Boolean(state?.playing);
  const paused = Boolean(state?.paused);
  const position = state?.position ?? 0;
  const duration = state?.duration ?? 0;
  const currentVideoId = state?.video_id ?? "";

  // Interprétation de l'état local : le titre a pu changer entre-temps.
  const local = seekState && seekState.videoId === currentVideoId ? seekState : null;
  const dragging = local?.dragging ? local : null;
  const settling = local && !local.dragging ? local : null;
  // Le serveur a appliqué le seek : la position réelle reprend la main.
  const settled = Boolean(settling) && Math.abs(position - (settling?.target ?? 0)) <= 2;

  // Position affichée : le curseur tenu par l'utilisateur prime, puis la cible
  // visée tant que le serveur ne l'a pas rejointe, puis la position réelle.
  const localPosition = dragging
    ? dragging.target
    : settling && !settled
      ? settling.target
      : position;
  // Le slider travaille en secondes (précision utile sur les longs mixes).
  // Borné à [0, durée] : ni valeur négative (seek au tout début), ni au-delà.
  const sliderValue = Math.min(
    Math.max(localPosition, 0),
    duration > 0 ? duration : 0,
  );
  const shownPosition = Math.max(0, localPosition);
  const title = state?.title || "Aucune lecture";
  const subtitle = state?.channel || "Lance un titre pour commencer";

  // Filet de sécurité : si le serveur ne confirme pas la cible (seek refusé,
  // flux interrompu), on rend la main à la position réelle au bout de 2,5 s.
  const awaitTarget = settling && !settled ? settling.target : null;
  useEffect(() => {
    if (awaitTarget == null) return;
    const id = window.setTimeout(() => {
      setSeekState((prev) => (prev && !prev.dragging ? null : prev));
    }, 2500);
    return () => window.clearTimeout(id);
  }, [awaitTarget]);

  return (
    <footer className="border-border bg-surface relative flex h-20 shrink-0 items-center gap-4 border-t px-4">
      {/* Retour d'action : un « Suivant » qui echoue ne doit plus etre muet.
          Detache du flux du bas (position absolue) : aucun decalage de mise en page. */}
      {playerError && (
        <p
          role="status"
          aria-live="polite"
          className="border-destructive/30 bg-destructive/10 text-destructive absolute bottom-full left-1/2 mb-2 -translate-x-1/2 rounded-full border px-3 py-1 text-xs whitespace-nowrap shadow-sm"
        >
          {playerError}
        </p>
      )}
      {/* Titre en cours */}
      <div className="flex w-56 min-w-0 items-center gap-3">
        {/* Vignette du titre en cours, comme dans les résultats de recherche. */}
        {state?.video_id ? (
          <TrackCover
            videoId={state.video_id}
            title={title}
            sizes={coverSizes(48)}
            className="size-12"
          />
        ) : (
          <span className="bg-surface-hover size-12 shrink-0 rounded-md" />
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{title}</p>
          <p className="text-muted-foreground truncate text-xs">{subtitle}</p>
        </div>
      </div>

      {/* Contrôles + progression */}
      <div className="flex flex-1 flex-col items-center gap-1">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Lecture aléatoire"
            aria-pressed={shuffle}
            onClick={toggleShuffle}
            className={cn(
              "hover:text-foreground relative",
              shuffle
                ? "text-primary hover:text-primary"
                : "text-muted-foreground",
            )}
          >
            <Shuffle />
            {shuffle && (
              <span className="bg-primary absolute bottom-1 size-1 rounded-full" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Titre précédent"
            disabled={!playing || (displayQueue?.current_index ?? 0) <= 0}
            onClick={previous}
            className="text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            <SkipBack />
          </Button>
          <Button
            size="icon-lg"
            aria-label={!playing ? "Lecture" : paused ? "Reprendre" : "Pause"}
            disabled={loading || !playing}
            onClick={() => playing && togglePause()}
            className="bg-primary text-primary-foreground hover:bg-primary/80 rounded-full"
          >
            {playing && !paused ? (
              <Pause className="fill-current" />
            ) : (
              <Play className="fill-current" />
            )}
          </Button>
          {/* Reste cliquable pendant la preparation : le serveur repond « file en
              preparation » et le clic est honore des qu'un titre arrive, au lieu
              d'etre bloque par une file encore vide. */}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={queueFilling ? "Suivant (file en préparation)" : "Suivant"}
            aria-busy={queueFilling}
            title={queueFilling ? "File en préparation…" : "Suivant"}
            disabled={
              !playing || ((displayQueue?.remaining ?? 0) === 0 && !queueFilling)
            }
            onClick={() => void skip()}
            className="text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            {queueFilling ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <SkipForward />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={repeatLabel}
            aria-pressed={repeat !== "off"}
            onClick={cycleRepeat}
            className={cn(
              "hover:text-foreground relative",
              repeat !== "off"
                ? "text-primary hover:text-primary"
                : "text-muted-foreground",
            )}
          >
            {repeat === "one" ? <Repeat1 /> : <Repeat />}
            {repeat !== "off" && (
              <span className="bg-primary absolute bottom-1 size-1 rounded-full" />
            )}
          </Button>
        </div>
        <div className="flex w-full max-w-md items-center gap-2">
          <span className="text-muted-foreground w-12 text-right text-[10px] tabular-nums">
            {formatTime(shownPosition)}
          </span>
          <Slider
            value={[sliderValue]}
            max={duration > 0 ? duration : 1}
            step={1}
            disabled={!playing || duration <= 0}
            onValueChange={([value]) =>
              setSeekState({
                videoId: currentVideoId,
                target: Math.max(0, value),
                dragging: true,
              })
            }
            onValueCommit={([value]) => {
              // On ne relâche pas l'affichage : la cible reste tenue jusqu'à
              // confirmation serveur, sinon le curseur revient en arrière.
              setSeekState({
                videoId: currentVideoId,
                target: Math.max(0, value),
                dragging: false,
              });
              void seek(Math.max(0, value));
            }}
            className="flex-1"
          />
          <span className="text-muted-foreground w-12 text-[10px] tabular-nums">
            {formatTime(duration)}
          </span>
        </div>
      </div>

      {/* Volume + file de lecture + paroles */}
      <div className="flex w-64 items-center justify-end gap-3">
        <div className="hidden items-center gap-2 lg:flex">
          <Volume2 className="text-muted-foreground size-4" />
          <Slider
            value={[volume]}
            max={100}
            step={1}
            onValueChange={([v]) => setVolume(v)}
            onValueCommit={([v]) => void setBackendVolume(v)}
            className="w-24"
          />
        </div>
        {state?.video_id && (
          <Rating
            videoId={state.video_id}
            title={state.title}
            channel={state.channel}
            className="mr-1"
          />
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Ajouter à une playlist"
          disabled={!state?.video_id}
          onClick={() => setAddOpen(true)}
          className="text-muted-foreground hover:text-foreground rounded-full disabled:opacity-40"
        >
          <ListPlus />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="File de lecture"
          aria-pressed={queueOpen}
          onClick={() => setQueueOpen(!queueOpen)}
          className={cn(
            "rounded-full",
            queueOpen
              ? "bg-surface-hover text-primary hover:text-primary"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <ListMusic />
        </Button>
        <LyricsButton
          open={lyricsOpen}
          disabled={!state?.video_id}
          onToggle={() => setLyricsOpen(!lyricsOpen)}
        />
      </div>

      <AddToPlaylistDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        track={
          state?.video_id
            ? { video_id: state.video_id, title: state.title, channel: state.channel }
            : null
        }
      />

      <QueuePanel
        open={queueOpen}
        onClose={() => setQueueOpen(false)}
        tracks={visibleTracks}
        currentIndex={displayQueue?.current_index ?? -1}
        remaining={displayQueue?.remaining ?? 0}
        filling={queueFilling}
        onSelect={(index) => void jump(index - (displayQueue?.current_index ?? 0))}
        onRemove={(index, videoId) => void removeFromQueue(index, videoId)}
      />
    </footer>
  );
}
