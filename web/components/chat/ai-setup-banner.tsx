"use client";

import Link from "next/link";
import { Wrench } from "lucide-react";

import { useAiStatus } from "@/components/profile/ai-settings";

/**
 * Bandeau discret « modèle IA non configuré » (gating doux).
 *
 * Le streaming, la file et les recommandations vivent sans IA : on n'empêche
 * rien. On prévient juste que le chat et les habillages resteront limités tant
 * qu'aucun fournisseur n'est réglé, avec un raccourci vers Profil → IA.
 */
export function AiSetupBanner() {
  const status = useAiStatus();
  if (!status || status.configured) return null;

  return (
    <div
      role="note"
      className="border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200 mx-3 my-2 flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs"
    >
      <span className="min-w-0 flex-1">
        Modèle IA non configuré — le chat et certains habillages resteront
        limités.
      </span>
      <Link
        href="/profile?tab=ia"
        className="bg-amber-500/20 hover:bg-amber-500/30 inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 font-medium no-underline"
      >
        <Wrench className="size-3" aria-hidden="true" />
        Configurer
      </Link>
    </div>
  );
}