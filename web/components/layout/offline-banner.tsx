"use client";

import { CloudOff } from "lucide-react";

import { useOnline } from "@/lib/online";
import { cn } from "cn";

/**
 * Bandeau « hors ligne » : se pose sous l'en-tête, en place, sans pousser la page.
 *
 * Il ne bloque rien — la lecture, la file, la bibliothèque et l'historique
 * fonctionnent sans réseau. Il dit seulement ce qui ne marchera pas : recherche
 * YouTube, recommandations, paroles, chat, et tout téléchargement. Les boutons
 * concernés sont désactivés ailleurs (`useOnline`), ce bandeau en est le pendant
 * narratif : l'utilisateur comprend *pourquoi* ils sont inertes.
 */
export function OfflineBanner({ className }: { className?: string }) {
  const online = useOnline();
  if (online) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200 mx-3 mb-1 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs",
        className,
      )}
    >
      <CloudOff className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        Hors ligne — la lecture et ta bibliothèque continuent de fonctionner. Recherche,
        recommandations, paroles et chat reviendront avec le réseau.
      </span>
    </div>
  );
}
