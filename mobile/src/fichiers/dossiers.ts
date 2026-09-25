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

/** Paroles rapatriées à l'import : elles voyagent avec le titre, comme l'image. */
export const DOSSIER_PAROLES = new Directory(Paths.document, "paroles");

/**
 * Construit le File d'un fichier du dossier transfert, nom quelconque compris.
 *
 * Un titre YouTube peut porter des crochets (« [Full Ver.] »), légaux dans un
 * chemin système mais pas dans une URI : expo-file-system construit des URI et
 * rejette ces caractères nus (son `move`/`copy` lèvent IllegalArgumentException
 * hors volumes). Le segment est donc encodé ici, pour tous les appels.
 */
export function fichierTransfert(nom: string): File {
  return new File(`${DOSSIER_TRANSFERT.uri}/${encodeURIComponent(nom)}`);
}

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

/**
 * Lit le texte d'un petit fichier du dossier documents, ou "" s'il manque.
 *
 * Une trace de reprise ne doit jamais faire crasher son lecteur : toute lecture
 * qui échoue rend simplement le contenu vide.
 */
export function lireTexteDocument(nom: string): string {
  try {
    const fichier = new File(Paths.document, nom);
    return fichier.exists ? fichier.textSync() : "";
  } catch {
    return "";
  }
}

/**
 * Écrit un texte dans un petit fichier du dossier documents.
 *
 * Le fichier est créé s'il n'existe pas. Une écriture qui échoue (disque
 * saturé, droits) est silencieuse : une trace de reprise manquante ne doit
 * jamais faire échouer un téléchargement en cours.
 */
export function ecrireTexteDocument(nom: string, contenu: string) {
  try {
    const fichier = new File(Paths.document, nom);
    if (!fichier.exists) fichier.create({ intermediates: true, overwrite: true });
    fichier.write(contenu);
  } catch {
    // la persistance est un filet de sécurité, pas un contrat du transfert
  }
}
