/**
 * Paroles : ce que le bureau sait, ramené sur le téléphone.
 *
 * Le téléphone ne connaît le backend que par l'adresse de session (celle du
 * code QR lu au scan) : on n'invente pas de deuxième canal. Les paroles sont
 * donc demandées à cette adresse, qui interroge LRCLIB/Genius côté ordinateur et
 * garde le résultat en cache 30 jours.
 *
 * Le fichier est **copié** dans `DOSSIER_PAROLES` comme le sont les pochettes, et
 * pour la même raison : une fois le titre téléchargé, les paroles voyagent avec
 * lui et restent lisibles en mode avion. Le téléphone n'a pas besoin d'être
 * sur le réseau de l'ordinateur au moment de l'écoute.
 *
 * Une panne ne doit rien retenir : une pochette ou un jeu de paroles vide est
 * traité comme absent, jamais affiché cassé.
 */
import { File } from "expo-file-system";

import { DOSSIER_PAROLES, assurerDossier, supprimerFichier, tailleDe } from "@/fichiers/dossiers";

/** Une ligne de paroles : `time` en secondes, `null` si non synchronisée. */
export type LigneParole = { time: number | null; text: string };

export type Paroles = {
  /**
   * Titre auquel ces paroles appartiennent.
   *
   * Le panneau s'en sert pour ne pas afficher les paroles d'un titre précédent
   * pendant la requête du suivant : sans cela, un résultat tardif s'afficherait
   * sous le mauvais nom, et le contenu clignoterait à chaque changement.
   */
  videoId: string;
  found: boolean;
  /** true si les lignes portent un timestamp (mode karaoké). */
  synced: boolean;
  source: "lrclib" | "genius" | null;
  instrumental: boolean;
  lines: LigneParole[];
  /** Panne réseau transitoire : l'interface propose « Réessayer ». */
  retryable?: boolean;
  message?: string | null;
};

/** Dossier des paroles, une entrée par titre. */
function fichierDe(videoId: string): File {
  return new File(DOSSIER_PAROLES, `${videoId}.json`);
}

/**
 * Une requête de paroles qui ne revient pas ne doit pas retenir l'écran : on
 * abandonne après 15 s (réseau qui stalle) plutôt que d'afficher un spinner
 * éternel sur un titre qu'on n'écoutera pas non plus.
 */
const DELAI_SECONDES = 15;

/** L'enveloppe `{status, data}` du backend, reduced à son `data`. */
function lire(reponse: Response): Paroles | null {
  if (!reponse.ok) return null;
  try {
    const corps = reponse.json() as { data?: Paroles };
    return corps?.data ?? null;
  } catch {
    return null;
  }
}

/** La réponse du bureau, mise en forme pour l'interface (jamais d'exception). */
function normaliser(brut: Paroles | null, videoId: string): Paroles {
  if (!brut) {
    return {
      videoId,
      found: false,
      synced: false,
      source: null,
      instrumental: false,
      lines: [],
      message: "Paroles indisponibles.",
    };
  }
  return {
    videoId,
    found: Boolean(brut.found),
    synced: Boolean(brut.synced),
    source: brut.source ?? null,
    instrumental: Boolean(brut.instrumental),
    lines: Array.isArray(brut.lines) ? brut.lines : [],
    retryable: Boolean(brut.retryable),
    message: brut.message ?? null,
  };
}

/**
 * Paroles d'un titre, d'abord depuis le téléphone, sinon depuis le bureau.
 *
 * L'ordre est celui du confort : le mode avion doit fonctionner, donc on lit
 * ce qui est déjà sur l'appareil avant de sortir.
 */
export async function chargerParoles(
  videoId: string,
  base: string | null,
  titre = "",
  chaine = "",
  duree = 0,
): Promise<Paroles> {
  const local = fichierDe(videoId);
  if (tailleDe(local) > 0) {
    try {
      return normaliser(JSON.parse(local.textSync()) as Paroles, videoId);
    } catch {
      // Fichier corrompu (interrompu en cours d'écriture) : on le reprend.
      supprimerFichier(local);
    }
  }
  if (!base || !videoId) return normaliser(null, videoId);

  const parametres = new URLSearchParams({ video_id: videoId });
  if (titre) parametres.set("title", titre);
  if (chaine) parametres.set("channel", chaine);
  if (duree > 0) parametres.set("duration", String(Math.round(duree)));
  const url = `${base.replace(/\/$/, "")}/api/lyrics?${parametres.toString()}`;

  const controleur = new AbortController();
  const delai = setTimeout(() => controleur.abort(), DELAI_SECONDES * 1000);
  try {
    const reponse = await fetch(url, { signal: controleur.signal });
    const paroles = lire(reponse);
    if (!paroles) return normaliser(null, videoId);
    // On ne garde que ce qui se voit : un « pas de paroles » pour ce titre ne
    // mérite pas de fichier, et le backend répondra de la même façon.
    if (paroles.found) {
      assurerDossier(DOSSIER_PAROLES);
      const destination = fichierDe(videoId);
      if (!destination.exists) destination.create({ intermediates: true, overwrite: true });
      destination.write(JSON.stringify(paroles));
    }
    return normaliser(paroles, videoId);
  } catch {
    return normaliser(null, videoId);
  } finally {
    clearTimeout(delai);
  }
}

/** Oublie les paroles d'un titre (le fichier part avec lui). */
export function oublierParoles(videoId: string): void {
  supprimerFichier(fichierDe(videoId));
}
