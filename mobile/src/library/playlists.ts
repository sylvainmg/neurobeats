/**
 * Ce qu'une playlist annonce d'elle-même.
 *
 * Une seule ligne : le nombre de titres. L'état d'avancement n'est pas dit ici,
 * la ligne le montre — la pastille verte de synchronisation quand tout est là,
 * le compte manquant avec la petite flèche de nuage sinon. Pas de poids
 * affiché : ce qui compte pour celui qui écoute, c'est ce qu'il y a dedans, pas
 * ce que ça pèse.
 */
import { pluraliser } from "@/transfer/format";

/** Segment d'adresse pour les titres sans playlist : `/playlist/sans`. */
export const SANS_PLAYLIST = "sans";

export type ResumePlaylist = { titres: number; chez_toi: number; octets: number };

/** « 18 titres ». */
export function resumeDePlaylist(titres: number): string {
  return pluraliser(titres, "titre");
}
