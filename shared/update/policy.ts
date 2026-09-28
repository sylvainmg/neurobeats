/**
 * Règle de signalement d'une mise à jour — le morceau qui décide *si* et *à quel
 * bruit* on parle à l'utilisateur.
 *
 * Le produit est un lecteur de musique : la pire chose qui puisse arriver est
 * d'interrompre une piste pour annoncer une version. La règle est donc
 * ascendante et se tait d'elle-même :
 *
 *   1re fois  → toast qui s'efface tout seul (5 s), une action, pas de dialogue
 *   2e fois   → bandeau actionnable, jetable, sans modal
 *   3e fois   → plus rien : seulement une pastille discrète, l'utilisateur
 *               FINDRA la mise à jour dans les réglages
 *
 * Et jamais de signalement pendant une lecture : c'est reporté à l'arrêt.
 *
 * Une version qu'on a explicitement ignorée ne sera plus jamais proposée, même
 * après un redémarrage, même si elle reste « la dernière ». C'est la seule
 * garantie forte qu'on offre, parce qu'elle est vérifiable par l'utilisateur.
 *
 * Ce module ne fait aucun accès réseau ni disque : il reçoit un état et un
 * contexte, et rend une décision. C'est ce qui le rend testable sans Electron,
 * sans Expo et sans serveur — les tests tournent dans jest côté mobile.
 */

import { estPlusRecent } from "./version";
import { artefactPour, type Manifeste, type Plateforme } from "./manifest";

/** Ce qu'on retient entre deux lancements. Tout est sérialisable en JSON. */
export interface EtatPolitique {
  /** epoch ms du dernier contrôle *effectué* (succès ou échec). */
  dernierControle: number | null;
  /** Nombre d'échecs de contrôle consécutifs — commande le back-off. */
  echecsConsecutifs: number;
  /** Version explicitement ignorée : plus jamais proposée. */
  versionIgnoree: string | null;
  /** epoch ms jusqu'auquel l'utilisateur a demandé « plus tard ». */
  reporteeJusqua: number | null;
  /** Version dont on a déjà parlé au moins une fois (pour l'échelle de bruit). */
  versionSignalee: string | null;
  /** Combien de fois on a parlé de `versionSignalee`. */
  nbSignaux: number;
}

export const ETAT_INITIAL: EtatPolitique = {
  dernierControle: null,
  echecsConsecutifs: 0,
  versionIgnoree: null,
  reporteeJusqua: null,
  versionSignalee: null,
  nbSignaux: 0,
};

/** Volume de bruit autorisé. Surchargé par les tests, jamais par le code. */
export interface ConfigurationPolitique {
  /** Deux contrôles automatico ne sont pas plus rapprochés que ça. */
  intervalleMinimalMs: number;
  /** Plafond du back-off après des échecs réseau. */
  delaiMaximumEchecMs: number;
  /**
   * Nombre de signalements menus avant de se taire. 2 = un toast puis un
   * bandeau, puis plus rien : c'est le plafond que fixe l'échelle décrite en
   * tête de fichier, et il doit rester bas.
   */
  signauxMaxAvantSilence: number;
  /** Durée d'un « plus tard », si l'utilisateur ne fixe pas de date. */
  delaiReportDefautMs: number;
}

export const CONFIGURATION_PAR_DEFAUT: ConfigurationPolitique = {
  intervalleMinimalMs: 24 * 60 * 60 * 1000,
  delaiMaximumEchecMs: 7 * 24 * 60 * 60 * 1000,
  signauxMaxAvantSilence: 2,
  delaiReportDefautMs: 7 * 24 * 60 * 60 * 1000,
};

export type Bruit = "rien" | "silencieux" | "information" | "proposition" | "obligatoire";

export interface Decision {
  bruit: Bruit;
  /** Trace lisible, journalisée : explique pourquoi on a dit ou pas. */
  raison: string;
  version: string | null;
}

export interface Contexte {
  versionCourante: string;
  manifeste: Manifeste | null;
  plateforme: Plateforme;
  /** epoch ms, injecté pour que les tests n'aient pas de horloge à contrôler. */
  maintenant: number;
  /** Une piste est en cours : on n'interrompt pas la musique. */
  enLecture: boolean;
  etat: EtatPolitique;
  configuration?: ConfigurationPolitique;
}

// ------------------------------------------------------------------ planning

/**
 * Faut-il sortir sur le réseau maintenant ?
 *
 * Séparé de `decider` exprès : ici on parle *rythme*, là on parle *volume*. Un
 * contrôle inutile coûte du réseau et de la batterie pour rien, même si
 * aucune décision ne sera prise.
 */
