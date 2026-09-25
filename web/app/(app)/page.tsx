"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Pause, Play, Search as SearchIcon, Sparkles } from "lucide-react";

import { SectionSkeleton, TrackCard } from "@/components/track-card";
import { TrackCover } from "@/components/track-cover";
import { usePlayer } from "@/components/player/player-context";
import { api, type HomeContent, type HomeTrack } from "@/lib/api";
import { coverSizes } from "@/lib/track";
import { cn } from "cn";

const RETRY_DELAY = 3000;
const MAX_RETRIES = 20;

/**
 * Égaliseur animé : petites barres qui battent depuis le bas.
 *
 * Remplace l'icône statique pendant la lecture. Délais et durées diffèrent d'une
 * barre à l'autre pour un battement organique plutôt que mécanique ; le
 * mouvement est neutralisé si l'utilisateur préfère réduire les animations.
 */
const EQ_BARS = [
  { delay: "0ms", duration: "900ms" },
  { delay: "180ms", duration: "1150ms" },
  { delay: "90ms", duration: "780ms" },
  { delay: "270ms", duration: "1020ms" },
];

/**
 * Salutation selon l'heure locale.
 *
 * Les seuils reprennent les tranches du moteur (nuit jusqu'à 6 h, soir à partir
 * de 18 h) : le titre parle ainsi le même langage que les statistiques d'écoute.
 * Passé midi, « Bonjour » ne convient plus — d'où l'après-midi à part.
 */
function greetingAt(hour: number) {
  if (hour < 6) return "Bonne nuit";
  if (hour < 12) return "Bonjour";
  if (hour < 18) return "Bon après-midi";
  return "Bonsoir";
}

/**
 * Titre de bienvenue, qui suit l'heure du navigateur.
 *
 * Le contrôle est calé sur l'heure pile suivante (minuterie recalculée après
 * chaque bascule) et non sur un intervalle lancé au montage : le titre change au
 * moment du passage d'une tranche à l'autre, pas jusqu'à une minute plus tard.
 * Il est aussi refait au retour sur l'onglet, car un onglet en arrière-plan voit
 * ses minuteries ralenties par le navigateur.
 *
 * Rendu aussi côté serveur : ici serveur et navigateur tournent sur la même
 * machine, donc à la même heure. Si un client arrivait d'un autre fuseau, React
 * réafficherait la valeur du navigateur — plutôt que de figer un titre faux, ce
 * que ferait un `suppressHydrationWarning`.
 */
function Greeting() {
  const [hour, setHour] = useState(() => new Date().getHours());

  useEffect(() => {
    let timer = 0;
    const refresh = () => setHour(new Date().getHours());
    const schedule = () => {
      const now = new Date();
      const next = new Date(now);
      next.setHours(now.getHours() + 1, 0, 0, 0);
      // +250 ms : on relit l'heure une fois la bascule réellement passée.
      timer = window.setTimeout(() => {
        refresh();
        schedule();
      }, next.getTime() - now.getTime() + 250);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };

    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return <>{greetingAt(hour)}</>;
}

function Equalizer() {
  return (
    <span aria-hidden="true" className="flex h-4 items-end gap-0.5">
      {EQ_BARS.map((bar) => (
        <span
          key={bar.delay}
          className="nb-eq bg-primary h-full w-[3px] rounded-full"
          style={{
            animationDelay: bar.delay,
            animationDuration: bar.duration,
          }}
        />
      ))}
    </span>
  );
}

/**
 * Ligne de reprise : le titre chargé, prêt à reprendre — ou en cours.
 *
 * `playing` vient de l'état temps réel : la ligne suit donc la lecture (icône,
 * libellé et annonce lecteur d'écran changent) au lieu de rester figée.
 */
function ResumeRow({
  track,
  playing,
  disabled,
  onPlay,
}: {
  track: HomeTrack;
  playing: boolean;
  disabled: boolean;
  onPlay: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onPlay}
      aria-current={playing ? "true" : undefined}
      className={cn(
        "nb-rise group bg-surface hover:bg-surface-hover focus-visible:ring-ring/60 flex w-full items-center gap-4 rounded-xl p-3 text-left transition-colors focus-visible:ring-3 focus-visible:outline-none",
        disabled && "opacity-60",
      )}
    >
      <TrackCover
        videoId={track.video_id}
        title={track.title}
        sizes={coverSizes(56)}
        rounded="rounded-lg"
        className="size-14"
      />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-sm font-medium",
            playing && "text-primary",
          )}
        >
          {track.title}
        </span>
        <span className="text-muted-foreground block truncate text-xs">
          {track.channel}
        </span>
      </span>
      <span className="bg-primary text-primary-foreground grid size-10 shrink-0 place-items-center rounded-full transition-transform group-hover:scale-105">
        {playing ? (
          <Pause className="size-4 fill-current" />
        ) : (
          <Play className="size-4 fill-current" />
        )}
      </span>
      <span className="sr-only">
        {playing
          ? "Mettre en pause la lecture en cours"
          : "Reprendre la lecture"}
      </span>
    </button>
  );
}

