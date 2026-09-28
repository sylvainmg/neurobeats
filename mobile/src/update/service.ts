/**
 * Vérificateur de mise à jour — application Android.
 *
 * Même contrat que le desktop, et surtout même cœur : la politique (quand
 * parler, à quel volume) vient de `shared/update/policy.ts`, ce fichier ne fait
 * que le travail natif — persister l'état, interroger le réseau, télécharger
 * l'APK.
 *
 * L'APK pose une contrainte que le desktop n'a pas : Android refuse d'installer
 * un paquet signé par une autre clé que celle de l'application installée. Un
 * build de debug, ou un build de release resté en clé de debug, ne peuvent donc
 * pas se mettre à jour eux-mêmes — voir `autoInstallationPossible()`, qui refuse
 * alors de promettre une mise à jour qu'Android refuse d'appliquer.
 */

import Constants from "expo-constants";
import { Directory, File, Paths } from "expo-file-system";
import { Platform } from "react-native";

import {
  apresControle,
  apresSignalement,
  artefactPour,
  decider,
  ETAT_INITIAL,
  empreinteValide,
  ignorerVersion,
  planifierControle,
  reporterVersion,
  sha256,
  validerManifeste,
  type Bruit,
  type EtatPolitique,
  type Manifeste,
  type Plateforme,
} from "@neurobeats/shared/update";

import { lireTexteDocument, ecrireTexteDocument } from "@/fichiers/dossiers";

/**
 * Manifeste des versions publiées.
 *
 * Même valeur que le desktop (`desktop/src/shared/constants.ts`) : les deux
 * plates-formes doivent lire la même source, sinon elles ne proposeraient pas
 * la même chose au même moment. Surchargée par
 * `EXPO_PUBLIC_UPDATE_MANIFEST` pour les tests.
 *
 * Le raisonnement derrière l'URL — alias `latest` plutôt que version figée,
 * Releases plutôt que fichiers versionnés — est developpe dans le desktop, seule
 * source de verite. Les deux constantes doivent rester identiques.
 */
export const URL_MANIFESTE_MAJ =
  process.env.EXPO_PUBLIC_UPDATE_MANIFEST ??
  "https://github.com/sylvainmg/neurobeats-releases/releases/latest/download/versions.json";

const FICHIER_ETAT = "etat-maj.json";

/** Plate-forme : l'application livrée est Android, le reste n'a pas d'APK. */
export function plateformeCourante(): Plateforme {
  return "android";
}

/**
 * Ce build peut-il se mettre à jour tout seul ?
 *
 * Android refuse d'installer un paquet dont la signature diffère de celle de
 * l'application installée. Deux situations rendent donc l'auto-installation
 * impossible, et il faut les traiter toutes les deux :
 *
 * 1. un build de développement (`__DEV__`) ;
 * 2. un build de **release signé avec la clé de debug** — c'est ce qui sort
 *    d'un `gradlew assembleRelease` sans keystore configuré. Rien dans le
 *    bundle ne distingue ce cas d'une vraie release : `__DEV__` y vaut `false`.
 *    Sans declared, l'app proposerait une mise à jour de 40 Mo qui échouerait
 *    à l'installation, avec un message que personne ne peut expliquer.
 *
 * D'où un indicateur pose au build : `EXPO_PUBLIC_MAJ_AUTO_INSTALLABLE=0`.
 * Expo insole les variables `EXPO_PUBLIC_*` dans le bundle, donc la valeur est
 * figee a la compilation et ne peut pas mentir apres coup.
 */
export function autoInstallationPossible(): boolean {
  if (Platform.OS !== "android") return false;
  const globale = globalThis as { __DEV__?: boolean };
  if (globale.__DEV__ === true) return false;
  return process.env.EXPO_PUBLIC_MAJ_AUTO_INSTALLABLE !== "0";
}

// ------------------------------------------------------------------ état

export function lireEtat(): EtatPolitique {
  const brut = lireTexteDocument(FICHIER_ETAT);
  if (!brut) return { ...ETAT_INITIAL };
  try {
    const lu = JSON.parse(brut) as Partial<EtatPolitique>;
    return {
      dernierControle: typeof lu.dernierControle === "number" ? lu.dernierControle : null,
      echecsConsecutifs:
        typeof lu.echecsConsecutifs === "number" && lu.echecsConsecutifs >= 0
          ? lu.echecsConsecutifs
          : 0,
      versionIgnoree: typeof lu.versionIgnoree === "string" ? lu.versionIgnoree : null,
      reporteeJusqua: typeof lu.reporteeJusqua === "number" ? lu.reporteeJusqua : null,
      versionSignalee: typeof lu.versionSignalee === "string" ? lu.versionSignalee : null,
      nbSignaux: typeof lu.nbSignaux === "number" && lu.nbSignaux >= 0 ? lu.nbSignaux : 0,
    };
  } catch {
    return { ...ETAT_INITIAL };
  }
}

