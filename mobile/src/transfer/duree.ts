/**
 * Durée réelle d'un fichier audio, sondée par le lecteur local.
 *
 * Le bureau ne connaît pas toujours la durée d'un titre (playlist importée sans
 * sondage) : au lieu d'afficher une ligne sans durée, on lit celle du fichier
 * quand il est sur le téléphone. Le sondage crée un joueur sans jamais le faire
 * jouer : aucune sortie audio, aucun effet furtif.
 *
 * La durée n'est disponible qu'une fois le flux chargé : on l'attend quelques
 * secondes, puis on renonce — une ligne sans durée reste lisible.
 */
import { createAudioPlayer } from "expo-audio";

export const DELAI_SONDAGE_MS = 6000;
export const PAS_SONDAGE_MS = 200;

export async function dureeDeFichier(uri: string | null | undefined): Promise<number | null> {
  if (!uri) return null;
  let joueur;
  try {
    joueur = createAudioPlayer({ uri });
    const debut = Date.now();
    while (Date.now() - debut < DELAI_SONDAGE_MS) {
      const duree = joueur.duration ?? 0;
      if (duree > 0) return Math.round(duree);
      await new Promise((resoudre) => setTimeout(resoudre, PAS_SONDAGE_MS));
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      joueur?.remove();
    } catch {
      // Le joueur peut déjà être détruit : rien à libérer.
    }
  }
}