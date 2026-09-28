/**
 * Vérificateur de mise à jour — processus principal Electron.
 *
 * Ce module ne décide RIEN de la politique : il lit `shared/update/policy.ts`,
 * dont les règles sont écrites une fois et testées sans Electron. Ici on ne fait
 * que le travail natif — aller chercher le manifeste, tenir l'état sur disque,
 * interroger le backend pour savoir si une piste joue, télécharger l'installeur
 * et le lancer une fois son empreinte vérifiée.
 *
 * Trois garanties structurantes :
 *
 * 1. Rien ne bloque. Aucune fenêtre modale n'est ouverte, aucun processus de
 *    téléchargement ne démarre tant que l'utilisateur n'a pas demandé la
 *    mise à jour. Le contrôle de version lui-même est une requête HTTP de
 *    quelques kilo-octets, espacée d'au moins 24 h (voir `planifierControle`).
 *
 * 2. Rien ne s'exécute sans être vérifié. L'installeur téléchargé est hashé et
 *    comparé au `sha256` du manifeste AVANT d'être lancé. Un écart supprime le
 *    fichier et ne va pas plus loin.
 *
 * 3. Rien n'est harcelant. La décision de bruit vient du module partagé ;
 *    ce fichier se contente de la relayer vers l'interface.
 */
import { app, shell } from "electron";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

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
  validerManifeste,
  type Bruit,
  type EtatPolitique,
  type Manifeste,
  type Plateforme,
} from "../../../shared/update";

import { URL_MANIFSTE_MAJ } from "../shared/constants";
import { backendPort, desktopUserDataDir, isDev } from "./config";

