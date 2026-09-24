/**
 * Répartir une sélection entre ce qui se partage et ce qui manque.
 *
 * Le partage n'emporte que des fichiers qui existent vraiment sur le téléphone
 * : une ligne « chez toi » dont le fichier a disparu mentirait, et un titre
 * jamais transféré n'a rien à envoyer. La vérification physique est confiée au
 * module natif (`verifier`) ; cette fonction reste pure pour être testable —
 * elle reçoit les URIs présents et répartit, rien de plus.
 */
import type { Piste } from "@/db/repos";

export type PartagePrepare = {
  /** Les fichiers réellement présents, à envoyer tels quels. */
  partageables: Piste[];
  /** Les titres refusés (jamais transférés, ou fichier disparu). */
  indisponibles: Piste[];
};

/** Les titres dont l'URI est dans `presents` sont partageables, les autres non. */
export function separerPartageables(
  pistes: Piste[],
  presents: ReadonlySet<string>,
): PartagePrepare {
  const partageables: Piste[] = [];
  const indisponibles: Piste[] = [];
  for (const piste of pistes) {
    // Sans fichier elle n'a rien à envoyer ; avec un fichier, seule la
    // vérification physique fait foi — « chez toi » sans fichier mentirait.
    if (piste.fichier && presents.has(piste.fichier)) {
      partageables.push(piste);
    } else {
      indisponibles.push(piste);
    }
  }
  return { partageables, indisponibles };
}