export default function Home() {
  const { play, togglePause, loading, state } = usePlayer();
  const [content, setContent] = useState<HomeContent | null>(null);
  const [failed, setFailed] = useState(false);
  // Les tentatives sont bornées : au-delà, on sort des squelettes pour afficher
  // un état explicite plutôt que de laisser la page en attente pour toujours.
  const [exhausted, setExhausted] = useState(false);
  const retryRef = useRef<{ timer: number | null; tries: number }>({
    timer: null,
    tries: 0,
  });

  // Le serveur construit le contenu en arrière-plan : tant qu'il n'est pas prêt,
  // on repasse (la page affiche des squelettes, jamais un écran bloqué).
  useEffect(() => {
    let active = true;
    const retry = retryRef.current;

    async function load() {
      try {
        const data = await api.home();
        if (!active) return;
        setContent(data);
        setFailed(false);
        if (!data.ready) {
          if (retry.tries < MAX_RETRIES) {
            retry.tries += 1;
            retry.timer = window.setTimeout(load, RETRY_DELAY);
          } else {
            setExhausted(true);
          }
        }
      } catch {
        if (active) setFailed(true);
      }
    }

    void load();
    return () => {
      active = false;
      if (retry.timer) window.clearTimeout(retry.timer);
    };
  }, []);

  function playTrack(track: HomeTrack) {
    // Titre déjà chargé : on bascule lecture/pause (sinon on le relancerait).
    if (state?.video_id === track.video_id) {
      void togglePause();
      return;
    }
    void play(track.video_id);
  }

  const isCurrentId = state?.video_id ?? "";
  // La ligne suit l'état temps réel quand il est disponible : elle ne peut donc
  // pas afficher un titre périmé si la lecture a changé depuis le chargement.
  const liveTrack: HomeTrack | null = state?.video_id
    ? { video_id: state.video_id, title: state.title, channel: state.channel }
    : null;
  const resume = liveTrack ?? content?.resume ?? null;
  const resumePlaying = Boolean(liveTrack && !state?.paused);
  const tracks = content?.tracks ?? [];
  const ready = Boolean(content?.ready);
  const pending = !ready && !failed && !exhausted;

  return (
    <div className="mx-auto max-w-5xl space-y-8 py-6">
      <header className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight">
          <Greeting />
        </h1>
        {content?.intro ? (
          <p className="text-muted-foreground max-w-2xl text-sm">
            {content.intro}
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">
            Lecteur musical intelligent — recommandations par IA.
          </p>
        )}
      </header>

      {/* Reprise : le titre chargé — en cours, ou prêt à relancer. */}
      {(resume || pending) && (
        <section aria-labelledby="resume-title">
          <h2
            id="resume-title"
            className="mb-4 flex items-center gap-2 text-xl font-semibold"
          >
            {resumePlaying ? (
              <>
                <Equalizer />
                En cours d’écoute
              </>
            ) : (
              "Reprendre l’écoute"
            )}
          </h2>
          {resume ? (
            <ResumeRow
              track={resume}
              playing={resumePlaying}
              disabled={loading}
              onPlay={() => playTrack(resume)}
            />
          ) : (
            <div
              aria-hidden="true"
              className="bg-surface flex items-center gap-4 rounded-xl p-3"
            >
              <span className="bg-surface-hover size-14 shrink-0 animate-pulse rounded-lg" />
              <span className="flex-1 space-y-2">
                <span className="bg-surface-hover block h-3.5 w-1/3 animate-pulse rounded-full" />
                <span className="bg-surface-hover block h-3 w-1/5 animate-pulse rounded-full" />
              </span>
            </div>
          )}
        </section>
      )}

      {/* Recommandations, habillées par le LLM à partir des données de reco. */}
      <section aria-labelledby="reco-title">
        <div className="mb-4 flex items-center gap-2">
          <h2 id="reco-title" className="text-xl font-semibold">
            {content?.headline || "Recommandé pour toi"}
          </h2>
          {ready && (
            <span className="text-muted-foreground flex items-center gap-1 text-xs">
              <Sparkles className="size-3.5" aria-hidden="true" />
              proposé par l’IA
            </span>
          )}
        </div>

        {pending ? (
          <SectionSkeleton cards={3} />
        ) : failed ? (
          <p className="text-muted-foreground text-sm">
            Impossible de charger tes recommandations pour l’instant. Réessaie
            dans un moment.
          </p>
        ) : tracks.length === 0 ? (
          <div className="bg-surface flex flex-col items-start gap-2 rounded-xl p-6">
            <p className="font-medium">Rien à recommander pour l’instant</p>
            <p className="text-muted-foreground text-sm">
              Écoute quelques titres, ou lance une recherche pour démarrer.
            </p>
            <Link
              href="/search"
              className="text-primary focus-visible:ring-ring/60 mt-1 inline-flex items-center gap-1.5 rounded-full text-sm font-medium focus-visible:ring-3 focus-visible:outline-none"
            >
              <SearchIcon className="size-3.5" aria-hidden="true" />
              Rechercher un titre
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {tracks.map((track, index) => (
              <TrackCard
                key={track.video_id}
                track={track}
                index={index}
                isCurrent={track.video_id === isCurrentId}
                disabled={loading}
                onPlay={() => playTrack(track)}
                sizes="(max-width: 640px) 80vw, 1280px"
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
