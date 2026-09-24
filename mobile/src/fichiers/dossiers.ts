/**
 * Où vivent les fichiers du téléphone, et comment on les efface.
 *
 * `expo-file-system` 57 a retiré son ancienne API de la racine : `downloadAsync`,
 * `deleteAsync`, `getInfoAsync`, `createDownloadResumable` n'y sont plus que des
 * stubs qui **lèvent** (voir `legacyWarnings.ts` du paquet). Elles étaient
 * appelées telles quelles — et comme les appels étaient enveloppés dans des
 * `try/catch` qui rendaient `null`, la panne était invisible : les pochettes ne
 * se sont jamais mises en cache, et le téléchargement de secours échouait
 * toujours. Le typecheck ne pouvait pas le voir, les signatures existant.
 *
 * Tout passe désormais par `File` et `Directory`, qui portent leurs propres
 * opérations : un seul endroit décrit les dossiers, et une fonction disparue
 * casse à la compilation, pas en silence à l'exécution.
 */
import { Directory, File, Paths } from "expo-file-system";

/** Titres reçus quand le module natif n'est pas compilé dans la version installée. */
export const DOSSIER_TRANSFERT = new Directory(Paths.document, "transfert");

/** Pochettes rapatriées à l'import, pour rester visibles en mode avion. */
export const DOSSIER_POCHETTES = new Directory(Paths.document, "pochettes");

/** Crée un dossier sans se plaindre s'il existe déjà. */
export function assurerDossier(dossier: Directory) {
  try {
    dossier.create({ intermediates: true, idempotent: true });
  } catch {
    // déjà créé, ou créé entre-temps : rien à faire
  }
}

/**
 * Supprime un fichier, y compris s'il n'est plus là.
 *
 * La base reste la référence ; entre elle et le disque il peut toujours y avoir
 * un décalage (fichier effacé par une autre application, transfert avorté). Un
 * nettoyage ne doit jamais s'arrêter sur ce décalage.
 */
export function supprimerFichier(fichier: File) {
  try {
    fichier.delete();
  } catch {
    // le fichier n'existe plus : c'est exactement le résultat voulu
  }
}

/** Taille d'un fichier, ou 0 s'il n'est pas lisible. */
export function tailleDe(fichier: File): number {
  try {
    return fichier.exists ? (fichier.size ?? 0) : 0;
  } catch {
    return 0;
  }
}
