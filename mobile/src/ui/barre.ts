/**
 * Géométrie de la barre de navigation, et de ce qui vit au-dessus d'elle.
 *
 * Trois surfaces s'empilent dans cet ordre : la capsule de navigation, le
 * mini-lecteur quand un titre est chargé, et le bouton flottant de scan. Chacune
 * doit connaître le haut de la précédente — sinon elles se chevauchent, et c'est
 * exactement ce qui arrivait : la carte du mini-lecteur collait à la capsule, et
 * le bouton de scan disparaissait derrière elle.
 *
 * Ces mesures sont donc calculées ici, une fois, au lieu d'être écrites à la main
 * dans chaque écran.
 */
import { space } from "@/theme/tokens";

/** Hauteur de la capsule : cible de 56 dp + les 6 px de marge haute et basse. */
export const HAUTEUR_CAPSULE = 68;

/** Hauteur de la carte du mini-lecteur : vignette de 46 + 2 × 9 de marge. */
export const HAUTEUR_MINI = 64;

/** L'air laissé entre deux surfaces empilées. */
export const ESPACE_PILE = 10;

/** Le bas de la capsule, mesuré depuis le bord de l'écran. */
export function basDeLaCapsule(margeBasse: number): number {
  return Math.max(margeBasse, space.md) + HAUTEUR_CAPSULE;
}

/** Le bas du mini-lecteur : juste au-dessus de la capsule, avec de l'air. */
export function basDuMiniLecteur(margeBasse: number): number {
  return basDeLaCapsule(margeBasse) + ESPACE_PILE;
}

/**
 * Le bas du mini-lecteur quand il n'y a pas de capsule sous lui.
 *
 * La vue d'une playlist est un contenu comme la bibliothèque : le mini-lecteur
 * y vit aussi, mais elle n'a pas de barre d'onglets — il se pose donc simplement
 * au-dessus de la zone de geste.
 */
export function basDuMiniLecteurSeul(margeBasse: number): number {
  return Math.max(margeBasse, space.sm) + ESPACE_PILE;
}

/** Le bas du bouton flottant : au-dessus du mini-lecteur s'il est là. */
export function basDuBoutonFlottant(margeBasse: number, mini: boolean): number {
  const base = basDuMiniLecteur(margeBasse);
  return mini ? base + HAUTEUR_MINI + ESPACE_PILE : base;
}

/** La place à réserver au bas d'une liste pour ne rien cacher sous ces surfaces. */
export function placeEnBas(margeBasse: number, mini: boolean): number {
  return basDuMiniLecteur(margeBasse) + (mini ? HAUTEUR_MINI : 0) + space.xl;
}

/** La même place, dans un écran sans barre d'onglets. */
export function placeSansBarre(margeBasse: number, mini: boolean): number {
  return basDuMiniLecteurSeul(margeBasse) + (mini ? HAUTEUR_MINI + ESPACE_PILE : 0) + space.xl;
}