function ecrireEtat(etat: EtatPolitique): void {
  ecrireTexteDocument(FICHIER_ETAT, JSON.stringify(etat));
}

// ------------------------------------------------------------------ service

export interface EtatMaj {
  versionCourante: string;
  versionDisponible: string | null;
  bruit: Bruit;
  raison: string;
  obligatoire: boolean;
  notes: string;
  /** Le contrôle a été évité par la cadence. */
  differe: boolean;
  prochainControleDansMs: number | null;
  erreur: string | null;
  /** Le build interdit l'auto-installation : à dire à l'utilisateur. */
  signatureBloquante: boolean;
}

const ETAT_REPOS: EtatMaj = {
  versionCourante: "0.0.0",
  versionDisponible: null,
  bruit: "rien",
  raison: "pas encore contrôlé",
  obligatoire: false,
  notes: "",
  differe: false,
  prochainControleDansMs: null,
  erreur: null,
  signatureBloquante: false,
};

let etatCourant: EtatMaj = { ...ETAT_REPOS };
let dernierManifeste: Manifeste | null = null;
const abonnes = new Set<(etat: EtatMaj) => void>();

export function surChangement(abonne: (etat: EtatMaj) => void): () => void {
  abonnes.add(abonne);
  return () => abonnes.delete(abonne);
}

function publier(etat: EtatMaj): void {
  etatCourant = etat;
  for (const abonne of abonnes) abonne(etat);
}

export function etat(): EtatMaj {
  return etatCourant;
}

function versionCourante(): string {
  // La version vient d'`expo-constants`, qui la fige a la compilation depuis
  // `app.json`. C'est la SEULE source fiable dans un build distribue.
  //
  // `__EXPO_MANIFEST__` ne sert qu'en developpement : c'est le serveur Metro
  // qui l'injecte, un build release ne le contient pas. S'appuyer dessus
  // seulement — ce que faisait cette fonction — revenait a retourner "0.0.0"
  // sur tout APK distribue. L'application croyait alors avoir la version 0.0.0,
  // comparait a la version publiee, et concluait qu'une mise a jour etait
  // disponible : elle en proposait une en boucle, a l'utilisateur deja a jour.
  // Le declencheur « Mettre a jour » ne s'affichait donc que parce que l'app
  // ignorait sa propre version.
  try {
    const version = Constants.expoConfig?.version;
    if (typeof version === "string" && version) return version;
  } catch {
    // on tente le developpement
  }

  // Repli pour le developpement et les tests, ou le manifeste est injecte.
  try {
    const globales = globalThis as { __EXPO_MANIFEST__?: { version?: string } };
    const depuisGlobales = globales.__EXPO_MANIFEST__?.version;
    if (typeof depuisGlobales === "string" && depuisGlobales) return depuisGlobales;
  } catch {
    // rien de plus a tenter
  }

  // Ni l'un ni l'autre : on ne pretend PAS connaitre la version. Une valeur
  // basse ferait proposer une mise a jour a tout le monde, en boucle — le
  // precis symptome qu'on vient de corriger. Renvoyer la version du manifeste
  // ferait le contraire, ne jamais proposer. Sans l'un ni l'autre, on
  // prefere le silence : une verification qui ne sait pas ce qu'elle compare
  // ne doit rien afficher.
  return "";
}

