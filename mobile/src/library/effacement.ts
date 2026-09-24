/**
 * Retirer des titres du téléphone : le fichier, la pochette et la ligne de base.
 *
 * Les trois partent ensemble. C'est l'appel isolé à `oublierPiste` qui laissait
 * les fichiers sur le disque : la bibliothèque affichait « 1,2 Go hors ligne »
 * après une suppression, et l'espace n'était jamais rendu.
 *
 * L'ordre est imposé — fichier d'abord, base ensuite — pour qu'une interruption
 * laisse une base qui pointe vers un fichier manquant plutôt que l'inverse. Le
 * premier cas est visible et réparable (la lecture le signale, un nouveau
 * transfert réécrit le fichier) ; le second fuit silencieusement.
 */
import { File } from "expo-file-system";
import * as module from "modules/downloader";

import * as repo from "@/db/repos";
import type { Piste } from "@/db/repos";
import { supprimerFichier } from "@/fichiers/dossiers";
import { oublierPochettes } from "@/transfer/covers";

/**
 * Efface le fichier d'un titre.
 *
 * Le chemin natif doit passer par le module : la copie d'un titre reçu est
 * publiée dans la bibliothèque du téléphone, et seule une suppression via
 * MediaStore retire l'entrée et le fichier. L'URI peut aussi ne pas être
 * exploitable si la version installée a changé de mode ; la ligne de base est
 * alors mise à jour quand même plutôt que de bloquer la suppression.
 */
async function effacerFichier(videoId: string, uri: string) {
  if (module.transfertPersistant) {
    await module.supprimer(videoId, uri);
    return;
  }
  try {
    supprimerFichier(new File(uri));
  } catch {
    // URI de contenu sans module natif : la base fera foi
  }
}

/** Retire des titres : fichiers, pochettes, puis lignes redevenues « à transférer ». */
export async function retirerDuTelephone(pistes: Piste[]) {
  const possedes = pistes.filter((piste) => piste.fichier);
  for (const piste of possedes) {
    await effacerFichier(piste.video_id, piste.fichier as string);
  }
  await oublierPochettes(possedes.map((piste) => piste.video_id));
  await repo.oublierPistes(possedes.map((piste) => piste.video_id));
}

/** Retire une playlist entière, fichiers compris. */
export async function retirerPlaylist(playlistId: string) {
  await retirerDuTelephone(await repo.listerPistesParPlaylist(playlistId));
  await repo.supprimerPlaylist(playlistId);
}

/** Retire plusieurs playlists d'un coup — la sélection multiple de la bibliothèque. */
export async function retirerPlaylists(playlistIds: string[]) {
  for (const playlistId of playlistIds) {
    await retirerPlaylist(playlistId);
  }
}

/**
 * Supprime des titres définitivement : fichiers, puis lignes.
 *
 * La différence avec `retirerDuTelephone` est la fin : la ligne disparaît de
 * la bibliothèque au lieu de redevenir « à transférer ». Même ordre imposé —
 * fichier d'abord, base ensuite — pour qu'une interruption ne laisse jamais
 * une base qui promet un fichier absent.
 */
export async function supprimerDefinitivement(pistes: Piste[]) {
  await retirerDuTelephone(pistes);
  await repo.supprimerTitres(pistes.map((piste) => piste.video_id));
}

/** Vide la bibliothèque : tout ce qui occupe de la place est effacé avant les lignes. */
export async function viderLeTelephone() {
  await retirerDuTelephone(await repo.pistesPossedees());
  await repo.viderTout();
}
