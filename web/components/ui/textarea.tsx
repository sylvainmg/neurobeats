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
    const next = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${next}px`;
    // Le défilement n'apparaît qu'une fois le plafond atteint.
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [maxHeight]);

  useIsomorphicLayoutEffect(() => {
    resize();
  }, [props.value, resize]);

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
        "border-input placeholder:text-muted-foreground focus-visible:ring-ring/50 block w-full resize-none overflow-hidden rounded-2xl border-none bg-transparent px-4 py-2.5 text-sm leading-relaxed outline-none focus-visible:ring-2",
        className,
      )}
    />
  );
}