async function chargerManifeste(): Promise<{ manifeste: Manifeste | null; erreur: string | null }> {
  try {
    const reponse = await fetch(URL_MANIFESTE_MAJ, {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json" },
    });
    if (!reponse.ok) return { manifeste: null, erreur: `HTTP ${reponse.status}` };
    const manifeste = validerManifeste(await reponse.json());
    if (!manifeste) return { manifeste: null, erreur: "manifeste illisible" };
    return { manifeste, erreur: null };
  } catch (err) {
    return { manifeste: null, erreur: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Contrôle complet. `force` ignore la cadence — réservé au bouton des réglages.
 */
export async function controler(force = false): Promise<EtatMaj> {
  const maintenant = Date.now();
  const version = versionCourante();
  const signatureBloquante = !autoInstallationPossible();
  let etat = lireEtat();

  if (!force) {
    const planning = planifierControle(etat, maintenant);
    if (!planning.doitController) {
      publier({
        ...etatCourant,
        versionCourante: version,
        differe: true,
        prochainControleDansMs: planning.dansMs,
        signatureBloquante,
      });
      return etatCourant;
    }
  }

  const { manifeste, erreur } = await chargerManifeste();
  etat = apresControle(etat, maintenant, manifeste !== null);
  dernierManifeste = manifeste;

  // Un build de debug ne peut pas recevoir d'APK de distribution : on ne
  // propose rien, quitte à perdre la trace de la version disponible.
  const decision = signatureBloquante
    ? { bruit: "rien" as Bruit, raison: "build de développement", version: null }
    : decider({
        versionCourante: version,
        manifeste,
        plateforme: plateformeCourante(),
        maintenant,
        // Le téléphone n'a pas de « lecture en cours » visible d'ici, et la
        // feuille de mise à jour est modale de toute façon : c'est l'écran
        // qui ne la propose pas pendant une lecture, pas le service.
        enLecture: false,
        etat,
      });

  if (manifeste && decision.version && decision.bruit !== "rien" && decision.bruit !== "silencieux") {
    etat = apresSignalement(etat, decision.version);
  }
  ecrireEtat(etat);

  const prochain = planifierControle(etat, maintenant);
  const nouvelEtat: EtatMaj = {
    versionCourante: version,
    versionDisponible: decision.version,
    bruit: decision.bruit,
    raison: decision.raison,
    obligatoire: manifeste?.obligatoire ?? false,
    notes: manifeste?.notes ?? "",
    differe: false,
    prochainControleDansMs: prochain.doitController ? null : prochain.dansMs,
    erreur,
    signatureBloquante,
  };
  publier(nouvelEtat);
  return nouvelEtat;
}

export async function reporter(maintenant = Date.now()): Promise<EtatMaj> {
  const cible = etatCourant.versionDisponible;
  if (cible) ecrireEtat(reporterVersion(lireEtat(), cible, maintenant));
  return controler(true);
}

export async function ignorer(): Promise<EtatMaj> {
  const cible = etatCourant.versionDisponible;
  if (cible) ecrireEtat(ignorerVersion(lireEtat(), cible));
  return controler(true);
}

// ------------------------------------------------------------------ téléchargement

/**
 * Télécharge l'APK de la version annoncée et renvoie le fichier local.
 *
 * L'empreinte est vérifiée avant de rendre le chemin à l'appelant : un fichier
 * non conforme est supprimé, jamais proposé à l'installateur du système.
 */
export async function telechargerApk(): Promise<{ ok: boolean; message: string; uri?: string }> {
  if (!autoInstallationPossible()) {
    return {
      ok: false,
      message:
        "Cette version de test ne peut pas se mettre à jour elle-même : Android exige la même signature. Installez l'APK de distribution téléchargé à la main.",
    };
  }
  const artefact = artefactPour(dernierManifeste, plateformeCourante());
  if (!artefact) return { ok: false, message: "Aucun APK pour cette version." };
  // Le manifeste peut publier un nom de fichier nu ; il se résout alors contre
  // l'URL du manifeste, comme le fait le desktop. Un APK est du code exécutable :
  // le transport doit être en HTTPS.
  const url = new URL(artefact.url, URL_MANIFESTE_MAJ);
  if (url.protocol !== "https:") {
    return { ok: false, message: "Refusé : le manifeste pointe vers une URL non sécurisée." };
  }

  const dossier = new Directory(Paths.cache, "maj");
  if (!dossier.exists) dossier.create({ intermediates: true, overwrite: true });
  const cible = new File(dossier, artefact.file);

  try {
    const reponse = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
    if (!reponse.ok) return { ok: false, message: `Téléchargement impossible (HTTP ${reponse.status}).` };
    const corps = await reponse.arrayBuffer();
    const octets = new Uint8Array(corps);
    if (octets.byteLength !== artefact.size) {
      return {
        ok: false,
        message: `Fichier incomplet (${octets.byteLength} octets au lieu de ${artefact.size}).`,
      };
    }
    if (cible.exists) cible.delete();
    cible.create({ intermediates: true, overwrite: true });
    cible.write(octets);

    const empreinte = await empreinteDuFichier(cible);
    if (!empreinteValide(empreinte, artefact.sha256)) {
      cible.delete();
      return { ok: false, message: "L'APK téléchargé ne correspond pas à l'empreinte annoncée." };
    }
    return { ok: true, message: "APK téléchargé.", uri: cible.uri };
  } catch (err) {
    return { ok: false, message: `Téléchargement interrompu : ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * SHA-256 du fichier tel qu'il est réellement sur le disque.
 *
 * On relit le fichier plutôt que de hacher le tampon juste écrit : c'est
 * l'octet qui sera soumis à l'installateur du système qui doit être vérifié,
 * pas celui qu'on croit avoir reçu.
 */
async function empreinteDuFichier(fichier: File): Promise<string> {
  return sha256(await fichier.bytes());
}
