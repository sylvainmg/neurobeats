/**
 * Plate-forme de build, et helpers transverses.
 *
 * Remplace les `uname -s` / `MINGW` des scripts bash : sous Git Bash,
 * `uname -s` renvoie `MINGW64_NT-…`, qui ne correspond a aucune branche du
 * `case` de fetch-llama.sh et faisait `exit 1`. Node expose la vraie
 * plate-forme, donc plus d'ambiguite.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";

export const isWindows = process.platform === "win32";
export const isMac = process.platform === "darwin";
export const isLinux = process.platform === "linux";

/** Cle du manifeste python-build.json pour la plate-forme courante. */
export function pythonKey() {
  if (isWindows) return "win32-x64";
  if (isMac) return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  return process.arch === "arm64" ? "linux-arm64" : "linux-x64";
}

/** Nom de l'executable d'un binaire sur la plate-forme courante. */
export function binName(name) {
  return isWindows ? `${name}.exe` : name;
}

export function say(message) {
  process.stdout.write(`${message}\n`);
}

export function warn(message) {
  process.stderr.write(`${message}\n`);
}

/**
 * Copie recursive avec exclusions.
 *
 * Remplace `rsync -a --exclude=…`, absent du PATH sous Windows. `fs.cp`
 * accepte un `filter` depuis Node 22.12 — le plancher impose par electron
 * (desktop/node_modules/electron/package.json, `engines.node`).
 *
 * Les liens symboliques sont **dereferences** : `/usr/bin/ffmpeg` en est un
 * sur la plupart des distributions, et le runtime embarque doit contenir le
 * fichier reel, pas un lien vers un chemin qui n'existera pas chez l'utilisateur.
 */
export async function copyTree(src, dest, { exclude = [] } = {}) {
  const isExcluded = (relative) =>
    exclude.some((pattern) => matchesGlob(relative, pattern));

  await fs.cp(src, dest, {
    recursive: true,
    verbatimSymlinks: false,
    dereference: true,
    filter: (source) => {
      const relative = path.relative(src, source);
      if (!relative) return true;
      return !isExcluded(relative.split(path.sep).join("/"));
    },
  });
}

/**
 * Copie un payload en dereferenceant les liens symboliques.
 *
 * Pour les runtimes autonomes : leurs « install_only » utilisent des liens
 * relatifs (`bin/python` -> `bin/python3.13`). `fs.cp` les recopie tels quels,
 * et le lien pointe alors vers le dossier d'extraction temporaire, qui sera
 * supprime : l'executable devient un lien casse. On copie donc le contenu,
 * puis on resout chaque lien contre sa cible reelle.
 */
export async function copyResolved(src, dest) {
  await fs.cp(src, dest, { recursive: true, verbatimSymlinks: false });
  await resolveSymlinks(dest);
}

async function resolveSymlinks(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await fs.realpath(full).catch(() => null);
      if (!target) continue;
      const stats = await fs.stat(target).catch(() => null);
      const temp = `${full}.resolved`;
      if (stats?.isDirectory()) {
        await fs.cp(target, temp, { recursive: true });
        await fs.rm(full, { recursive: true, force: true });
        await fs.rename(temp, full);
      } else {
        await fs.copyFile(target, temp);
        await fs.rm(full, { force: true });
        await fs.rename(temp, full);
      }
    } else if (entry.isDirectory()) {
      await resolveSymlinks(full);
    }
  }
}

/**
 * Motif d'exclusion minimal, inspiree de la syntaxe rsync.
 *
 * Gere `nom`, `prefix/`, `*.ext` et `*.ext` suivi d'un chemin. C'est
 * volontairement etroit : les motifs employes par les scripts sont de cette
 * forme, et une implementation complete serait un second langage a maintenir.
 */
function matchesGlob(relative, pattern) {
  if (pattern.endsWith("/")) return relative.startsWith(pattern.slice(0, -1));
  if (pattern.startsWith("*") && !pattern.slice(1).includes("/")) {
    const ext = pattern.slice(1);
    return relative.endsWith(ext) || relative.includes(`/${ext}`);
  }
  if (!pattern.includes("*")) {
    return relative === pattern || relative.startsWith(`${pattern}/`);
  }
  return false;
}

