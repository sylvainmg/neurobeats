/**
 * Côté JavaScript du module natif de transfert.
 *
 * Le module Kotlin reçoit et renvoie du JSON (voir DownloaderModule.kt) : ce
 * fichier est la seule frontière où l'on convertit, pour que le reste de
 * l'application manipule des objets typés et jamais des chaînes.
 *
 * `requireOptionalNativeModule` et non `requireNativeModule` : si la version
 * installée n'a pas le module (Expo Go, par exemple), l'application démarre
 * quand même et retombe sur le téléchargement JavaScript en le disant.
 */
import { requireOptionalNativeModule } from "expo";

export type Spec = {
  videoId: string;
  url: string;
  fichier: string;
  titre: string;
  chaine: string;
  album: string;
  taille?: number;
};

export type EtatTelechargement =
  | "en_file"
  | "en_cours"
  | "termine"
  | "echoue"
  | "suspendu"
  | "annule";

export type Suivi = {
  videoId: string;
  etat: EtatTelechargement;
  recus: number;
  total: number;
  raison?: string;
  uri?: string;
};

type ModuleNatif = {
  enqueue(specsJson: string, wifiUniquement: boolean, nomLot: string): Promise<string>;
  etat(): Promise<string>;
  reprendre(videoId: string, wifiUniquement: boolean): Promise<void>;
  annuler(videoId: string): Promise<void>;
  supprimer(videoId: string, uri: string): Promise<void>;
  verifier(urisJson: string): Promise<string>;
  partager(urisJson: string): Promise<void>;
};

const natif = requireOptionalNativeModule<ModuleNatif>("NeuroBeatsDownloader");

/** Vrai quand le transfert survit à la fermeture de l'application. */
export const transfertPersistant = natif !== null;

/**
 * Confie les transferts au gestionnaire du système et rend les titres refusés.
 *
 * Tout ce qui n'a pas été accepté est rendu, y compris quand le module lui-même
 * échoue : l'appelant peut alors prendre le relais au lieu de laisser des
 * transferts en attente de quelque chose qui n'arrivera jamais.
 *
 * `nomLot` groupe les demandes posees ensemble : le module n'affiche qu'une
 * seule notification par lot. La playlist donne le nom le plus parlant ; sans
 * elle, le module affiche un libellé générique.
 */
export async function mettreEnFile(
  specs: Spec[],
  wifiUniquement: boolean,
  nomLot = "",
): Promise<string[]> {
  const tous = specs.map((spec) => spec.videoId);
  if (!natif) return tous;
  try {
    return JSON.parse(
      await natif.enqueue(JSON.stringify(specs), wifiUniquement, nomLot),
    ) as string[];
  } catch {
    return tous;
  }
}

export async function lireEtats(): Promise<Suivi[]> {
  if (!natif) return [];
  try {
    return JSON.parse(await natif.etat()) as Suivi[];
  } catch {
    return [];
  }
}

export async function reprendre(videoId: string, wifiUniquement: boolean) {
  await natif?.reprendre(videoId, wifiUniquement);
}

export async function annuler(videoId: string) {
  await natif?.annuler(videoId);
}

/** Retire le fichier du téléphone : le transfert en cours, ou la copie publiée. */
export async function supprimer(videoId: string, uri: string) {
  await natif?.supprimer(videoId, uri);
}

/**
 * Rend les URIs dont le fichier existe **vraiment** sur le téléphone.
 *
 * Sans cette vérification, un titre marqué « chez toi » dont le fichier a
 * disparu (nettoyage mémoire, suppression externe) mentirait sur son état :
 * on l'annonce partout « téléchargé » alors que rien ne se lit. Sans module
 * natif (Expo Go), on ne peut pas vérifier : on rend tout tel quel, l'appelant
 * ne doit alors retirer aucun titre.
 */
export async function verifier(uris: string[]): Promise<string[]> {
  if (!natif || uris.length === 0) return uris;
  try {
    return JSON.parse(await natif.verifier(JSON.stringify(uris))) as string[];
  } catch {
    return uris;
  }
}

/**
 * Partage un lot de titres avec une autre application.
 *
 * Les titres publiés dans la bibliothèque sont partageables tels quels ; ceux
 * du dossier privé passent par FileProvider côté Kotlin. Sans module natif
 * (Expo Go), rien ne s'ouvre : l'appelant décide quoi promettre avant.
 */
export async function partager(uris: string[]) {
  const valides = uris.filter((uri) => uri.length > 0);
  if (!natif || valides.length === 0) return;
  await natif.partager(JSON.stringify(valides));
}
