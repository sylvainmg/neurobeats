/**
 * Tirage sans remise.
 *
 * `melanger` retourne une permutation complète de la file : chaque titre n'est
 * tiré qu'une fois, et toute la file est épuisée avant qu'une passe ne se
 * répète. La boucle infinie du lecteur re-tire une nouvelle permutation à
 * chaque passe — c'est ce qui rend la lecture aléatoire sans blocs répétés.
 *
 * L'alea est injecté : la permutation est alors déterministe, donc testable
 * sans dépendre du hasard, et l'appelant choisit sa source.
 */
import type { PisteLecture } from "@/playback/store";

export type Alea = () => number;

export function melanger(file: readonly PisteLecture[], alea: Alea = Math.random): PisteLecture[] {
  const ordre = [...file];
  for (let i = ordre.length - 1; i > 0; i--) {
    const j = Math.floor(alea() * (i + 1));
    [ordre[i], ordre[j]] = [ordre[j], ordre[i]];
  }
  return ordre;
}

/**
 * La file en ordre aléatoire pour un titre gardé en tête.
 *
 * Le titre choisi reste premier, tout le reste est tiré sans remise : c'est
 * l'ordre de lecture, pas l'indexation de la bibliothèque. La file passée n'est
 * jamais réordonnée — elle est copiée, et l'injection de `alea` rend le tirage
 * testable.
 */
export function tirageEnTete(
  file: readonly PisteLecture[],
  tete: PisteLecture,
  alea: Alea = Math.random,
): PisteLecture[] {
  return [tete, ...melanger(file.filter((piste) => piste.id !== tete.id), alea)];
}