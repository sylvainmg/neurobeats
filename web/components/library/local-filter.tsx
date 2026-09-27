"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Search as SearchIcon, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "cn";

/**
 * Barre de recherche à filtrage local.
 *
 * Elle filtre ce qu'on lui donne : pas de requête, pas d'état global. Les
 * listes qu'elle filtre (playlists, titres d'une playlist) vivent déjà en
 * mémoire, un filtrage au rendu suffit et reste instantané.
 *
 * Le compte des résultats est annoncé (`role="status"`) : sans cela, taper
 * « mmz » ne dit rien à un lecteur d'écran, qui ne perçoit le changement
 * que s'on le lui dit. Il est rendu dans une zone de **largeur fixe** —
 * sans cela, « 40 éléments » puis « 12 sur 40 » font varier la largeur et
 * décalent le reste de la ligne, exactement le défaut qu'on corrige ailleurs.
 */
export function LocalFilter({
  label,
  placeholder,
  /** Noms de l'élément compté, au singulier et au pluriel (« playlist », « playlists »). */
  singulier = "élément",
  pluriel = "éléments",
  /** Nombre total d'éléments, avant filtrage. */
  total,
  /** Nombre d'éléments affichés, après filtrage. */
  shown,
  /** Notifie le parent de la requête : c'est lui qui filtre. */
  onQuery,
  className,
}: {
  label: string;
  placeholder: string;
  singulier?: string;
  pluriel?: string;
  total: number;
  shown: number;
  onQuery: (query: string) => void;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  // La requête vit ici — c'est l'unique endroit qui la connaît — mais le
  // filtrage reste chez le parent : il détient la liste.
  const update = useCallback(
    (valeur: string) => {
      setQuery(valeur);
      onQuery(valeur);
    },
    [onQuery],
  );

  // Ctrl/Cmd+F place le curseur dans le champ : c'est le raccourci que
  // tout le monde attend d'un champ de recherche au clavier.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key === "f") {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
      if (
        event.key === "Escape" &&
        document.activeElement === inputRef.current
      ) {
        update("");
        inputRef.current?.blur();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [update]);

  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div className="relative min-w-0 flex-1">
        <label htmlFor={inputId} className="sr-only">
          {label}
        </label>
        <SearchIcon
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2"
          aria-hidden="true"
        />
        <Input
          id={inputId}
          ref={inputRef}
          type="search"
          value={query}
          onChange={(event) => update(event.target.value)}
          placeholder={placeholder}
          className="pr-10 pl-10"
        />
        {query !== "" && (
          <button
            type="button"
            onClick={() => {
              update("");
              inputRef.current?.focus();
            }}
            aria-label="Effacer la recherche"
            className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-1.5 transition-colors"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      <span
        className="text-muted-foreground w-36 shrink-0 text-right text-sm tabular-nums"
        role="status"
        aria-live="polite"
      >
        {total === 0
          ? `Aucun ${singulier}`
          : query === ""
            ? `${total} ${total > 1 ? pluriel : singulier}`
            : shown === 0
              ? "Aucun résultat"
              : `${shown} sur ${total}`}
      </span>
    </div>
  );
}

/**
 * Retire les diacritiques.
 *
 * La plage U+0300–U+036F est construite par code plutôt qu'écrite en
 * littéral : un caractère combinant est invisible dans un éditeur et se
 * perd silencieusement au premier copier-coller.
 */
function sansDiacritiques(valeur: string): string {
  let sortie = "";
  for (const caractere of valeur) {
    const code = caractere.codePointAt(0) ?? 0;
    sortie += code >= 0x300 && code <= 0x36f ? "" : caractere;
  }
  return sortie;
}

/** Normalise pour une recherche insensible aux accents et à la casse. */
export function normaliser(valeur: string): string {
  // Après NFD, les accents deviennent des caractères combinants qu'on retire,
  // pour que « éloïse » se trouve aussi en tapant « eloise ».
  return sansDiacritiques(valeur.toLowerCase().normalize("NFD"));
}

/** Un élément passe-t-il le filtre ? Vide = tout passe. */
export function correspond(query: string, ...champs: string[]): boolean {
  const recherche = normaliser(query.trim());
  if (recherche === "") return true;
  return champs.some((champ) => normaliser(champ).includes(recherche));
}
