"use client";

/**
 * Logique client des paroles : fetch + cache, horloge de lecture virtuelle,
 * et estimation des temps pour les paroles non synchronisées.
 *
 * La lecture audio vit côté serveur (mpv) : le navigateur ne reçoit que la
 * position poussée par WebSocket (~4 Hz). `usePlaybackClock` interpole entre
 * deux snapshots pour obtenir un temps fluide, et `findActiveLine` sélectionne
 * la ligne karaoké courante.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type LyricLine, type LyricsPayload } from "@/lib/api";

// Cache de session : rouvrir le panneau est instantané, et le serveur garde
// lui-même un cache long (30 j) — ce Map ne sert qu'à éviter un aller-retour
// de plus à la réouverture d'un titre déjà consulté.
const lyricsCache = new Map<string, LyricsPayload>();

export type LyricsStatus = "idle" | "loading" | "ready" | "error";

export interface LyricsResult {
  payload: LyricsPayload | null;
  /** video_id auquel appartient `payload` (pour ignorer un résultat périmé). */
  payloadVideoId: string | null;
  status: LyricsStatus;
  error: string | null;
  retry: () => void;
}

/**
 * Charge les paroles du titre courant.
 *
 * Le fetch est systématique à chaque changement de titre, panneau ouvert ou
 * non : à l'ouverture le panneau affiche immédiatement un résultat déjà prêt.
 * Le coût est amorti (~1 requête/titre) par le cache serveur 30 j et le cache
 * de session ci-dessus.
 *
 * @param active  Ne sert plus qu'à l'état dérivé « idle » (panneau fermé) :
 *   n'influence plus le déclenchement du chargement.
 *
 * L'état précédent est conservé pendant un chargement (rélisable au titre
 * suivant) : l'affichage reste stable et seul un vrai changement de titre
 * affiche le squelette.
 */
export function useLyricsForTrack(
  videoId: string | null | undefined,
  title: string,
  channel: string,
  duration: number | null | undefined,
  active: boolean,
): LyricsResult {
  const [payload, setPayload] = useState<LyricsPayload | null>(null);
  const [payloadVideoId, setPayloadVideoId] = useState<string | null>(null);
  const [status, setStatus] = useState<LyricsStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  // Incrémenté par `retry()` : force un aller-retour réseau même si la session
  // a déjà consulté ce titre (le cache serveur reste un filet instantané).
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!videoId) {
      return;
    }
    // Tout chargement passe par un callback différé (motif du repo, cf.
    // player-context `setTimeout(refresh, 0)`) : l'effet ne fait que planifier,
    // il n'écrit aucun état de façon synchrone (lint react-hooks).
    // `done` vit au niveau de l'effet : un cleanup rendu depuis le callback
    // différé serait perdu et laisserait un fetch périmé écraser le titre
    // suivant ; ici il protège l'async tant que l'effet n'a pas re-rendu.
    let done = false;
    const timer = window.setTimeout(() => {
      // Réouverture d'un titre déjà consulté dans la session : aucune requête.
      // Le cache n'est valable que si la durée était connue : un résultat
      // obtenu sans elle peut être corrigé par son arrivée (LRCLIB arbitre
      // mieux la signature avec la durée) — on ne le ressort pas, l'effet
      // relance un vrai fetch (duration est une dépendance).
      if (attempt === 0 && duration != null && duration > 0) {
        const cached = lyricsCache.get(videoId);
        if (cached) {
          setPayload(cached);
          setPayloadVideoId(videoId);
          setError(null);
          setStatus("ready");
          return;
        }
      }
      setStatus("loading");
      (async () => {
        try {
          const data = await api.lyrics(videoId, title, channel, duration);
          if (done) return;
          // Ne conserver que les réponses obtenues avec la durée connue : les
          // autres pourraient être corrigées par son arrivée (cf. lecture).
          if (duration != null && duration > 0) lyricsCache.set(videoId, data);
          setPayload(data);
          setPayloadVideoId(videoId);
          setError(null);
          setStatus("ready");
        } catch (err) {
          if (done) return;
          if (err instanceof DOMException && err.name === "AbortError") return;
          // Marque l'erreur pour CE titre : l'ancien payload reste affichable.
          setPayloadVideoId(videoId);
          setError(err instanceof Error ? err.message : String(err));
          setStatus("error");
        }
      })();
    }, 0);
    return () => {
      done = true;
      window.clearTimeout(timer);
    };
  }, [videoId, title, channel, duration, attempt]);

  const retry = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

  // « idle » est un état dérivé (panneau fermé ou aucun titre) : le garder
  // dans l'état obligerait l'effet à écrire dessus, ce que le lint interdit.
  const effectiveStatus: LyricsStatus =
    !active || !videoId ? "idle" : status;

  return { payload, payloadVideoId, status: effectiveStatus, error, retry };
}

