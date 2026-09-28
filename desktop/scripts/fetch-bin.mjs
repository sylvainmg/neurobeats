/**
 * Recupere les binaires multimedia (mpv, ffmpeg, ffprobe).
 *
 * Pourquoi ce script existe : l'ancien `copy_binary` de stage-runtime.sh
 * resolvait mpv et ffmpeg par `command -v`, donc depuis le systeme — `/usr/bin`
 * sur le poste de developpement. Sur un runner CI il n'y a pas de `/usr/bin/mpv` :
 * le script affichait un simple avertissement et produisait quand meme un
 * artefact **sans lecteur**. Un binaire absent ne doit pas se voir : on
 * telecharge donc explicitement, avec pinning et verification de somme.
 *
 * Deux points specifiques a mpv sous Windows :
 * - le build exige des DLLs a cote de l'executable ; on copie le dossier,
 *   pas le fichier ;
 * - `mpv.exe` est un binaire GUI (sous-systeme Windows) qui detache stdout,
 *   alors que le backend lit la progression sur la sortie standard
 *   (`--msg-level=all=status`, backend/core/config.py:178). C'est `mpv.com`,
 *   build console, qu'il faut embarquer en priorite.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  archiveRoot,
  binName,
  copyResolved,
  download,
  extractAny,
  isLinux,
  isMac,
  isWindows,
  say,
  verifyChecksum,
} from "./lib/build-env.mjs";
import { preparerDossierCible } from "./lib/staging.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  await fs.readFile(path.join(here, "bin-build.json"), "utf8"),
);

const desktop = path.resolve(here, "..");
const binDir = path.join(desktop, "bin");

function platformKey() {
  if (isWindows) return "win32-x64";
  if (isMac) return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  return process.arch === "arm64" ? "linux-arm64" : "linux-x64";
}

const key = platformKey();
const entries = manifest[key];
if (!entries) {
  console.error(
    `Plate-forme binaire non couverte : ${key}. ` +
      `Ajoute l'entree dans scripts/bin-build.json.`,
  );
  process.exit(1);
}

const cache = process.env.NEUROBEATS_BIN_CACHE
  ? path.resolve(process.env.NEUROBEATS_BIN_CACHE)
  : path.join(os.tmpdir(), "neurobeats-bin");

// Le dossier est purge s'il contient les binaires d'une autre cible : c'est ce
// qui manquait pour que `mpv` (fichier ELF Linux) ne survive pas a l'extraction
// Windows.
await preparerDossierCible(binDir);

for (const [tool, spec] of Object.entries(entries)) {
  await stage(tool, spec);
}

async function stage(tool, spec) {
  // ffmpeg et ffprobe sont des .exe autonomes sous Windows, et des binaires
  // systeme ailleurs : rien a telecharger si deja presents.
  const target = path.join(binDir, binName(tool));
  if (await exists(target) && !spec) {
    say(`→ ${tool} déjà présent`);
    return;
  }

  if (!spec) {
    const found = await fromSystem(tool);
    if (found) {
      say(`→ ${tool} pris sur le système : ${found}`);
      return;
    }
    console.error(
      `  ✗ ${tool} introuvable et aucun asset pour ${key}. ` +
        "L'artefact sera incomplet (pas de lecteur audio).",
    );
    return;
  }

  say(`→ ${tool} : téléchargement ${spec.file}`);
  const archive = path.join(cache, spec.file);
  if (!(await exists(archive))) {
    await download(spec.url, archive);
  }
  if (spec.sha256) {
    await verifyChecksum(archive, spec.sha256);
  }

  const work = path.join(cache, `extract-${key}-${tool}`);
  await fs.rm(work, { recursive: true, force: true });
  await fs.mkdir(work, { recursive: true });
  await extractAny(archive, work);

  const root = await archiveRoot(work, binName(tool));

  // ffmpeg/ffprobe : deux fichiers isoles (builds statiques).
  // mpv : le dossier entier, ses DLLs etant indispensables.
  if (spec.wholeDir) {
    // mpv : tout le dossier. Les DLLs (avcodec, libplacebo, vulkan-1…) sont
    // indispensables ; mpv.com est le build console, celui qui garde stdout.
    await copyResolved(root, binDir);
    say(`  (dossier complet copié, ${await countDlls(binDir)} DLL(s))`);
  } else {
    for (const name of [binName(tool)]) {
      const from = path.join(root, name);
      if (await exists(from)) {
        await fs.copyFile(from, target);
        if (!isWindows) await fs.chmod(target, 0o755);
      }
    }
  }

  await fs.rm(work, { recursive: true, force: true });
  if (!(await exists(target))) {
    console.error(`  ✗ ${tool} absent après extraction`);
    process.exitCode = 1;
  } else {
    say(`  ✓ ${path.join(binDir, binName(tool))}`);
  }
}

/**
 * Copie l'exécutable du système, en déréférençant le lien symbolique.
 *
 * Ne copie QUE le fichier. La version précédente faisait
 * `copyResolved(path.dirname(candidate), binDir)`, c'est-à-dire copiait le
 * dossier entier : sur une distribution, ce dossier est `/usr/bin`, et
 * l'artefact embarquait 1 855 fichiers pour 1,6 Go — `bash`, `apt`, `curl`,
 * `7z`… Le contrôle de charge utile ne le voyait pas, puisque `mpv`, `ffmpeg`
 * et `ffprobe` y étaient bien, au bon format. C'est ce qui remplissait le
 * disque et faisait échouer le build sur `ENOSPC`.
 *
 * Le déréférencement reste nécessaire : `/usr/bin/ffmpeg` est souvent un lien
 * symbolique, et un lien copié tel quel pointerait vers un chemin qui
 * n'existera pas chez l'utilisateur.
 */
async function fromSystem(tool) {
  const nom = binName(tool);
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, nom);
    if (await exists(candidate)) {
      const cible = path.join(binDir, nom);
      const reel = await fs.realpath(candidate).catch(() => candidate);
      await fs.copyFile(reel, cible);
      if (!isWindows) await fs.chmod(cible, 0o755);
      return candidate;
    }
  }
  return null;
}

async function countDlls(dir) {
  const entries = await fs.readdir(dir).catch(() => []);
  return entries.filter((name) => name.endsWith(".dll")).length;
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
