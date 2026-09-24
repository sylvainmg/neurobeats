"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Music4, RefreshCw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { TrackCover } from "@/components/track-cover";
import { usePlayer } from "@/components/player/player-context";
import { coverSizes } from "@/lib/track";
import {
  SEEK_JUMP_SECONDS,
  estimateLineTimes,
  findActiveLine,
  isSectionLabel,
  trackHue,
  useLyricsForTrack,
  usePlaybackClock,
} from "@/lib/lyrics";
import { cn } from "cn";

/** Délai de reprise du défilement auto après une interaction manuelle. */
const AUTO_SCROLL_GRACE_MS = 3500;

/** Durée du fondu de sortie — doit correspondre aux keyframes CSS `nb-leave`. */
const EXIT_MS = 200;

const SOURCE_LABELS: Record<string, string> = {
  lrclib: "LRCLIB",
  genius: "Genius",
};

/** « m:ss » court pour les libellés accessibles des lignes cliquables. */
function formatSeconds(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Pause du défilement auto : la roue/tactile prend la main 3,5 s. */
function SkeletonLines() {
  return (
    <div
      aria-hidden
      className="mx-auto flex max-w-2xl flex-col gap-3.5 px-7 py-4 sm:px-10"
    >
      {Array.from({ length: 9 }, (_, index) => (
        <div
          key={index}
          className="bg-white/10 h-6 animate-pulse rounded-md"
          style={{ width: `${58 + ((index * 19) % 38)}%` }}
        />
      ))}
    </div>
  );
}

function EmptyState({
  icon,
  title,
  hint,
  children,
}: {
  icon?: React.ReactNode;
  title: string;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      {icon ?? <Music4 className="text-white/40 size-10" />}
      <p className="text-white/90 text-lg font-semibold">{title}</p>
      {hint ? <p className="text-white/55 max-w-sm text-sm">{hint}</p> : null}
      {children}
    </div>
  );
}

/**
 * Grand panneau paroles, inspiré de Spotify : plein cadre au-dessus de la barre
 * du lecteur, texte large centré, ligne courante mise en évidence et recentrée
 * automatiquement.
 *
 * Deux modes :
 *  - synchronisé (LRCLIB) : la ligne active suit l'horloge de lecture ;
 *  - texte brut (Genius ou LRCLIB sans sync) : les temps sont estimés
 *    (`estimateLineTimes`), ce qui conserve un défilement auto approximatif.
 *
 * Karaoké façon spotify-local : chaque ligne horodatée est cliquable (clic ou
 * Entrée/Espace) et seek le lecteur à son instant exact ; un saut d'horloge
 * > `SEEK_JUMP_SECONDS` (seek) fait un scroll instantané, sans glissade à
 * travers les lignes intermédiaires. Sans horodatage, les lignes sont réparties
 * sur la durée (`estimateLineTimes`) : le panneau défile alors en continu.
 *
 * Le défilement auto cède la main dès que l'utilisateur scrolle (roue/tactile)
 * et la reprend 3,5 s après ; `prefers-reduced-motion` coupe l'animation.
 */
export function LyricsOverlay({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { state, seek } = usePlayer();
  const videoId = state?.video_id ?? null;
  const title = state?.title ?? "";
  const channel = state?.channel ?? "";
  const duration = state?.duration ?? null;
  const playing = Boolean(state?.playing);
  const paused = Boolean(state?.paused);

  // Horloge coupée panneau fermé : rien à animer, la boucle rAF reprend au
  // premier tick après réouverture (resync depuis le dernier snapshot WS).
  const clock = usePlaybackClock(state?.position, paused, playing, open);
  const { payload, payloadVideoId, status, error, retry } = useLyricsForTrack(
    videoId,
    title,
    channel,
    duration,
    open && Boolean(videoId),
  );

  // Lignes effectives : synchronisées telles quelles, sinon réparties dans la
  // durée pour un défilement estimé (fallback quand la source n'a pas
  // d'horodatage : le panneau défile en continu à vitesse approximativement
  // constante). Recalculées seulement quand les données ou la durée changent,
  // pas à chaque tick d'horloge.
  const lines = useMemo(() => {
    if (!payload || !payload.found || payload.instrumental) return [];
    return payload.synced
      ? payload.lines
      : estimateLineTimes(payload.lines, duration);
  }, [payload, duration]);

  const active = useMemo(
    () => (lines.length ? findActiveLine(lines, clock) : -1),
    [lines, clock],
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const suspended = useRef(false);
  const suspendTimer = useRef<number | null>(null);
  const reduced = useRef(false);
  const lastScrolledClock = useRef<number | null>(null);
  const lastCenteredKey = useRef<string | null>(null);
  // Premier recentrage après (ré)ouverture : instantané, pas de glissade
  // depuis le haut du panneau vers la ligne courante.
  const firstCenter = useRef(false);

  // Cycle de vie de l'affichage : le panneau reste monté le temps du fondu de
  // sortie (`closing` porte la classe `nb-leave`), le démontage réel n'intervient
  // qu'à la fin. Changement retardé d'un tick (motif repo) pour rester conforme
  // à la règle de lint : une réouverture rapide annule la sortie en cours.
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    reduced.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  // Réouverture du panneau : re-centrer la ligne active (un scroll manuel
  // avant fermeture aurait laissé une vue périmée). `lastScrolledClock` n'est
  // pas réinitialisé : un morceau qui a avancé pendant la fermeture reste un
  // saut > 1,2 s → scroll instantané, pas de glissade.
  useEffect(() => {
    if (open) {
      lastCenteredKey.current = null;
      firstCenter.current = true;
    }
  }, [open]);

  // Centre la ligne active. Un saut d'horloge > SEEK_JUMP_SECONDS = seek
  // (clic sur une ligne ou pilote externe) : scroll instantané, pas de glissade
  // à travers les lignes intermédiaires. Désactivé pendant l'interaction
  // manuelle (roue/tactile : la prise en main dure 3,5 s).
  useEffect(() => {
    if (!open || !mounted || active < 0 || suspended.current) return;
    const jump =
      lastScrolledClock.current !== null &&
      Math.abs(clock - lastScrolledClock.current) > SEEK_JUMP_SECONDS;
    lastScrolledClock.current = clock;
    const key = `${videoId ?? ""}:${active}`;
    if (!jump && lastCenteredKey.current === key) return;
    const line = scrollRef.current?.querySelector<HTMLElement>(
      `[data-line="${active}"]`,
    );
    // Paroles déjà en cache : l'effet tourne avant que le panneau démonte son
    // contenu (ref encore nul) — ne rien marquer, le recentrage se fera au
    // montage, quand la ligne existera.
    if (!line) return;
    lastCenteredKey.current = key;
    const first = firstCenter.current;
    firstCenter.current = false;
    line.scrollIntoView({
      block: "center",
      behavior: jump || first || reduced.current ? "auto" : "smooth",
    });
  }, [open, mounted, active, clock, videoId]);

  // Focus sur le bouton de fermeture à l'ouverture (boîte de dialogue modale).
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  useEffect(
    () => () => {
      if (suspendTimer.current !== null) window.clearTimeout(suspendTimer.current);
    },
    [],
  );

  // Hauteur réservée par ligne : chaque ligne garde la hauteur qu'elle aura en
  // état ACTIF (texte agrandi, tel que mesuré par une sonde invisible). Quand
  // une ligne trop longue passe de 1 à 2 lignes, sa boîte ne change donc jamais
  // de hauteur : la mise en page ne bouge pas, la croissance se joue à
  // l'intérieur de la boîte déjà réservée. Remplace `interpolate-size`
  // (inégalement supporté), qui laissait le saut subsister.
  const listRef = useRef<HTMLOListElement | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const apply = () => {
      for (const li of list.querySelectorAll<HTMLLIElement>("[data-line]")) {
        const probe = li.querySelector<HTMLElement>("[data-probe]");
        // La sonde est hors flux : sa hauteur reflète le texte agrandi sans
        // peser sur la mise en page.
        if (probe) {
          li.style.height = `${Math.ceil(probe.getBoundingClientRect().height)}px`;
        }
      }
    };
    // Mesure avant le premier affichage (pas d'animation au montage), puis à
    // chaque changement de largeur (redimensionnement de fenêtre).
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(list);
    return () => observer.disconnect();
  }, [lines, mounted, videoId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (open) {
        setMounted(true);
        setClosing(false);
      } else {
        setClosing(true);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [closing]);

  function stopAutoScroll() {
    suspended.current = true;
    if (suspendTimer.current !== null) window.clearTimeout(suspendTimer.current);
    suspendTimer.current = window.setTimeout(() => {
      suspended.current = false;
    }, AUTO_SCROLL_GRACE_MS);
  }

  if (!mounted) return null;

  // Le résultat appartient-il au titre affiché ? (garde un payload périmé
  // pendant le chargement : pas de flash entre deux titres.)
  const current = payloadVideoId === videoId;
  const hue = trackHue(title || "NeuroBeats");
  const sourceLabel = payload?.source
    ? SOURCE_LABELS[payload.source] ?? payload.source
    : "";
  const badge =
    payload?.found === true
      ? payload.instrumental
        ? "Titre instrumental"
        : payload.synced
          ? `Paroles synchronisées · ${sourceLabel}`
          : `Paroles · défilement estimé · ${sourceLabel}`
      : "Paroles";

  const body = (() => {
    if (!videoId) {
      return (
        <EmptyState title="Lance un titre pour voir les paroles" hint="Le panneau suit la lecture en direct." />
      );
    }
    if (status === "error") {
      return (
        <EmptyState
          icon={<RefreshCw className="text-white/40 size-10" />}
          title="Paroles indisponibles"
          hint={error ?? "Impossible de contacter le serveur."}
        >
          <Button variant="secondary" size="sm" onClick={retry}>
            <RefreshCw /> Réessayer
          </Button>
        </EmptyState>
      );
    }
    if (payload && current) {
      // Panne transitoire d'une source (ex. 403 Genius) : on n'a pas pu
      // s'assurer que le titre n'a pas de paroles. Le message annonce
      // honnêtement qu'aucune parole n'a été trouvée, et on propose
      // « Réessayer ».
      if (payload.retryable && !payload.found) {
        return (
          <EmptyState
            icon={<RefreshCw className="text-white/40 size-10" />}
            title="Paroles indisponibles"
            hint={payload.message ?? "Aucune parole trouvée pour ce titre."}
          >
            <Button variant="secondary" size="sm" onClick={retry}>
              <RefreshCw /> Réessayer
            </Button>
          </EmptyState>
        );
      }
      if (payload.instrumental) {
        return (
          <EmptyState
            title="Titre instrumental"
            hint="Rien à chanter : profite de l'instant."
          />
        );
      }
      if (payload.found) {
        return (
          <ol
            ref={listRef}
            className="mx-auto flex max-w-2xl flex-col px-7 py-2 pb-32 sm:px-10"
          >
            {lines.map((line, index) => {
              const isActive = index === active;
              const section = isSectionLabel(line.text);
              const lineTime = line.time;
              // Lignes karaoké cliquables : sections et séparateurs sans temps
              // restent inertes (aria ni clic), miroir du fork spotify-local.
              const seekable = !section && lineTime != null;
              return (
                <li
                  key={index}
                  data-line={index}
                  role={seekable ? "button" : undefined}
                  tabIndex={seekable ? 0 : undefined}
                  aria-label={
                    seekable
                      ? `Aller à ${formatSeconds(lineTime as number)} — ${line.text}`
                      : undefined
                  }
                  onClick={
                    seekable
                      ? () => void seek(lineTime as number)
                      : undefined
                  }
                  onKeyDown={
                    seekable
                      ? (event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            void seek(lineTime as number);
                          }
                        }
                      : undefined
                  }
                  className={cn(
                    // `font-size` est volontairement absent de la transition :
                    // en grossissant (text-lg → text-2xl) une ligne longue
                    // franchit le seuil de retour à la ligne à mi-transition,
                    // ce qui fait « tomber » la ligne excédentaire. Couleur et
                    // opacité fondent (500 ms), mais la ligne devient
                    // directement 2 lignes quand le curseur passe dessus.
                    // `relative` : la sonde de hauteur (data-probe) s'ancre
                    // dans la boîte de la ligne.
                    "relative transition-[color,opacity,border-color,background-color] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]",
                    seekable &&
                      "cursor-pointer rounded-lg outline-none select-none focus-visible:bg-white/10 focus-visible:opacity-100",
                    section
                      ? "text-primary pt-4 text-sm font-semibold tracking-[0.2em] uppercase"
                      : isActive
                        ? "text-white text-2xl leading-snug font-bold opacity-100 sm:text-[1.7rem]"
                        : "text-white/50 text-lg leading-snug sm:text-xl",
                  )}
                >
                  {!section && (
                    <span
                      aria-hidden
                      data-probe
                      className="invisible absolute inset-x-0 top-0 block border-primary/50 border-l-2 pl-3 text-2xl leading-snug font-bold sm:text-[1.7rem]"
                    >
                      {line.text || "\u00A0"}
                    </span>
                  )}
                  <span
                    className={cn(
                      "block",
                      isActive && !section
                        ? "border-primary/50 border-l-2 pl-3"
                        : "pl-3",
                    )}
                  >
                    {line.text || "\u00A0"}
                  </span>
                </li>
              );
            })}
          </ol>
        );
      }
      return (
        <EmptyState
          title="Aucune parole pour ce titre"
          hint="Les sources gratuites consultées (LRCLIB, Genius) n'ont rien pour ce morceau."
        />
      );
    }
    return <SkeletonLines />;
  })();

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Paroles du titre en cours"
      className={cn(
        "border-border bg-card fixed inset-x-2 top-2 bottom-24 z-40 overflow-hidden rounded-2xl border shadow-[0_20px_60px_rgba(0,0,0,0.55)]",
        // Une seule animation à la fois : entrée (nb-rise) puis, à la sortie,
        // fondu nb-leave pendant lequel le panneau ignore les interactions.
        closing ? "nb-leave pointer-events-none" : "nb-rise",
      )}
      style={{
        backgroundImage: [
          `radial-gradient(90rem 42rem at 78% -12%, hsl(${hue} 62% 26% / 0.65), transparent 62%)`,
          `radial-gradient(50rem 30rem at 8% 108%, hsl(${(hue + 180) % 360} 50% 16% / 0.5), transparent 60%)`,
          "linear-gradient(180deg, var(--card), oklch(0.155 0.015 255) 72%)",
        ].join(", "),
      }}
    >
      <div className="flex h-full flex-col">
        <header className="flex shrink-0 items-end justify-between gap-3 p-4 sm:p-6">
          <div className="flex min-w-0 items-end gap-3 sm:gap-4">
            {videoId ? (
              <TrackCover
                videoId={videoId}
                title={title}
                sizes={coverSizes(168)}
                hq
                className="shadow-lg size-20 rounded-lg sm:size-32 lg:size-36"
              />
            ) : null}
            <div className="min-w-0 pb-1">
              <p className="text-white/60 text-[11px] font-semibold tracking-widest uppercase">
                {badge}
              </p>
              <h2 className="text-white truncate text-lg font-bold sm:text-2xl">
                {title || "Aucune lecture"}
              </h2>
              <p className="text-white/55 truncate text-sm">{channel}</p>
            </div>
          </div>
          <Button
            ref={closeRef}
            variant="ghost"
            size="icon"
            aria-label="Fermer les paroles"
            onClick={onClose}
            className="hover:bg-black/40 bg-black/25 self-start rounded-full text-white/80 backdrop-blur-sm hover:text-white"
          >
            <X />
          </Button>
        </header>

        <div
          ref={scrollRef}
          onWheel={stopAutoScroll}
          onTouchStart={stopAutoScroll}
          className="min-h-0 flex-1 overflow-y-auto pb-6"
        >
          {body}
        </div>
      </div>
    </div>
  );
}