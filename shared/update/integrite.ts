/**
 * Vérification d'intégrité — la porte qui protège l'exécution d'un binaire
 * téléchargé.
 *
 * Le calcul du condensat dépend de la plateforme (`node:crypto` sur Electron,
 * `expo-crypto` sur React Native), donc il vit dans les coquilles. Ce module ne
 * fournit que la COMPARAISON, en temps constant et insensible à la casse : c'est
 * la partie qu'on veut tester une fois pour toutes, et qui ne doit jamais être
 * réimplémentée différemment d'une plateforme à l'autre.
 */

/**
 * Compare une empreinte calculée à celle annoncée par le manifeste.
 *
 * @param calculee hexadécimale, telle que produite par la couche plateforme
 * @param attendue hexadécimale, telle que lue dans le manifeste
 * @returns true seulement si les deux concordent, quelle que soit la casse.
 *
 * La comparaison parcourt les deux chaînes caractère par caractère sans
 * court-circuit : la durée ne doit pas révéler le nombre de caractères corrects.
 * Le coût est négligeable face à un téléchargement, et l'intérêt réel est qu'un
 * attaquant ne peut pas affiner son empreinte par essais successifs.
 */
export function empreinteValide(calculee: unknown, attendue: unknown): boolean {
  if (typeof calculee !== "string" || typeof attendue !== "string") return false;
  const a = calculee.trim().toLowerCase();
  const b = attendue.trim().toLowerCase();
  if (a.length !== b.length) return false;
  let ecart = 0;
  for (let i = 0; i < a.length; i += 1) {
    ecart |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return ecart === 0;
}
