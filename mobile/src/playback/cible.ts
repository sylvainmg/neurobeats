/**
 * Bornage des positions de seek.
 *
 * Un `seekTo` qui atterrit sur la fin ne termine pas le titre : selon le moteur
 * audio, la même source reboucle au début — le titre « se relance » au lieu de
 * laisser `didJustFinish` passer au suivant. La cible doit donc rester un peu
 * avant la fin réelle, le morceau s'occupe lui-même de finir.
 */
import type { ModeBoucle } from "@/playback/store";

/** Marge avant la fin d'un titre (secondes) : un seek ne doit jamais l'atteindre. */
export const MARGE_FIN = 0.3;

/**
 * Borne une position de seek à la durée réelle du titre, sans l'atteindre.
 *
 * Args:
 *     position: Cible demandée en secondes
 *     duree: Durée réelle streamée par le moteur (pas la métadonnée)
 *
 * Returns:
 *     Une cible dans [0, duree - MARGE_FIN], ou 0 si la durée est inconnue.
 */
export function bornerCible(position: number, duree: number): number {
  if (!Number.isFinite(position) || !Number.isFinite(duree) || duree <= 0) return 0;
  return Math.max(0, Math.min(position, duree - MARGE_FIN));
}

/** Où atterrit un saut : une position précise, ou le titre voisin. */
export type Deplacement = { type: "seek"; cible: number } | { type: "saut"; valeur: number };

/**
 * Planifie un saut en arrière.
 *
 * Le recul ne change jamais de titre : sa frontière est le début du morceau.
 * On recalle à 0, c'est tout — passer au titre précédent relève du bouton
 * dédié (la commande « titre précédent »), pas du saut de secondes.
 */
export function planifierRecul(position: number, saut = 15): { type: "seek"; cible: number } {
  return { type: "seek", cible: Math.max(0, position - saut) };
}

/**
 * Planifie un saut en avant.
 *
 * Dépasser la fin ne sature pas au bout du titre : on démarre le suivant. Sur
 * le dernier titre, on vise la fin (le morceau se termine puis on s'arrête).
 * Durée inconnue (0) -> simple seek, on ne saute pas de titre à l'aveugle.
 */
export function planifierAvance(position: number, duree: number, dernier: boolean, saut = 15): Deplacement {
  if (duree > 0 && position + saut > duree) {
    return dernier ? { type: "seek", cible: duree } : { type: "saut", valeur: 1 };
  }
  return { type: "seek", cible: position + saut };
}

/**
 * Où repartir quand le dernier titre de la passe se termine.
 *
 * 0 = reprendre en tête (lecture aléatoire, dont la passe EST le cycle, ou
 * boucle de file explicitée) ; null = s'arrêter. Le mode "titre" ne décide
 * rien ici : c'est le lecteur qui répète le morceau avant qu'une fin
 * n'arrive (repeat-one) — la file ne doit pas non plus s'arrêter au dernier.
 * On ne boucle jamais sans le dire : une file vide ou sans mode ne repart
 * pas toute seule.
 */
export function apresDernier(
  longueur: number,
  melanger: boolean,
  boucle: ModeBoucle,
): number | null {
  if (longueur === 0) return null;
  if (melanger) return 0;
  if (boucle === "file") return 0;
  return null;
}

/**
 * Le mode suivant sur le bouton « lecture en boucle » : simple → file →
 * titre → simple. C'est le cycle complet qui rend le bouton prévisible — un
 * appui de plus revient toujours à l'état de départ.
 */
export function modeBoucleSuivant(mode: ModeBoucle): ModeBoucle {
  const ordres: ModeBoucle[] = ["simple", "file", "titre"];
  return ordres[(ordres.indexOf(mode) + 1) % ordres.length];
}

/** État de la garde anti double-fin. */
export type GardeFin = { sourceStable: boolean; finConsommee: boolean };

export const gardeFinInitial: GardeFin = { sourceStable: false, finConsommee: false };

/**
 * Garde contre le double fin.
 *
 * But : `didJustFinish` du moteur marque la fin d'un titre… mais `replace()`
 * (expo-audio) est non-bloquant : pendant le chargement du titre suivant,
 * l'ancienne source peut encore renvoyer un statut de fin. Sans garde, on
 * avancerait deux fois — en boucle, le dernier titre ne rebouclerait pas mais
 * passerait à son suivant.
 *
 * Deux amortisseurs :
 * - `sourceStable` : seules les fins d'une source qui a déjà émis un tick
 *   normal (elle est réellement chargée) sont écoutées ;
 * - `finConsommee` : une fin déjà consommée n'est pas rejouée tant qu'un tick
 *   normal n'a pas réarmé la garde (c'est ce réarmement qui valide la source
 *   suivante après son chargement).
 *
 * Args:
 *     etat: L'état courant de la garde
 *     didJustFinish: Le drapeau du moteur pour ce statut
 *
 * Returns:
 *     consommer: Vrai si la fin doit déclencher le titre suivant
 *     prochain: L'état de la garde après ce statut
 */
export function majGardeFin(etat: GardeFin, didJustFinish: boolean): { consommer: boolean; prochain: GardeFin } {
  if (didJustFinish) {
    const consommer = etat.sourceStable && !etat.finConsommee;
    return {
      consommer,
      prochain: { sourceStable: etat.sourceStable, finConsommee: etat.finConsommee || consommer },
    };
  }
  return { consommer: false, prochain: { sourceStable: true, finConsommee: false } };
}