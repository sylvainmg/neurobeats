/**
 * Purge des dossiers de staging quand la cible change.
 *
 * Voir `preparerDossierCible` dans `build-env.mjs` pour le raisonnement. Ce
 * module est separe pour que l'appel soit explicite dans chacun des trois
 * scripts qui remplissent un dossier dependant de la cible.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { lanceurCible, platformKey, run, say } from "./build-env.mjs";

/**
 * Execute le runtime de la CIBLE, avec le lanceur et l'environnement qu'il
 * faut.
 *
 * Un simple `run(...prefixe, binaire, args)` ne marche pas : `run` prend
 * exactement trois arguments, et le spread en glissait un de trop, faisant
 * passer le chemin du binaire a la place du tableau d'arguments. Cette
 * fonction existe pour que l'appel reste lisible ET correct.
 */
export function executerCible(binaire, args, options = {}) {
  const { prefixe, env } = lanceurCible();
  return run(prefixe.length ? prefixe[0] : binaire, [
    ...prefixe.slice(1),
    ...(prefixe.length ? [binaire] : []),
    ...args,
  ], { env: { ...process.env, ...env }, ...options });
}

/**
 * Prepare un dossier de staging pour la cible courante.
 *
 * `bin/`, `runtime/` et `.runtime/backend-package/` ne dependent QUE de la cible
 * et sont partages d'un build a l'autre. Laisses en l'etat, ils accumulent les
 * binaires de la plate-forme precedente — c'est l'origine du `.exe` de 321 Mo
 * sans lecteur : `mpv` (fichier ELF Linux) cohabitait avec l'extraction
 * Windows, qui veut poser un *repertoire* `mpv/`, et `fs.cp` refuse alors
 * d'ecraser un fichier par un dossier. Ici on echoue franchement ; le cas
 * mecanique ou rien ne signale l'erreur est celui d'un binaire de la mauvaise
 * plate-forme qui survit a cote du nouveau.
 *
 * Le fichier `.cible` rend l'operation verifiable : il dit pour quelle
 * plate-forme le dossier a ete rempli. Son absence signifie « pas encore
 * prepare », donc on purge aussi, par prudence.
 */
export async function preparerDossierCible(dir) {
  const marqueur = path.join(dir, ".cible");
  const cibleCourante = platformKey();

  let ciblePrecedente = null;
  try {
    ciblePrecedente = (await fs.readFile(marqueur, "utf8")).trim();
  } catch {
    // pas de marqueur : dossier neuf, ou prepare avant que ce marqueur existe
  }

  if (ciblePrecedente !== cibleCourante) {
    if (ciblePrecedente !== null) {
      say(
        `  (staging « ${path.basename(dir)} » : ${ciblePrecedente} → ` +
          `${cibleCourante}, purge)`,
      );
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(marqueur, `${cibleCourante}\n`, "utf8");
}
