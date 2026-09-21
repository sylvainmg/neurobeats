import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "cn";

/**
 * Bouton de retour : capsule de surface detachee du fond (fine bordure + ombre
 * discrete), la ou l'ancien bouton fantome restait transparent. Au survol la
 * surface s'eclaircit et la fleche glisse vers la gauche pour annoncer la sortie.
 */
export function BackButton({
  href,
  label = "Retour",
  className,
}: {
  href: string;
  label?: string;
  className?: string;
}) {
  return (
    <Button
      asChild
      variant="ghost"
      className={cn(
        "h-9 gap-1.5 rounded-full border border-border bg-surface pr-4 pl-3 font-medium text-foreground shadow-sm",
        "transition-[background-color,border-color,transform] duration-200 ease-out",
        "hover:border-white/20 hover:bg-surface-hover active:scale-[0.97]",
        className,
      )}
    >
      <Link href={href}>
        <ArrowLeft className="transition-transform duration-200 ease-out group-hover/button:-translate-x-0.5" />
        {label}
      </Link>
    </Button>
  );
}
