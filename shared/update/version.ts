/**
 * Comparaison de versions — la seule règle dont dépend la décision de proposer
 * une mise à jour. Volontairement sans dépendance : ce module est compilé tel
 * quel dans le bundle Android (hors `mobile/`) ET dans le processus principal
 * Electron, donc il ne peut rien importer.
 *
 * Why semver strict: les artefacts publiés portent tous la même version que le
 * manifeste (le nom de fichier l'inclut). Une version illisible ne doit donc
 * jamais « compter comme plus récente » — au moindre doute on ne propose rien,
 * ce qui est le seul comportement acceptable quand on contrôle l'exécution d'un
 * programme téléchargé.
 */

/** Version analysée, ou null si la chaîne n'est pas exploitable. */
export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** Pré-release : `1.2.3-beta.2` → `beta.2`. Vide si absente. */
  prerelease: string;
}

const MOTIF = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * Analyse une version `X.Y.Z[-pre]`.
 *
 * Ne tolère ni `v1.2.3` ni `1.2` : la version vient d'un manifeste que nous
 * écrivons, donc une entrée non conforme est un manifeste corrompu, pas une
 * version à deviner.
 */
export function parseVersion(brut: unknown): Version | null {
  if (typeof brut !== "string") return null;
  const found = MOTIF.exec(brut.trim());
  if (!found) return null;
  return {
    major: Number(found[1]),
    minor: Number(found[2]),
    patch: Number(found[3]),
    prerelease: found[4] ?? "",
  };
}

/**
 * Compare deux versions analysées.
 *
 * Ordre : major, puis minor, puis patch, puis la pré-release. Une pré-release
 * est PLUS ANCIENNE que sa version finale (`1.2.3-beta` < `1.2.3`), et entre
 * deux pré-releases le plus petit identifiant wins (règle semver), avec un
 * identifiant numérique hissé au-dessus d'un identifiant alphanumérique.
 */
export function comparerVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease === b.prerelease) return 0;
  // La version finale l'emporte sur toute pré-release.
  if (a.prerelease === "") return 1;
  if (b.prerelease === "") return -1;
  return comparerPrerelease(a.prerelease, b.prerelease);
}

function comparerPrerelease(a: string, b: string): number {
  const gauche = a.split(".");
  const droite = b.split(".");
  const longueur = Math.max(gauche.length, droite.length);
  for (let i = 0; i < longueur; i += 1) {
    const g = gauche[i];
    const d = droite[i];
    // Un identifiant manquant vaut « rien » : alpha < alpha.1
    if (g === undefined) return -1;
    if (d === undefined) return 1;
    const gNum = /^\d+$/.test(g);
    const dNum = /^\d+$/.test(d);
    if (gNum && dNum) {
      const diff = Number(g) - Number(d);
      if (diff !== 0) return diff;
      continue;
    }
    // Numérique > alphanumérique.
    if (gNum) return 1;
    if (dNum) return -1;
    if (g !== d) return g < d ? -1 : 1;
  }
  return 0;
}

/**
 * Une mise à jour est-elle proposed ?
 *
 * @returns true seulement si `candidate` est strictement plus récente ET que
 * les deux versions sont exploitables. Une version courante illisible vaut
 * « on ne sait rien » → false, jamais de mise à jour proposée sur un doubt.
 */
export function estPlusRecent(candidate: unknown, current: unknown): boolean {
  const c = parseVersion(candidate);
  const v = parseVersion(current);
  if (!c || !v) return false;
  return comparerVersions(c, v) > 0;
}