/**
 * Horloge de lecture fluide, interpolée depuis les snapshots WebSocket.
 *
 * Chaque événement « now » (position, pause) réinitialise la base ; entre deux,
 * le temps défile à l'heure réelle tant que la lecture tourne. Une pause gèle
 * l'horloge. La boucle est bornée à ~8 Hz : la ligne active ne change qu'aux
 * changements de timestamp, inutile de re-rendre 60×/s.
 *
 * @param enabled  Panneau fermé : aucune boucle rAF (rien à animer). Le
 *   premier tick à la réouverture resynchronise depuis le dernier snapshot.
 */
export function usePlaybackClock(
  position: number | null | undefined,
  paused: boolean,
  playing: boolean,
  enabled: boolean,
): number {
  const base = useRef({ pos: 0, t: 0, paused: true });
  const [clock, setClock] = useState(0);

  // Chaque snapshot « now » réinitialise la base ; l'horloge n'est JAMAIS
  // écrite de façon synchrone dans l'effet (lint react-hooks) : le premier
  // tick de la boucle resynchronise, et un tick unique suffit quand la lecture
  // est gelée (la position ne change alors jamais toute seule).
  useEffect(() => {
    if (!enabled) return;
    const p = Math.max(0, position ?? 0);
    const frozen = paused || !playing;
    base.current = { pos: p, t: performance.now(), paused: frozen };
    const first = requestAnimationFrame(() => {
      const b = base.current;
      setClock(b.paused ? b.pos : b.pos + (performance.now() - b.t) / 1000);
    });
    if (frozen) return () => cancelAnimationFrame(first);
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      // ~8 Hz : la ligne active ne change qu'aux changements de timestamp,
      // inutile de re-rendre 60×/s.
      if (now - last >= 120) {
        last = now;
        const b = base.current;
        setClock(b.paused ? b.pos : b.pos + (now - b.t) / 1000);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(raf);
    };
  }, [position, paused, playing, enabled]);

  return clock;
}

/**
 * Répartition estimée des lignes sur la durée, pour les paroles non
 * synchronisées : intro/outro ~8 % puis pas régulier. C'est ce qui permet le
 * défilement auto approximatif exigé pour les textes sans horodatage.
 * Les lignes déjà horodatées passent inchangées.
 */
export function estimateLineTimes(
  lines: LyricLine[],
  duration: number | null | undefined,
): LyricLine[] {
  if (!duration || duration <= 0 || lines.length === 0) return lines;
  if (lines.some((line) => line.time != null)) return lines;
  const margin = Math.max(6, duration * 0.08);
  const usable = Math.max(0, duration - margin * 2);
  const steps = lines.filter((line) => line.text.trim()).length || 1;
  const step = usable / steps;
  const times = new Map<number, number>();
  let cursor = margin;
  lines.forEach((line, index) => {
    if (line.time != null) {
      cursor = line.time;
      times.set(index, line.time);
    } else if (line.text.trim()) {
      times.set(index, cursor);
      cursor += step;
    }
  });
  return lines.map((line, index) => {
    const time = times.get(index);
    return time === undefined ? line : { ...line, time };
  });
}

/**
 * Index de la ligne active : la dernière dont le temps est <= `time`.
 *
 * Les lignes sans temps (séparateurs vides) ne sont jamais actives — et elles
 * ne doivent pas perturber la recherche : on cherche parmi les lignes
 * horodatées uniquement, puis on renvoie l'index d'origine.
 */
export function findActiveLine(lines: LyricLine[], time: number): number {
  const timed: { index: number; time: number }[] = [];
  lines.forEach((line, index) => {
    if (line.time != null) timed.push({ index, time: line.time });
  });
  let low = -1;
  let high = timed.length;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (timed[mid].time > time) high = mid;
    else low = mid;
  }
  return low < 0 ? -1 : timed[low].index;
}

const SECTION_LABEL = /^\[[^\]\n]+\]$/;

/** Vrai si la ligne est un marqueur de section (« [Refrain] »). */
export function isSectionLabel(text: string): boolean {
  return SECTION_LABEL.test(text.trim());
}

/**
 * Teinte stable dérivée du titre : le dégradé de fond du panneau paroles
 * change avec le morceau, sans jamais clignoter (aucun aléa).
 */
export function trackHue(text: string): number {
  let hash = 0;
  for (const char of text) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
  }
  return hash;
}

/**
 * Saut d'horloge au-delà duquel on considère un seek utilisateur (mpv) plutôt
 * qu'un simple changement de ligne : le scroll devient instantané, sans
 * glissade à travers les lignes intermédiaires.
 */
export const SEEK_JUMP_SECONDS = 1.2;