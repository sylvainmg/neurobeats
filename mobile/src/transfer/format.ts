/**
 * Formatage des mesures : durées, progression.
 *
 * Tout passe par ici pour que les nombres s'écrivent partout de la même façon.
 */

/** 154 -> « 2:34 » ; 3725 -> « 1:02:05 ». */
export function formaterDuree(secondes: number | null | undefined): string {
  if (!secondes || !Number.isFinite(secondes) || secondes <= 0) return "—";
  const total = Math.round(secondes);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const deux = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${deux(m)}:${deux(s)}` : `${m}:${deux(s)}`;
}

/** Estimation avant transfert : durée × débit annoncé par le bureau. */
export function estimerPoids(dureeSecondes: number, debitBitsParSeconde: number): number {
  if (!dureeSecondes || !debitBitsParSeconde) return 0;
  return Math.round((dureeSecondes * debitBitsParSeconde) / 8);
}

/** 0.42 -> « 42 % » (jamais de décimale : une progression n'a pas besoin de plus). */
export function formaterPourcent(fraction: number): string {
  if (!Number.isFinite(fraction)) return "0 %";
  return `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)} %`;
}

/** « 3 titres », « 1 titre », « 0 titre ». */
export function pluraliser(nombre: number, singulier: string, pluriel?: string): string {
  return `${nombre} ${nombre > 1 ? (pluriel ?? `${singulier}s`) : singulier}`;
}
