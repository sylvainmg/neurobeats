/**
 * Décisions de relance, sans dépendance native.
 *
 * Isolées ici pour être testables : `downloader.ts` importe le module natif
 * (yt-dlp, expo-file-system), que Jest ne peut pas charger. Ces deux
 * fonctions déterminent quels titres méritent une reprise, et c'est
 * exactement là que le bug se situait.
 */
import type { Suivi } from "modules/downloader";

/**
 * Un titre est livré quand le fichier est là *et* publié dans la bibliothèque
 * publique.
 *
 * Une ligne que le système dit terminée sans URI `content://` (publication
 * MediaStore en attente, ou reliquat de l'ancien repli `file://`) n'est pas
 * jouable partout : le lecteur Musique du téléphone ne la voit pas.
 */
export function estLivre(etat: Suivi): boolean {
  return (
    etat.etat === "termine" && !!etat.uri && etat.uri.startsWith("content://")
  );
}

/**
 * La passe de relance doit-elle s'en occuper ?
 *
 * Deux cas : l'échec franc, et le titre téléchargé dont la publication dans la
 * bibliothèque a échoué. Le second se présente en `en_cours` — l'état d'un
 * téléchargement normal, aucun octet en route — donc rien dans l'état seul
 * ne le distingue. C'est le cas le plus courant sur un gros lot, et c'est
 * pour cela que ces lignes restaient bloquées jusqu'au rescan suivant.
 *
 * `publicationBloquee` vient de la passe de rafraîchissement, qui sait qu'un
 * titre est dans ce cas parce que le module l'a renvoyé `termine` sans URI.
 */
export function estReprisable(
  etat: Suivi,
  publicationBloquee: boolean,
): boolean {
  return etat.etat === "echoue" || (publicationBloquee && etat.etat === "en_cours");
}