/** Version de l'application installée, lue dans son propre package.json. */
function versionCourante(): string {
  try {
    const brut = fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8");
    const lu = JSON.parse(brut) as { version?: unknown };
    return typeof lu.version === "string" ? lu.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Clé de plate-forme, même convention que `desktop/scripts/*.json`. */
export function plateformeCourante(): Plateforme {
  if (process.platform === "win32") return "win32-x64";
  if (process.platform === "darwin") return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  return process.arch === "arm64" ? "linux-arm64" : "linux-x64";
}

/**
 * URL du manifeste, résolue dans l'ordre : variable d'environnement, fichier
 * utilisateur, valeur compilée. Le fichier utilisateur permet de rediriger le
 * service sans réinstaller l'application.
 */
export function urlManifeste(): string {
  const depuisEnv = process.env.NEUROBEATS_UPDATE_MANIFEST;
  if (depuisEnv && depuisEnv.trim()) return depuisEnv.trim();
  try {
    const fichier = path.join(desktopUserDataDir(), "update-manifest.json");
    if (fs.existsSync(fichier)) {
      const lu = JSON.parse(fs.readFileSync(fichier, "utf8")) as { url?: unknown };
      if (typeof lu.url === "string" && lu.url.trim()) return lu.url.trim();
    }
  } catch {
    // Un fichier illisible ne doit pas empêcher l'app de démarrer : on garde
    // l'URL compilée.
  }
  return URL_MANIFSTE_MAJ;
}

// ------------------------------------------------------------------ état

function fichierEtat(): string {
  return path.join(desktopUserDataDir(), "update-state.json");
}

/**
 * Lecture de l'état, tolérante : un fichier corrompu ou d'une version future du
 * format donne un état initial plutôt qu'une exception. Perdre l'historique de
 * signalement est anodin ; refuser de démarrer ne l'est pas.
 */
export function lireEtat(): EtatPolitique {
  try {
    const brut = fs.readFileSync(fichierEtat(), "utf8");
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

/** Écriture atomique : un fichier à moitié écrit ferait perdre l'état au prochain boot. */
function ecrireEtat(etat: EtatPolitique): void {
  const cible = fichierEtat();
  const temporaire = `${cible}.tmp`;
  try {
    fs.mkdirSync(path.dirname(cible), { recursive: true });
    fs.writeFileSync(temporaire, JSON.stringify(etat, null, 2), "utf8");
    fs.renameSync(temporaire, cible);
  } catch (err) {
    console.warn(`[maj] état non écrit : ${String(err)}`);
  }
}

// ------------------------------------------------------------------ backend

/**
 * Une piste est-elle en cours de lecture ?
 *
 * On ne signale jamais pendant une lecture (règle du module partagé) : cette
 * question est donc nécessaire avant chaque décision. Un backend injoignable
 * répond `false` — on préfère risquer un signal pendant une lecture à une
 * application qui n'annoncerait plus jamais rien.
 */
async function lectureEnCours(): Promise<boolean> {
  try {
    const reponse = await fetch(`http://127.0.0.1:${backendPort()}/api/now`, {
      signal: AbortSignal.timeout(3000),
    });
    const corps = (await reponse.json()) as { data?: { playing?: boolean; paused?: boolean } };
    const etat = corps?.data;
    return Boolean(etat?.playing && !etat?.paused);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ service

export interface EtatMaj {
  versionCourante: string;
  versionDisponible: string | null;
  bruit: Bruit;
  raison: string;
  obligatoire: boolean;
  notes: string;
  /** Le contrôle a-t-il été court-circuité par la cadence ? */
  differe: boolean;
  /** Prochaine vérification due, pour l'affichage « dans 6 h ». */
  prochainControleDansMs: number | null;
  /** Erreur du dernier contrôle, pour l'écran de réglages. */
  erreur: string | null;
}

let dernierEtat: EtatMaj = {
  versionCourante: "0.0.0",
  versionDisponible: null,
  bruit: "rien",
  raison: "pas encore contrôlé",
  obligatoire: false,
  notes: "",
  differe: false,
  prochainControleDansMs: null,
  erreur: null,
};

/** Les fenêtres écouteantes, pour être prévenus d'une décision. */
let emettre: ((etat: EtatMaj) => void) | null = null;

/** Dernier manifesteuccessfully validé — la source des URLs d'installation. */
let dernierManifeste: Manifeste | null = null;

export function surChangement(abonne: (etat: EtatMaj) => void): void {
  emettre = abonne;
}

function publier(etat: EtatMaj): void {
  dernierEtat = etat;
  emettre?.(etat);
}

export function etatCourant(): EtatMaj {
  return dernierEtat;
}

async function chargerManifeste(): Promise<{ manifeste: Manifeste | null; erreur: string | null }> {
  const url = urlManifeste();
  try {
    const reponse = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json" },
      // Le manifeste change à chaque version : on ne veut pas d'une copie
      // périmée servie par un cache intermédiaire.
      cache: "no-store",
    });
    if (!reponse.ok) return { manifeste: null, erreur: `HTTP ${reponse.status}` };
    const manifeste = validerManifeste(await reponse.json());
    if (!manifeste) return { manifeste: null, erreur: "manifeste illisible" };
    return { manifeste, erreur: null };
  } catch (err) {
    return { manifeste: null, erreur: String(err instanceof Error ? err.message : err) };
  }
}

/**
 * Un contrôle de version, complet.
 *
 * @param force ignorer la cadence — réservé au bouton « Vérifier maintenant ».
 */
export async function controler(force = false): Promise<EtatMaj> {
  const maintenant = Date.now();
  const version = versionCourante();
  const plateforme = plateformeCourante();
  let etat = lireEtat();

  if (!force) {
    const planning = planifierControle(etat, maintenant);
    if (!planning.doitController) {
      // Rien à faire, et surtout rien à demander au réseau.
      const existant = dernierEtat.versionDisponible
        ? decider({
            versionCourante: version,
            manifeste: dernierManifeste,
            plateforme,
            maintenant,
            enLecture: false,
            etat,
          })
        : { bruit: "rien" as Bruit, raison: "contrôle différé" };
      const differe: EtatMaj = {
        ...dernierEtat,
        versionCourante: version,
        bruit: existant.bruit,
        raison: `contrôle différé (${Math.round(planning.dansMs / 60000)} min)`,
        differe: true,
        prochainControleDansMs: planning.dansMs,
      };
      publier(differe);
      return differe;
    }
  }

  const { manifeste, erreur } = await chargerManifeste();
  etat = apresControle(etat, maintenant, manifeste !== null);
  dernierManifeste = manifeste;

  const decision = decider({
    versionCourante: version,
    manifeste,
    plateforme,
    maintenant,
    enLecture: await lectureEnCours(),
    etat,
  });

  // Seul un bruit réellement visible consomme un crédit de signalement, sinon
  // une pastille discrète ferait basculer l'app dans le silence sans que
  // l'utilisateur ait jamais pu répondre.
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
  };
  publier(nouvelEtat);
  return nouvelEtat;
}

/** « Plus tard » : silence jusqu'à l'échéance, la mise à jour reste offerte. */
export async function reporter(maintenant = Date.now()): Promise<EtatMaj> {
  const etat = lireEtat();
  const cible = dernierEtat.versionDisponible;
  if (cible) ecrireEtat(reporterVersion(etat, cible, maintenant));
  return controler(true);
}

/** « Ignorer cette version » : on n'en reparlera plus, même après redémarrage. */
export async function ignorer(): Promise<EtatMaj> {
  const etat = lireEtat();
  const cible = dernierEtat.versionDisponible;
  if (cible) ecrireEtat(ignorerVersion(etat, cible));
  return controler(true);
}

// ------------------------------------------------------------------ installation

/**
 * Télécharge l'installeur et le lance, après vérification de son empreinte.
 *
 * L'ordre n'est pas négociable : on n'ouvre le fichier qu'après `sha256`
 * concordant. Un fichier téléchargé puis abandonné est supprimé dans tous les
 * cas, pour ne pas laisser un installeur inconnu sur le disque de l'utilisateur.
 */
export async function telechargerEtInstaller(): Promise<{ ok: boolean; message: string }> {
  const manifeste = dernierManifeste;
  const artefact = artefactPour(manifeste, plateformeCourante());
  if (!manifeste || !artefact) {
    return { ok: false, message: "Aucun artefact pour cette plate-forme." };
  }

  // Un installeur est du code exécutable : pas de HTTP en clair, quelle que soit
  // la source. L'interface de boucle locale reste autorisée (dépannage).
  const url = new URL(artefact.url, urlManifeste());
  if (url.protocol !== "https:") {
    return { ok: false, message: "Refusé : le manifeste pointe vers une URL non sécurisée." };
  }

  const dossier = path.join(app.getPath("temp"), "neurobeats-maj");
  const cible = path.join(dossier, artefact.file);
  try {
    fs.mkdirSync(dossier, { recursive: true });
    const reponse = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
    if (!reponse.ok || !reponse.body) {
      return { ok: false, message: `Téléchargement impossible (HTTP ${reponse.status}).` };
    }
    // Le condensat est calculé AU PASSAGE, pendant l'écriture : l'installeur
    // dépasse 300 Mo, le relire ensuite pour le hasher le chargerait
    // intégralement en mémoire.
    const hash = createHash("sha256");
    const enPassant = async function* (source: AsyncIterable<Uint8Array>) {
      for await (const morceau of source) {
        hash.update(morceau);
        yield morceau;
      }
    };
    await pipeline(Readable.fromWeb(reponse.body as never), enPassant, fs.createWriteStream(cible));
    if (!empreinteValide(hash.digest("hex"), artefact.sha256)) {
      fs.rmSync(cible, { force: true });
      return {
        ok: false,
        message: "Le fichier téléchargé ne correspond pas à l'empreinte annoncée : abandon.",
      };
    }
  } catch (err) {
    return { ok: false, message: `Téléchargement interrompu : ${String(err instanceof Error ? err.message : err)}` };
  }

  // Un AppImage se lance directement ; un .exe/.dmg passe par le gestionnaire de
  // fichiers de la plateforme. `openPath` fait les deux.
  const erreurOuverture = await shell.openPath(cible);
  if (erreurOuverture) {
    return { ok: false, message: `Fichier téléchargé mais non ouvert : ${erreurOuverture}` };
  }
  return { ok: true, message: "L'installeur est ouvert." };
}

/**
 * Démarre le service après le premier rendu de l'interface.
 *
 * En développement le contrôle est sauté : la version de `main` n'a rien à voir
 * avec celle publiée, et annoncer une mise à jour pendant qu'on code serait
 * absurde.
 */
export function demarrerServiceUpdate(): void {
  if (isDev() && !process.env.NEUROBEATS_UPDATE_MANIFEST) {
    console.warn("[maj] ignorée en dev (versions locales)");
    return;
  }
  void controler().catch((err) => console.warn(`[maj] contrôle impossible : ${String(err)}`));
}