export function planifierControle(
  etat: EtatPolitique,
  maintenant: number,
  configuration: ConfigurationPolitique = CONFIGURATION_PAR_DEFAUT,
): { doitController: boolean; dansMs: number } {
  // Jamais contrôlé : on contrôle maintenant (le premier contrôle_double also
  // amorce le back-off en cas d'échec).
  if (etat.dernierControle === null) {
    return { doitController: true, dansMs: 0 };
  }

  // Back-off exponentiel sur les échecs : 1 h, 2 h, 4 h… plafonné. Un réseau en
  // panne ne doit pas produire une requête par lancement.
  let delai = configuration.intervalleMinimalMs;
  if (etat.echecsConsecutifs > 0) {
    const palier = Math.min(etat.echecsConsecutifs, 16);
    delai = Math.min(
      configuration.delaiMaximumEchecMs,
      configuration.intervalleMinimalMs * 2 ** (palier - 1),
    );
  }

  const ecoule = maintenant - etat.dernierControle;
  if (ecoule >= delai) return { doitController: true, dansMs: 0 };
  return { doitController: false, dansMs: delai - ecoule };
}

/** État à écrire après un contrôle, réussi ou non. */
export function apresControle(etat: EtatPolitique, maintenant: number, succes: boolean): EtatPolitique {
  return {
    ...etat,
    dernierControle: maintenant,
    echecsConsecutifs: succes ? 0 : etat.echecsConsecutifs + 1,
  };
}

// ------------------------------------------------------------------ décision

const RIEN = (raison: string, version: string | null = null): Decision => ({
  bruit: "rien",
  raison,
  version,
});

/**
 * Que faire de la mise à jour disponible ?
 *
 * L'ordre des tests est celui du coût : on élimine d'abord ce qui ne déclenche
 * rien, et on ne consulte le réseau que si une décision positive reste possible.
 */
export function decider(contexte: Contexte): Decision {
  const cfg = contexte.configuration ?? CONFIGURATION_PAR_DEFAUT;
  const { etat, maintenant } = contexte;
  const manifeste = contexte.manifeste;

  if (!manifeste) {
    return RIEN("aucun manifeste exploitable");
  }
  const version = manifeste.versionTexte;

  if (!estPlusRecent(version, contexte.versionCourante)) {
    return RIEN("déjà à jour", version);
  }

  // On n'annonce pas ce qu'on ne peut pas livrer : pas d'artefact pour notre
  // plate-forme, donc pas de pastille, pas de bandeau, pas de téléchargement
  // impossible. L'utilisateur ne verrait qu'une promesse.
  if (!artefactPour(manifeste, contexte.plateforme)) {
    return RIEN("aucun artefact pour cette plate-forme", version);
  }

  if (etat.versionIgnoree === version) {
    return RIEN("version ignorée par l'utilisateur", version);
  }

  // Obligatoire : court-circuite le report et le cadence. Réservé aux régressions
  // qui cassent l'app, sinon c'est exactement de l'harcèlement.
  if (manifeste.obligatoire) {
    return { bruit: "obligatoire", raison: "mise à jour obligatoire", version };
  }

  if (etat.reporteeJusqua !== null && maintenant < etat.reporteeJusqua) {
    return { bruit: "silencieux", raison: "reportée par l'utilisateur", version };
  }

  // Le compte de signaux est remis à zéro dès qu'une nouvelle version apparaît :
  // chaque version repart de zéro, on ne punit pas l'utilisateur pour avoir
  // ignoré la précédente.
  const memeVersion = etat.versionSignalee === version;
  const nbSignaux = memeVersion ? etat.nbSignaux : 0;

  if (nbSignaux >= cfg.signauxMaxAvantSilence) {
    return {
      bruit: "silencieux",
      raison: `déjà signalé ${nbSignaux} fois, on se tais`,
      version,
    };
  }

  // Une piste tourne : on n'interrompt pas. La pastille reste, l'utilisateur la
  // verra à l'arrêt — c'est le seul bruit qui survit à la lecture.
  if (contexte.enLecture) {
    return { bruit: "silencieux", raison: "lecture en cours, signal différé", version };
  }

  if (nbSignaux === 0) {
    return { bruit: "information", raison: "première mention", version };
  }
  return { bruit: "proposition", raison: "seconde mention, action offerte", version };
}

// ------------------------------------------------------------------ écriture

/**
 * État après avoir montré un signalement de bruit non nul.
 *
 * On ne compte que les bruits qui se voient : une pastille discrète ne consume
 * pas de crédit, sinon le silence s'installerait sans que l'utilisateur ait
 * jamais eu l'occasion de répondre.
 */
export function apresSignalement(etat: EtatPolitique, version: string): EtatPolitique {
  const memeVersion = etat.versionSignalee === version;
  return {
    ...etat,
    versionSignalee: version,
    nbSignaux: memeVersion ? etat.nbSignaux + 1 : 1,
  };
}

/** « Ignorer cette version » : ne plus jamais la proposer. */
export function ignorerVersion(etat: EtatPolitique, version: string): EtatPolitique {
  return { ...etat, versionIgnoree: version, reporteeJusqua: null };
}

/** « Plus tard » : silence jusqu'à l'échéance, puis on peut reparler. */
export function reporterVersion(
  etat: EtatPolitique,
  version: string,
  maintenant: number,
  delaiMs: number = CONFIGURATION_PAR_DEFAUT.delaiReportDefautMs,
): EtatPolitique {
  return { ...etat, reporteeJusqua: maintenant + delaiMs, versionIgnoree: null };
}
