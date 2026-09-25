"use client";

import Link from "next/link";
import { Wrench, Loader2, AlertTriangle } from "lucide-react";

import { useAiStatus } from "@/components/profile/ai-settings";

/**
 * Bandeau discret « modèle IA non configuré » (gating doux).
 *
 * Le streaming, la file et les recommandations vivent sans IA : on n'empêche
 * rien. On prévient juste que le chat et les habillages resteront limités tant
 * qu'aucun fournisseur n'est réglé, avec un raccourci vers Profil → IA.
 *
 * Gère plusieurs états :
 * - Jamais configuré → bandeau amber avec lien « Configurer »
 * - En chargement / en attente de téléchargement → bandeau bleu avec spinner
 * - Erreur de chargement → bandeau rouge avec message d'erreur
 * - Prêt (ready) ou fournisseur externe → rien à afficher
 */
export function AiSetupBanner() {
  const status = useAiStatus();
  if (!status) return null;

  const { configured, engine } = status;

  // Étape 1 : jamais configuré (aucun fournisseur réglé)
  if (!configured && !engine.state) {
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

  // Étape 2 : en chargement ou en attente de téléchargement
  if (engine.state === "loading" || engine.waiting_for_download) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="border-primary/30 bg-primary/10 text-primary mx-3 my-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs"
      >
        <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          {engine.waiting_for_download
            ? `Téléchargement du modèle ${engine.model_id ?? ""} en cours…`
            : `Chargement du modèle ${engine.model_id ?? ""} en cours… il sera bientôt prêt.`}
        </span>
      </div>
    );
  }

  // Étape 3 : erreur de chargement
  if (engine.state === "error") {
    return (
      <div
        role="alert"
        className="border-destructive/30 bg-destructive/10 text-destructive mx-3 my-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs"
      >
        <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">
          Le chargement de {engine.model_id ?? ""} a échoué : {engine.error ?? "erreur inconnue"}
        </span>
      </div>
    );
  }

  // Étape 4 : rien à afficher (ready ou fournisseur externe)
  return null;
}
