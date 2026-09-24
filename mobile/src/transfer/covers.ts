/**
 * Pochettes : copiées sur le téléphone au moment de l'import.
 *
 * On les rapatrie explicitement plutôt que de laisser l'image se charger à
 * l'affichage : c'est ce qui garantit qu'une pochette reste visible en mode
 * avion, et que la ligne d'un titre ne se redessine pas à chaque défilement.
 *
 * Une pochette vide (transfert interrompu) est traitée comme absente : elle
 * serait affichée cassée, ce qui est pire que pas d'image du tout.
 */
import { File } from "expo-file-system";

import { DOSSIER_POCHETTES, assurerDossier, supprimerFichier, tailleDe } from "@/fichiers/dossiers";

function fichierDe(videoId: string): File {
  return new File(DOSSIER_POCHETTES, `${videoId}.img`);
}

/**
 * Une pochette qui ne revient pas ne doit pas retenir le lancement d'un
 * transfert : on abandonne après 15 s (réseau qui stall) plutôt que de laisser
 * l'écran « Télécharger » en spinner éternel.
 */
const DELAI_SECONDES = 15;

export async function telechargerPochette(
  url: string | null,
  videoId: string,
): Promise<string | null> {
  if (!url) return null;
  const cible = fichierDe(videoId);
  if (tailleDe(cible) > 0) return cible.uri;
  supprimerFichier(cible);
  const controleur = new AbortController();
  const delai = setTimeout(() => controleur.abort(), DELAI_SECONDES * 1000);
  try {
    assurerDossier(DOSSIER_POCHETTES);
    const telechargee = await File.downloadFileAsync(url, cible, {
      signal: controleur.signal,
    });
    return tailleDe(telechargee) > 0 ? telechargee.uri : null;
  } catch {
    return null;
  } finally {
    clearTimeout(delai);
  }
}

export async function oublierPochettes(videoIds: string[]) {
  for (const id of videoIds) supprimerFichier(fichierDe(id));
}
