/**
 * Traces des téléchargements directs achevés mais non rapatriés.
 *
 * Le binaire yt-dlp peut finir d'écrire un fichier alors que le transfert vers
 * la bibliothèque n'a pas eu lieu (application fermée au mauvais moment, ou
 * volume qui refuse le renommage) : cette trace retient où le fichier complet
 * attend, pour le réclamer à la reprise sans tout retélécharger.
 *
 * Module pur : pas de module natif ni de file system, pour être testé
 * facilement. La lecture/écriture du fichier appartient au Gestionnaire, qui
 * combine ces fonctions à `lireTexteDocument`/`ecrireTexteDocument`.
 */
export type DirectPerdu = {
  videoId: string;
  /** Chemin (URI encodée ou chemin brut) du fichier achevé, tel qu'annoncé. */
  source: string;
  /** Autre forme du même chemin, quand le moteur en a donné deux. */
  rechange?: string;
  /** Nom du fichier une fois rangé dans la bibliothèque. */
  fichier: string;
  /** Taille annoncée par le moteur, pour un total lisible sans sondage. */
  taille?: number;
};

/** Nom du fichier (dossier documents) qui garde ces traces. */
export const FICHIER_DIRECTS_PERDUS = "directs-perdus.json";

/**
 * Ajoute une trace, en remplaçant celle du même titre s'il y en avait une :
 * deux téléchargements du même `videoId` ne doivent jamais laisser doublon.
 */
export function fusionnerDirectPerdu(
  entrees: DirectPerdu[],
  entree: DirectPerdu,
): DirectPerdu[] {
  return [...entrees.filter((e) => e.videoId !== entree.videoId), entree];
}

/** Efface la trace d'un titre (arrivé à bon port, ou abandonné). */
export function retirerDirectPerdu(entrees: DirectPerdu[], videoId: string): DirectPerdu[] {
  return entrees.filter((e) => e.videoId !== videoId);
}