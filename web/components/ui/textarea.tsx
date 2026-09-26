"use client";

import * as React from "react";
import { cn } from "cn";

/** Hauteur maximale par défaut (≈ 7-8 lignes, référence ChatGPT/Claude). */
export const TEXTAREA_MAX_HEIGHT = 160;

// `useLayoutEffect` n'existe pas au rendu serveur : on retombe sur `useEffect`
// pour éviter l'avertissement SSR tout en gardant une mesure synchrone au client.
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? React.useLayoutEffect : React.useEffect;

type TextareaProps = React.ComponentProps<"textarea"> & {
  /** Appelé sur Entrée (sans Maj ni composition IME). */
  onSubmit?: () => void;
  /** Plafond de croissance en pixels ; au-delà le texte défile. */
  maxHeight?: number;
};

/**
 * Zone de saisie qui grandit automatiquement avec le contenu jusqu'à `maxHeight`,
 * puis défile en interne (pas de poignée de redimensionnement, pas de double barre).
 *
 * Entrée envoie, Maj+Entrée insère un saut de ligne.
 */
export function Textarea({
  className,
  maxHeight = TEXTAREA_MAX_HEIGHT,
  onSubmit,
  onChange,
  onKeyDown,
  ...props
}: TextareaProps) {
  const ref = React.useRef<HTMLTextAreaElement>(null);

  const resize = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto"; // repart de la hauteur naturelle pour mesurer
    // Un conteneur masqué (`display:none`, onglet inactif…) ne donne aucune
    // hauteur : `scrollHeight` y vaut 0, et le 0 resterait figé jusqu'à la
    // première frappe. On ne fige donc rien tant que la mesure est vide, et on
    // laisse la hauteur naturelle (`rows`) prendre le relais.
    const measured = el.scrollHeight;
    if (measured > 0) {
      const next = Math.min(measured, maxHeight);
      el.style.height = `${next}px`;
      // Le défilement n'apparaît qu'une fois le plafond atteint.
      el.style.overflowY = measured > maxHeight ? "auto" : "hidden";
    } else {
      el.style.height = "";
      el.style.overflowY = "hidden";
    }
  }, [maxHeight]);

  useIsomorphicLayoutEffect(() => {
    resize();
  }, [props.value, resize]);

  // Un onglet monté puis masqué (`forceMount` + `data-[state=inactive]:hidden`)
  // se mesure à 0 à l'ouverture, et le passage en visible n'est pas un
  // changement de `value` : sans cette observation, la hauteur resterait figée
  // jusqu'à la première saisie.
  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => resize());
    observer.observe(el);
    return () => observer.disconnect();
  }, [resize]);

  return (
    <textarea
      {...props}
      ref={ref}
      rows={1}
      data-slot="textarea"
      onChange={(event) => {
        onChange?.(event);
        resize();
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          onSubmit?.();
        }
      }}
      className={cn(
        // `border-none` + `bg-transparent` : ce composant est transparent et n'a
        // pas de bordure, il n'est jamais la surface visible. Un `ring` y
        // déborderait de sa propre largeur (box-shadow externe) au lieu de
        // border l'élément — l'anneau de focus est donc porté par le conteneur
        // qui porte le fond, via `focus-within:`.
        "placeholder:text-muted-foreground block w-full resize-none overflow-hidden rounded-2xl border-none bg-transparent px-4 py-2.5 text-sm leading-relaxed outline-none",
        className,
      )}
    />
  );
}
