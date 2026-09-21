import Image from "next/image";

import logoMark from "@/assets/logo-mark.png";
import { cn } from "cn";

/**
 * Marque NeuroBeats : logo officiel + wordmark.
 *
 * Le fichier est détouré sur fond transparent : les barres du disque sont des
 * réserves, elles prennent donc la couleur de la surface derrière — le logo
 * fonctionne aussi bien sur la sidebar sombre que sur un fond clair.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <Image
        src={logoMark}
        alt=""
        aria-hidden="true"
        sizes="28px"
        className="size-7 shrink-0"
      />
      <span className="font-heading text-base font-bold tracking-tight">
        NeuroBeats
      </span>
    </span>
  );
}