/** Telecharge une URL vers `dest`, avec reprise sur erreur. */
export async function download(url, dest, tries = 3) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await pipeline(response.body, createWriteStream(dest));
      return;
    } catch (error) {
      if (attempt === tries) throw error;
      say(`  ! échec (${error.message}), nouvelle tentative ${attempt}/${tries}`);
    }
  }
}

/** Somme SHA-256 d'un fichier, pour verifier un asset telecharge. */
export async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * Verifie la somme d'un asset si elle est connue.
 *
 * Renvoie false quand aucune somme n'est enregistree : les plates-formes dont
 * l'asset n'a pas ete releve restent verifiees par le nom de fichier seul.
 */
export async function verifyChecksum(file, expected) {
  if (!expected) return true;
  const actual = await sha256File(file);
  if (actual !== expected) {
    throw new Error(
      `Somme SHA-256 invalide pour ${path.basename(file)}\n` +
        `  attendue ${expected}\n  obtenue ${actual}`,
    );
  }
  return true;
}

/**
 * Decompresse un `.tar.gz`.
 *
 * Utilise le `tar` du systeme : present sur Linux, macOS, et sur les runners
 * GitHub (y compris windows-latest, ou bsdtar fait partie de l'image).
 */
export async function extractTarGz(archive, dest) {
  await fs.mkdir(dest, { recursive: true });
  await run("tar", ["-xzf", archive, "-C", dest]);
}

/** Decompresse un `.zip` (llama.cpp sous Windows). */
export async function extractZip(archive, dest) {
  await fs.mkdir(dest, { recursive: true });
  try {
    // Deja present : dependance d'electron, avec les prebuilds Windows.
    const { extract } = await import("@electron-internal/extract-zip");
    await extract(archive, { dir: path.resolve(dest) });
    return;
  } catch {
    say("  (extract-zip indisponible, repli sur tar)");
  }
  await run("tar", ["-xf", archive, "-C", dest]);
}

/**
 * Decompresse un `.7z`.
 *
 * Node n'a pas de lecteur 7z, et c'est le format que publie shinchiro pour
 * mpv sous Windows. On passe donc par l'outil systeme : `7z` sous Linux et
 * macOS, et 7-Zip — preinstalle par GitHub — sur les runners windows.
 */
export async function extract7z(archive, dest) {
  await fs.mkdir(dest, { recursive: true });
  const candidates = isWindows
    ? ["C:/Program Files/7-Zip/7z.exe", "7z"]
    : ["7z", "7za", "7zr"];
  let lastError;
  for (const command of candidates) {
    try {
      await run(command, ["x", archive, `-o${dest}`, "-y"]);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Impossible de decompresser ${path.basename(archive)} : ` +
      `aucun extracteur 7z disponible (${lastError?.message ?? "inconnu"}). ` +
      "Sur Windows, verifie que 7-Zip est installe.",
  );
}

/** Decompresse selon l'extension : .zip, .7z ou .tar.gz. */
export async function extractAny(archive, dest) {
  if (archive.endsWith(".zip")) return extractZip(archive, dest);
  if (archive.endsWith(".7z")) return extract7z(archive, dest);
  return extractTarGz(archive, dest);
}

/**
 * Racine d'une archive extraite.
 *
 * python-build-standalone en `install_only` extracte directement a la racine
 * (pas de dossier intermediaire) ; llama.cpp en a un. On detecte lequel des
 * deux est correct plutot que de deviner.
 */
export async function archiveRoot(dir, marker) {
  const direct = path.join(dir, marker);
  if (await existsAsync(direct)) return dir;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await existsAsync(path.join(dir, entry.name, marker))) {
      return path.join(dir, entry.name);
    }
  }
  return dir;
}

async function existsAsync(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** Lance une commande, avec `shell` sous Windows (`npm` y est `npm.cmd`). */
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...(isWindows ? { shell: true } : {}),
      ...options,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} a echoue (code ${code})`));
    });
  });
}

export { existsSync, fs, path };
