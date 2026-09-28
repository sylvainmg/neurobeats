/**
 * Contrat du manifeste de versions (`versions.json` publié dans notre dépôt).
 *
 * Pourquoi un manifeste maison plutôt que l'API GitHub Releases :
 * 1. il porte le `sha256` de chaque artefact — on ne lance jamais un
 *    installateur téléchargé sans avoir vérifié son empreinte ;
 * 2. aucune limite de débit ni jeton : le téléphone d'un utilisateur n'a pas de
 *    compte GitHub et ne doit pas se faire refuser une vérification ;
 * 3. il est servable en statique (Pages, raw, ou le dossier de release), donc
 *    l'hébergement reste gratuit et remplaçable.
 *
 * Tout ce qui arrive d ici est une ENTRÉE NON FIABLE : c'est un fichier distant
 * qui décide du code exécuté ensuite sur l'appareil. La validation est donc
 * volontairement stricte — un champ manquant invalide l'artefact concerné,
 * et un manifeste entier illisible ne déclenche rien.
 */

import { parseVersion, type Version } from "./version";

/** Clés de plate-forme. Reprend la convention de `desktop/scripts/*.json`. */
export type Plateforme = "linux-x64" | "linux-arm64" | "win32-x64" | "darwin-x64" | "darwin-arm64" | "android";

/** Un artefact téléchargeable, vérifié avant toute exécution. */
export interface ArtefactManifeste {
  /** Nom de fichier affiché, sert aussi de repli si l'URL est relative. */
  file: string;
  /** URL absolue, ou relative à l'URL du manifeste. */
  url: string;
  /** Empreinte hexadécimale minuscule, 64 caractères. */
  sha256: string;
  /** Taille en octets — sert à afficher « 340 Mo » et à vérifier le transfert. */
  size: number;
}

export interface Manifeste {
  version: Version;
  /** `X.Y.Z`, echoes `version` — le format texte reste disponible pour l'affichage. */
  versionTexte: string;
  releasedAt: string;
  notes: string;
  /**
   * Une mise à jour obligatoire se signale au démarrage de l'application, sans
   * attendre le délai de repos, et sans bouton « Plus tard ». Réservé aux
   * correctifs de sécurité ou aux régressions qui cassent l'app.
   */
  obligatoire: boolean;
  artefacts: Partial<Record<Plateforme, ArtefactManifeste>>;
}

const SHA256 = /^[0-9a-f]{64}$/;

/** Une URL absolue, ou une URL relative non vide (résolue par la couche shell). */
function urlValide(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const brut = value.trim();
  if (!brut) return false;
  // On n'interdit pas `http://` ici : c'est au shell de refuser une URL non
  // sûre pour un binaire exécutable, ce test est plus net ici.
  return brut.length <= 2048;
}

function artefactValide(value: unknown): ArtefactManifeste | null {
  if (typeof value !== "object" || value === null) return null;
  const candidat = value as Record<string, unknown>;
  const { file, url, sha256, size } = candidat;
  if (typeof file !== "string" || !file.trim()) return null;
  if (!urlValide(url)) return null;
  if (typeof sha256 !== "string") return null;
  // La comparaison est en minuscules : une empreinte en majuscules reste
  // valide, on refuse juste de la comparer octet par octet plus tard.
  const empreinte = sha256.trim().toLowerCase();
  if (!SHA256.test(empreinte)) return null;
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return null;
  return { file: file.trim(), url: url.trim(), sha256: empreinte, size };
}

const PLATEFORMES: Plateforme[] = [
  "linux-x64",
  "linux-arm64",
  "win32-x64",
  "darwin-x64",
  "darwin-arm64",
  "android",
];

/**
 * Valide un manifeste déjà analysé en JSON.
 *
 * @returns le manifeste normalisé, ou null s'il est inutilisable. Un artefact
 * invalide n'invalide QUE lui : publier Windows ne doit pas empêcher Android de
 * proposer ses mises à jour.
 */
export function validerManifeste(entree: unknown): Manifeste | null {
  if (typeof entree !== "object" || entree === null) return null;
  const candidat = entree as Record<string, unknown>;

  const version = parseVersion(candidat.version);
  if (!version) return null;

  const versionTexte = typeof candidat.version === "string" ? candidat.version.trim() : "";
  if (!versionTexte) return null;

  const notes = typeof candidat.notes === "string" ? candidat.notes.slice(0, 4000) : "";
  const releasedAt = typeof candidat.released_at === "string" ? candidat.released_at : "";
  const obligatoire = candidat.mandatory === true;

  const bruts = (typeof candidat.artifacts === "object" && candidat.artifacts !== null
    ? (candidat.artifacts as Record<string, unknown>)
    : {});

  const artefacts: Partial<Record<Plateforme, ArtefactManifeste>> = {};
  for (const nom of PLATEFORMES) {
    const artefact = artefactValide(bruts[nom]);
    if (artefact) artefacts[nom] = artefact;
  }

  return { version, versionTexte, releasedAt, notes, obligatoire, artefacts };
}

/** Artefact destiné à la plate-forme courante, ou null si absent ou invalide. */
export function artefactPour(manifeste: Manifeste | null, plateforme: Plateforme): ArtefactManifeste | null {
  if (!manifeste) return null;
  return manifeste.artefacts[plateforme] ?? null;
}
