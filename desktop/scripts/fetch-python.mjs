/**
 * Recupere le runtime Python autonome du backend.
 *
 * Remplace la partie `PYTHON="${NEUROBEATS_PYTHON:-$HOME/python/bin/python3.13}"`
 * et le controle d'autonomie de stage-runtime.sh, tous deux écrit pour un poste
 * Unix. Un Python installe depuis python.org sur Windows ne convient pas : le
 * script exige un runtime autonome (python-build-standalone), qui embarque son
 * propre `libpython` et n'attend rien du systeme.
 *
 * Les sommes viennent de `python-build.json`, relevees sur les assets publies.
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  binName,
  download,
  extractTarGz,
  archiveRoot,
  copyResolved,
  isWindows,
  lanceurCible,
  pythonKey,
  say,
  verifyChecksum,
} from "./lib/build-env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  await fs.readFile(path.join(here, "python-build.json"), "utf8"),
);

const key = pythonKey();
const asset = manifest.assets[key];

if (!asset) {
  console.error(
    `Plate-forme Python non couverte : ${key}. ` +
      `Ajoute l'asset dans scripts/python-build.json.`,
  );
  process.exit(1);
}

// Le cache est partage : un runner qui reconstruit ne retelecharge pas 70 Mo.
const cache = process.env.NEUROBEATS_PYTHON_CACHE
  ? path.resolve(process.env.NEUROBEATS_PYTHON_CACHE)
  : path.join(os.tmpdir(), `neurobeats-python-${manifest.tag}`);

const target = path.join(cache, key);

/**
 * Localise l'interpreteur dans un runtime autonome.
 *
 * La position n'est pas la meme partout : les builds Unix le placent dans
 * `bin/python`, le build Windows a la racine (`python.exe` avec `Lib/` et
 * `Scripts/`, sans `bin/` du tout). C'est exactement l'ecart que
 * `config.ts:68-75` ne verrait pas — il concatene `python` + `bin` + nom.
 */
function pythonExecutable(pythonDir) {
  const candidates = isWindows
    ? [binName("python"), `bin/${binName("python")}`]
    : [`bin/${binName("python")}`, binName("python")];
  for (const candidate of candidates) {
    if (existsSync(path.join(pythonDir, candidate))) {
      return path.join(pythonDir, candidate);
    }
  }
  return null;
}

const pythonDir = path.join(target, "python");
const marker = path.join(cache, `.ready-${key}`);

const cached = pythonExecutable(pythonDir);
if (cached) {
  // Le marqueur est (re)ecrit meme en sortie antecipee : c'est lui que
  // stage-runtime.mjs lit pour retrouver le chemin, et l'ignorer ici laissait
  // un runtime deja present mais considered absent.
  await fs.writeFile(marker, pythonDir, "utf8");
  say(`→ Runtime Python deja en cache : ${cached}`);
  process.exit(0);
}

await fs.mkdir(target, { recursive: true });

const archive = path.join(cache, asset.file);
if (!(await exists(archive))) {
  say(`→ Téléchargement Python ${manifest.version} (${key})`);
  await download(`${manifest.base}/${asset.file}`, archive);
}

if (asset.sha256) {
  say("→ Vérification de la somme SHA-256");
  await verifyChecksum(archive, asset.sha256);
} else {
  say(`  (aucune somme enregistrée pour ${key} — nom de fichier vérifié)`);
}

say("→ Extraction");
const work = path.join(cache, `extract-${key}`);
await fs.rm(work, { recursive: true, force: true });
await extractTarGz(archive, work);
const root = await archiveRoot(work, "python");

await fs.rm(target, { recursive: true, force: true });
await fs.mkdir(path.dirname(target), { recursive: true });
await copyResolved(root, target);
await fs.rm(work, { recursive: true, force: true });

// Contrôle d'autonomie : un runtime autonome embarque sa propre stdlib, donc
// `lib` (Unix) ou `Lib` (Windows) doit etre present. Un Python installe
// depuis python.org n'a pas cette organisation et ne convient pas.
const libDirs = ["lib", "Lib"].map((name) => path.join(pythonDir, name));
const hasLib = libDirs.some((dir) => existsSync(dir));
if (!hasLib) {
  console.error(
    "Le runtime Python extrait ne contient ni lib/ ni Lib/ : " +
      "l'asset n'est probablement pas un runtime autonome.",
  );
  process.exit(1);
}

const executable = pythonExecutable(pythonDir);
if (!executable) {
  console.error(
    `Aucun interpreteur trouve dans ${pythonDir} ` +
      `(attendu ${binName("python")} a la racine ou dans bin/).`,
  );
  process.exit(1);
}

const reported = await captureVersion(executable);
say(`✓ Python ${reported} prêt (${key})`);
say(`  ${executable}`);

// stage-runtime.mjs relit ce fichier : il ne faut pas qu'il doive deviner la
// position de l'interpreteur, qui differe entre Unix (bin/) et Windows
// (racine), ni deriver la cle de plate-forme une seconde fois.
await fs.writeFile(marker, pythonDir, "utf8");

function exists(target) {
  try {
    return existsSync(target);
  } catch {
    return false;
  }
}

async function captureVersion(exe) {
  // Le runtime de la cible n'est pas forcement executable ici : sous un build
  // croise, `python.exe` est un PE32 que seul wine sait lancer. Sans le
  // lanceur, la sortie est le `not found` du shell devant l'en-tete `MZ` du
  // binaire — bruyant, et facelement lu comme « runtime corrompu » plutot que
  // « mauvais lanceur ».
  const { prefixe, env } = lanceurCible();
  return new Promise((resolve) => {
    let out = "";
    const argv = prefixe.length ? [...prefixe, exe, "-V"] : [exe, "-V"];
    // `-V` ecrit sur stderr : on capture les deux flux.
    const proc = spawn(argv[0], argv.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    proc.stdout.on("data", (chunk) => (out += chunk));
    proc.stderr.on("data", (chunk) => (out += chunk));
    proc.on("close", () => resolve(out.trim() || "version inconnue"));
    proc.on("error", () => resolve("version inconnue"));
  });
}
