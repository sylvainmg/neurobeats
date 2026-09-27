/**
 * Prepare le runtime backend embarque dans l'artefact.
 *
 * Remplace stage-runtime.sh, qui etait ecrit pour Unix et sans aucune
 * conscience de la plate-forme :
 * - `rsync -a --exclude` (absent du PATH sous Windows) → `copyTree` ;
 * - `readlink -f`, `cp -a` → `fs.cp` avec dereference des liens ;
 * - `command -v` → resolution via `process.platform` ;
 * - `$HOME/python/bin/python3.13` → `fetch-python.mjs`, qui choisit l'asset
 *   correspondant a la plate-forme reelle.
 *
 * Deux points resolus ici :
 * - B1, le layout du runtime Python est **normalise** : l'executable est
 *   toujours pose dans `python/bin/`, y compris sous Windows (ou
 *   python-build-standalone le met a la racine). `config.ts:68-75` cherche
 *   `python/bin/python.exe` ; cette normalisation est ce qui rend ce chemin
 *   valide, sans toucher au code runtime.
 * - B2, l'echec est bruyant : un binaire manquant **fait sortir le script en
 *   erreur**. L'ancien script n'affichait qu'un avertissement, ce qui
 *   produisait des artefacts sans lecteur, en silence.
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  binName,
  copyResolved,
  copyTree,
  isWindows,
  run,
  say,
} from "./lib/build-env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, "..");
const root = path.resolve(desktop, "..");
const stage = path.join(desktop, ".runtime", "backend-package");

// Le runtime Python est recupere par fetch-python.mjs, qui ecrit son cache.
// On reutilise celui du systeme si l'utilisateur en fournit un (macOS : le
// runtime de developpement, qui gagne une seconde).
const pythonRoot = await resolvePythonRoot();

say("→ Preparation du runtime backend");
await fs.rm(stage, { recursive: true, force: true });
await fs.mkdir(stage, { recursive: true });

/* ------------------------------------------------------------------ Python */

say("→ Copie du runtime Python autonome");
const pythonDir = path.join(stage, "python");
await copyResolved(pythonRoot, pythonDir);

// Le layout est normalise : l'executable doit se trouver dans `python/bin/`,
// y compris sous Windows. `config.ts:75` attend exactement ce chemin.
const binDir = path.join(pythonDir, "bin");
await fs.mkdir(binDir, { recursive: true });
const nativeExe = path.join(pythonDir, binName("python"));
if (existsSync(nativeExe)) {
  await fs.copyFile(nativeExe, path.join(binDir, binName("python")));
  if (!isWindows) await fs.chmod(path.join(binDir, binName("python")), 0o755);
}
const python = path.join(binDir, binName("python"));
if (!existsSync(python)) {
  console.error(
    `Runtime Python incomplet : ${python} absent. ` +
      "Le moteur backend ne demarrera pas sans lui.",
  );
  process.exit(1);
}

/* ------------------------------------------------------------------ Backend */

say("→ Copie du backend (hors donnees et venv de dev)");
// Meme jeu d'exclusions que l'ancien script : le livrable ne doit contenir ni
// base SQLite, ni cache, ni historique, ni caches de pochettes ou de titres
// prepares — c'est ce qui garantit un produit vierge chez l'utilisateur.
await copyTree(path.join(root, "backend"), stage, {
  exclude: [
    ".venv/",
    "__pycache__/",
    "*.pyc",
    "*.log",
    "*.db",
    "*.db-*",
    "tests/",
    "neurobeats.db",
    "stream_cache.json",
    "music_history.json*",
    "user_profile.json*",
    "*.bak",
    "covers/",
    "prepared/",
  ],
});

/* ---------------------------------------------------------- Dependances pip */

say("→ Installation des dependances desktop");
const sitePackages = await capture(
  python,
  ["-c", "import sysconfig; print(sysconfig.get_path('purelib'))"],
);
await run(python, [
  "-m",
  "pip",
  "install",
  "--disable-pip-version-check",
  "--no-input",
  "--no-warn-script-location",
  // Toutes les dependances ont des wheels precompilees pour les quatre
  // plate-formes. Sans ce drapeau, une wheel manquante declencherait une
  // compilation depuis les sources : echec bruyant plutot qu'un runtime
  // incomplet et silencieusement different.
  "--only-binary=:all:",
  `--target=${sitePackages}`,
  "-r",
  path.join(desktop, "scripts", "requirements-desktop.txt"),
]);

/* ------------------------------------------------------------- Verification */

say("→ Verification des payloads embarques");
const binOut = path.join(desktop, "bin");
const runtimeOut = path.join(desktop, "runtime");

const missing = [];
for (const tool of ["mpv", "ffmpeg", "ffprobe"]) {
  const file = path.join(binOut, binName(tool));
  if (existsSync(file)) {
    say(`  ✓ ${binName(tool)}`);
  } else {
    missing.push(binName(tool));
  }
}

const llama = path.join(runtimeOut, binName("llama-server"));
if (existsSync(llama)) {
  say(`  ✓ ${binName("llama-server")}`);
} else {
  missing.push(binName("llama-server"));
}

if (missing.length > 0) {
  // C'est le garde-fou qui manquait : l'ancien script continuait, et
  // l'artefact partait sans lecteur audio ni moteur d'IA.
  console.error(
    `\nPayload incomplet : ${missing.join(", ")} manquant(s).\n` +
      "L'artefact qui en sortirait demarrerait sans audio et sans moteur " +
      "d'IA. Lance `npm run fetch:bin` et `npm run fetch:llama` pour les " +
      "recuperer, ouDefinissez NEUROBEATS_BIN_DIR / " +
      "NEUROBEATS_LLAMA_SERVER.",
  );
  process.exit(1);
}

say("✓ Runtime backend pret");

/* ------------------------------------------------------------------ Helpers */

async function resolvePythonRoot() {
  if (process.env.NEUROBEATS_PYTHON_ROOT) {
    return path.resolve(process.env.NEUROBEATS_PYTHON_ROOT);
  }
  // L'utilisateur peut fournir l'interpreteur plutot que le dossier (c'est
  // ce que faisait l'ancien script avec NEUROBEATS_PYTHON).
  if (process.env.NEUROBEATS_PYTHON) {
    return path.dirname(path.dirname(path.resolve(process.env.NEUROBEATS_PYTHON)));
  }
  // Sinon, on telecharge le runtime de la plate-forme.
  const cache = path.join(os.tmpdir(), "neurobeats-python-cache");
  const marker = path.join(cache, ".ready");
  if (!existsSync(marker)) {
    await run(process.execPath, [path.join(here, "fetch-python.mjs")], {
      env: { ...process.env, NEUROBEATS_PYTHON_CACHE: cache },
    });
  }
  // fetch-python.mjs ecrit le chemin dans ce fichier plutot que de le
  // distinguer sur stdout, qui melange les messages de progression.
  return path.resolve(await fs.readFile(marker, "utf8"));
}

async function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${path.basename(command)} a echoue : ${err.trim()}`));
    });
  });
}
