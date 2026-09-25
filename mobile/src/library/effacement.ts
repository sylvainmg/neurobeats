/**
 * Retirer des titres du téléphone : le fichier audio, et l'état de la ligne.
 *
 * C'est l'appel isolé à `oublierPiste` qui laissait les fichiers sur le disque :
 * la bibliothèque affichait « 1,2 Go hors ligne » après une suppression, et
 * l'espace n'était jamais rendu.
 *
 * Un même fichier peut servir plusieurs occurrences (un titre dans deux
 * playlists) : on ne l'efface que si aucune autre ligne ne le réclame encore.
 *
 * La vignette, elle, **reste** : le titre ne quitte pas la playlist, sa
 * couverture en fait partie et la retirer laisserait la ligne sans visage.
 * Seule une suppression définitive efface l'image.
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
    try {
      await module.supprimer(videoId, uri);
    } catch {
      // Fichier déjà absent, entrée MediaStore inconnue, permission retirée :
      // peu importe — la base fait foi. Une suppression de fichier qui échoue ne
      // doit jamais laisser les lignes « chez toi » mentir, ni faire échouer
      // l'action entière : c'est exactement ce qui la rendait sans effet.
    }
    return;
  }
  try {
    supprimerFichier(new File(uri));
  } catch {
    // URI de contenu sans module natif : la base fera foi
  }
}

/** Fichiers que personne d'autre ne réclame : eux seuls sont effaçables. */
async function fichiersOrphelins(
  pistes: Piste[],
  choisis: Set<number>,
): Promise<Map<string, string[]>> {
  const parFichier = new Map<string, string[]>();
  for (const piste of pistes) {
    if (!piste.fichier) continue;
    const cles = parFichier.get(piste.fichier) ?? [];
    cles.push(piste.video_id);
    parFichier.set(piste.fichier, cles);
  }
  const orphelins = new Map<string, string[]>();
  for (const [fichier, cles] of parFichier) {
    const autres = (await repo.pistesParFichier(fichier)).filter(
      (ligne) => !choisis.has(ligne.id),
    );
    if (autres.length === 0) orphelins.set(fichier, cles);
  }
  return orphelins;
}

/** Retire des titres : le fichier audio effacé, la ligne redevenue « à transférer ». */
export async function retirerDuTelephone(pistes: Piste[]) {
  const choisis = new Set(pistes.map((piste) => piste.id));
  const orphelins = await fichiersOrphelins(pistes, choisis);
  for (const [fichier, cles] of orphelins) {
    await effacerFichier(cles[0], fichier);
  }
  await repo.oublierLignes(pistes.map((piste) => piste.id));
}

/** Efface les vignettes que plus aucune ligne ne montre. */
async function oublierLesVignettesOrphelines(pistes: Piste[]) {
  const aOublier: string[] = [];
  for (const videoId of new Set(pistes.map((piste) => piste.video_id))) {
    const restantes = (await repo.pistesParVideo(videoId)).filter((ligne) => ligne.pochette);
    if (restantes.length === 0) aOublier.push(videoId);
  }
  await oublierPochettes([...new Set(aOublier)]);
}

/** Retire une playlist entière, fichiers compris. */
export async function retirerPlaylist(playlistId: string) {
  const pistes = await repo.listerPistesParPlaylist(playlistId);
  await retirerDuTelephone(pistes);
  await repo.supprimerPlaylist(playlistId);
  // Les lignes ont disparu avec la playlist : leurs vignettes ne sont plus
  // montrées par personne.
  await oublierLesVignettesOrphelines(pistes);
}

/** Retire plusieurs playlists d'un coup — la sélection multiple de la bibliothèque. */
export async function retirerPlaylists(playlistIds: string[]) {
  for (const playlistId of playlistIds) {
    await retirerPlaylist(playlistId);
  }
}

/**
 * Supprime des titres définitivement : fichiers, lignes, et jusqu'aux vignettes.
 *
 * La différence avec `retirerDuTelephone` est la fin : la ligne disparaît de la
 * bibliothèque au lieu de redevenir « à transférer », et la couverture part avec
 * elle — c'est ici, et seulement ici, que l'image est effacée. Même ordre imposé
 * — fichier d'abord, base ensuite — pour qu'une interruption ne laisse jamais
 * une base qui promet un fichier absent.
 */
export async function supprimerDefinitivement(pistes: Piste[]) {
  await retirerDuTelephone(pistes);
  await repo.supprimerLignes(pistes.map((piste) => piste.id));
  await oublierLesVignettesOrphelines(pistes);
}

/** Vide la bibliothèque : tout ce qui occupe de la place est effacé avant les lignes. */
export async function viderLeTelephone() {
  const toutes = await repo.listerPistes();
  await retirerDuTelephone(toutes);
  await repo.viderTout();
  await oublierLesVignettesOrphelines(toutes);
}
