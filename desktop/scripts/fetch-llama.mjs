/**
 * Telecharge le binaire llama.cpp utilise par le moteur local.
 *
 * Remplace fetch-llama.sh, dont le `case "$(uname -s)-$(uname -m)"` faisait
 * `exit 1` des que la machine etait Windows : sous Git Bash, `uname -s`
 * renvoie `MINGW64_NT-…`, qui ne correspond a aucune branche. Node expose la
 * vraie plate-forme, et Windows a enfin sa branche.
 *
 * Le build est volontairement epingle : le packaging doit produire le meme
 * runtime tant que la version du modele/serveur n'est pas mise a jour
 * manuellement.
 *
 * Sous Linux x64 on prend le build VULKAN, pas le build CPU : meme release de
 * llama.cpp, mais il sait decharger les couches sur le GPU (-ngl) — generation
 * ~3x plus rapide sur une machine a GPU — et il retombe sur le CPU quand Vulkan
 * est absent (le backend CPU reste embarque). Quelques Mo de plus, la ou un
 * build CUDA exigerait d'embarquer ~600 Mo de cudart en plus. Windows suit la
 * meme regle.
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
  extractTarGz,
  extractZip,
  isLinux,
  isMac,
  isWindows,
  run,
  say,
  verifyChecksum,
} from "./lib/build-env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  await fs.readFile(path.join(here, "llama-build.json"), "utf8"),
);

const BUILD = process.env.NEUROBEATS_LLAMA_BUILD || manifest.build;

function llamaKey() {
  if (isWindows) return "win32-x64";
  if (isMac) return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  return process.arch === "arm64" ? "linux-arm64" : "linux-x64";
}

const key = llamaKey();
const platformAssets = manifest.assets[key];

if (!platformAssets) {
  console.error(
    `Plate-forme llama.cpp non couverte : ${key}. ` +
      `Ajoute l'asset dans scripts/llama-build.json.`,
  );
  process.exit(1);
}

const asset = platformAssets[BUILD];
if (!asset) {
  console.error(
    `Build llama.cpp inconnu : ${BUILD} pour ${key}. ` +
      `Construits : ${Object.keys(platformAssets).join(", ")}`,
  );
  process.exit(1);
}

const desktop = path.resolve(here, "..");
const runtimeDir = path.join(desktop, "runtime");
const executable = path.join(runtimeDir, binName("llama-server"));

// Idempotent : le script anterior laissait un binaire Linux en place, qu'il
// ne faut surtout pas emballer dans un artefact Windows.
if (await isRunnable(executable)) {
  say(`→ llama-server déjà présent : ${executable}`);
  process.exit(0);
}
if (await exists(executable)) {
  say(`→ Binaire présent mais inexécutable, remplacement : ${executable}`);
  await fs.rm(executable, { force: true });
}

const cache = process.env.NEUROBEATS_LLAMA_CACHE
  ? path.resolve(process.env.NEUROBEATS_LLAMA_CACHE)
  : path.join(os.tmpdir(), `neurobeats-llama-${BUILD}`);

const archive = path.join(cache, asset.file);
if (!(await exists(archive))) {
  say(`→ Téléchargement ${asset.file}`);
  await download(asset.url, archive);
}

if (asset.sha256) {
  say("→ Vérification de la somme SHA-256");
  await verifyChecksum(archive, asset.sha256);
} else {
  say(`  (aucune somme enregistrée pour ${key})`);
}

say("→ Extraction");
const work = path.join(cache, `extract-${key}-${BUILD}`);
await fs.rm(work, { recursive: true, force: true });
await fs.mkdir(work, { recursive: true });

if (asset.file.endsWith(".zip")) await extractZip(archive, work);
else await extractTarGz(archive, work);

// Les builds llama.cpp ont un dossier racine ; le marqueur est l'executable.
const root = await archiveRoot(work, binName("llama-server"));

// Le serveur est dynamiquement lie aux backends ggml : on embarque toutes les
// bibliotheques de l'archive, pas seulement l'executable de 18 Ko.
await fs.rm(runtimeDir, { recursive: true, force: true });
await copyResolved(root, runtimeDir);
await fs.rm(work, { recursive: true, force: true });

const staged = path.join(runtimeDir, binName("llama-server"));
if (!(await exists(staged))) {
  console.error(`llama-server absent après extraction dans ${runtimeDir}`);
  process.exit(1);
}
if (!isWindows) await fs.chmod(staged, 0o755);

say(`✓ llama-server ${BUILD} prêt (${key})`);
say(`  ${staged}`);

/** Un binaire d'une autre plate-forme ne doit pas passer pour valide. */
async function isRunnable(file) {
  if (!(await exists(file))) return false;
  const header = await fs.readFile(file).then(
    (buffer) => buffer.subarray(0, 4),
    () => null,
  );
  if (!header) return false;
  if (isWindows) return header[0] === 0x4d && header[1] === 0x5a; // MZ
  if (isMac) return true; // Mach-O : magic variable, pas de test simple ici
  return (
    header[0] === 0x7f &&
    header.subarray(1, 4).toString("latin1") === "ELF"
  );
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
