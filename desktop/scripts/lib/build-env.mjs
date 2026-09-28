/**
 * Plate-forme de build, et helpers transverses.
 *
 * Remplace les `uname -s` / `MINGW` des scripts bash : sous Git Bash,
 * `uname -s` renvoie `MINGW64_NT-…`, qui ne correspond a aucune branche du
 * `case` de fetch-llama.sh et faisait `exit 1`. Node expose la vraie
 * plate-forme, donc plus d'ambiguite.
 *
 * # Cible et hote sont deux choses differentes
 *
 * `isWindows` / `isMac` / `isLinux` decrivent la CIBLE de l'artefact, pas la
 * machine qui construit. Les deux ne coincident que sur un build natif, et la
 * confusion est lourde de consequences : un build `--win` lance sur Linux doit
 * aller chercher les binaires Windows, les nommer `mpv.exe`, et verifier
 * qu'ils sont bien des PE32. Sans cette distinction, un build etranger
 * embarquait les binaires du systeme — c'est ainsi qu'un `.exe` de 321 Mo a ete
 * produit avec des ELF Linux a l'interieur, donc sans aucun lecteur audio.
 *
 * `NEUROBEATS_TARGET_PLATFORM` force la cible (`win32-x64`, `darwin-arm64`,
 * `linux-x64`…). Elle ne remplace pas `process.platform` partout : `onWindows` /
 * `onMac` / `onLinux` decrivent l'hote et servent a choisir un OUTIL systeme
 * (`7z`, `shell: true`), qui doit exister la ou la commande est lancee, pas dans
 * l'artefact produit.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import os from "node:os";

// --- l'hote, tel qu'il est ----------------------------------------------------

export const onWindows = process.platform === "win32";
export const onMac = process.platform === "darwin";
export const onLinux = process.platform === "linux";

function cleDeLhote() {
  if (onWindows) return "win32-x64";
  if (onMac) return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  return process.arch === "arm64" ? "linux-arm64" : "linux-x64";
}

const CIBLES_CONNUES = new Set([
  "win32-x64",
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
]);

const cibleDemandee = (process.env.NEUROBEATS_TARGET_PLATFORM ?? "").trim();

if (cibleDemandee && !CIBLES_CONNUES.has(cibleDemandee)) {
  throw new Error(
    `NEUROBEATS_TARGET_PLATFORM inconnue : « ${cibleDemandee} ». ` +
      `Attendues : ${[...CIBLES_CONNUES].join(", ")}`,
  );
}

/**
 * electron-builder ne produit pas de cible macOS hors macOS : le `.dmg`
 * exige `hdiutil` ou `dmgbuild`, et le bundle `.app` doit etre assemble par un
 * outil mac. Aucun equivalent de wine n'existe pour ces outils, donc la
 * contrainte est reels : on echoue tot et clairement plutot que de livrer un
 * `.dmg` vide.
 *
 * Windows, en revanche, se construit depuis Linux ou macOS : wine sait
 * executer le runtime Python de la cible ( indispensable : `pip` doit y
 * installer des wheels win_amd64) et electron-builder s'en sert deja pour
 * l'assemblage NSIS. C'est ce qui distingue les deux cibles.
 */
if (cibleDemandee.startsWith("darwin") && !onMac) {
  throw new Error(
    `Cible macOS demandée depuis ${process.platform} : impossible. Un .dmg exige ` +
      "macOS (hdiutil / dmgbuild), et aucun equivalent de wine n'existe. " +
      "Construisez sur un Mac, ou sur un runner macOS.",
  );
}

/**
 * wine est-il utilisable pour executer un binaire Windows ici ?
 *
 * Le prefixe est fixe et explicite : un prefixe implicite atterrit dans `~/.wine`,
 * et le build dependrait alors de l'etat d'un prefixe que personne ne controle.
 */
function wineDisponible() {
  if (onWindows) return true;
  for (const dir of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    if (existsSync(path.join(dir, "wine"))) return true;
  }
  return false;
}

// Le prefixe ne doit PAS etre sous `/tmp` : wine verifie la propriete du chemin
// et refuse de creer sa configuration la ou le repertoire n'appartient pas a
// l'utilisateur ("'/tmp' is not owned by you, refusing to create a
// configuration directory there"). On suit donc la convention XDG, qui est par
// definition dans le repertoire de l'utilisateur.
export const prefixeWine =
  process.env.NEUROBEATS_WINEPREFIX ||
  path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
    "neurobeats-wine",
  );

/** Cle de manifeste pour la plate-forme CIBLE. */
export function platformKey() {
  return cibleDemandee || cleDeLhote();
}

/** La cible est-elle differente de la machine qui construit ? */
export function estCroisee() {
  return cibleDemandee !== "" && cibleDemandee !== cleDeLhote();
}

export const isWindows = platformKey().startsWith("win32");
export const isMac = platformKey().startsWith("darwin");
export const isLinux = platformKey().startsWith("linux");

/** Cle du manifeste python-build.json pour la plate-forme cible. */
export function pythonKey() {
  return platformKey();
}

/* ------------------------------------------------- executer la cible ici */

const wineManquant =
  cibleDemandee.startsWith("win32") && !onWindows && !wineDisponible();

/**
 * Commande a lancer pour executer le runtime DE LA CIBLE sur CETTE machine.
 *
 * Natif : tel quel. Cible Windows hors Windows : prefixe par wine. Sans wine on
 * ne peut pas installer les dependances backend (les wheels doivent etre des
 * `win_amd64`, donc c'est bien le Python Windows qui doit faire le travail), et
 * un artefact sans backend ne servirait a rien.
 */
export function lanceurCible() {
  if (!cibleDemandee.startsWith("win32") || onWindows) {
    return { prefixe: [], env: {} };
  }
  if (wineManquant) {
    throw new Error(
      "Cible win32-x64 depuis " +
        `${process.platform} sans wine : impossible d'installer les dependances ` +
        "backend (pip doit interpreter des wheels win_amd64). Installez wine, " +
        "ou construisez sur une machine Windows.",
    );
  }
  return {
    prefixe: ["wine"],
    env: { WINEPREFIX: prefixeWine, WINEDEBUG: "-all" },
  };
}

/**
 * Chemin vu par le runtime de la cible.
 *
 * Sous wine, `Z:` designe la racine du systeme de fichiers Linux. C'est
 * reversible et sans ambiguite, donc un chemin Linux se traduit simplement.
 * L'inverse aussi : `sysconfig` renvoie `Z:\\tmp\\...`, qu'il faut relire
 * comme `/tmp/...` pour pouvoir copier le dossier depuis Node.
 */
export function versCheminCible(cheminLinux) {
  const absolu = path.resolve(cheminLinux);
  if (!cibleDemandee.startsWith("win32") || onWindows) return absolu;
  return `Z:\\${absolu.replace(/^\//, "").split(path.sep).join("\\")}`;
}

export function depuisCheminCible(chemin) {
  if (cibleDemandee.startsWith("win32") && /^Z:/i.test(chemin)) {
    const reste = chemin.slice(2).replace(/\\/g, "/");
    return reste.startsWith("/") ? reste : `/${reste}`;
  }
  return chemin;
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

/**
 * Decompresse un `.zip` (llama.cpp et ffmpeg sous Windows).
 *
 * Trois extracteurs sont essayes dans l'ordre, et le premier qui reussit gagne.
 * Le repli sur `tar` seul ne suffit pas : le `tar` de GNU ne reconnait pas un zip
 * ("Ceci ne ressemble pas a une archive de type tar"), et c'est celui de la
 * plupart des distributions Linux. `7z` lit le zip comme le 7z — d'ou sa
 * presence dans les deux listes — et `unzip` est le dernier recours.
 */
export async function extractZip(archive, dest) {
  await fs.mkdir(dest, { recursive: true });
  try {
    // Deja present : dependance d'electron, avec les prebuilds Windows.
    const { extract } = await import("@electron-internal/extract-zip");
    await extract(archive, { dir: path.resolve(dest) });
    return;
  } catch (err) {
    say(`  (extract-zip a échoué : ${err.message?.split("\n")[0] ?? "raison inconnue"})`);
  }

  const septZ = onWindows ? ["C:/Program Files/7-Zip/7z.exe", "7z"] : ["7z", "7za", "7zr"];
  for (const commande of [...septZ, "unzip"]) {
    try {
      const args =
        commande === "unzip"
          ? ["-q", "-o", archive, "-d", dest]
          : ["x", archive, `-o${dest}`, "-y"];
      await run(commande, args);
      return;
    } catch {
      // extracteur suivant
    }
  }
  throw new Error(
    `Impossible de decompresser ${path.basename(archive)} : ni extract-zip, ` +
      `ni 7z, ni unzip n'ont reussi.`,
  );
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
  const candidates = onWindows
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
 * Racine d'une archive extraite : le dossier qui contient `marker`.
 *
 * Les archives n'ont pas toutes la meme profondeur, et c'est la source d'un
 * echec Builds silencieux :
 * - `python-build-standalone` en `install_only` extracte a la racine ;
 * - llama.cpp place l'executable dans `<dossier>/bin/`, soit un niveau ;
 * - les builds ffmpeg de BtbN (Windows) font `<dossier>/bin/ffmpeg.exe`, soit
 *   DEUX niveaux.
 *
 * Une recherche limitee a un seul niveau trouvait donc la racine de l'archive
 * ffmpeg sans jamais voir le binaire, et `fetch-bin.mjs` concluait « absent
 * apres extraction » alors que l'archive etait parfaitement correcte.
 *
 * La recherche est en largeur et bornee a {@link PROFONDEUR_MAX}, pour renvoyer
 * le match le plus proche de la racine — deux binaires ne portant pas le meme
 * nom dans la meme archive, et l'ordre du `readdir` n'etant pas garanti, on se
 * tient a la profondeur minimale pour rester deterministe.
 */
const PROFONDEUR_MAX = 3;

export async function archiveRoot(dir, marker) {
  let niveau = [dir];
  for (let profondeur = 0; profondeur <= PROFONDEUR_MAX; profondeur += 1) {
    const suivants = [];
    for (const courant of niveau) {
      if (await existsAsync(path.join(courant, marker))) return courant;
      const entries = await fs.readdir(courant, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory()) suivants.push(path.join(courant, entry.name));
      }
    }
    if (suivants.length === 0) break;
    niveau = suivants;
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

/**
 * Format binaire attendu sur la plate-forme courante.
 *
 * C'est le garde-fou qui manquait : rien ne verifiait que les binaires
 * embarques etaient de la meme plate-forme que la cible. Un build macOS
 * produit sous Linux empaquetait alors des binaires Linux — un `.app` qui
 * s'ouvrait sans audio ni moteur d'IA, sans que rien ne le signale.
 */
export function formatAttendu() {
  if (isWindows) return "PE32";
  if (isMac) return "Mach-O";
  return "ELF";
}

/** Le format binaire reel d'un fichier, lu sur ses premiers octets. */
export async function formatReel(file) {
  let handle;
  try {
    handle = await fs.open(file, "r");
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buffer, 0, 4, 0);
    if (bytesRead < 4) return null;
    // MZ (Windows) : le reste n'a pas besoin d'etre inspecte.
    if (buffer[0] === 0x4d && buffer[1] === 0x5a) return "PE32";
    // 0x7F 'E' 'L' 'F' (Linux et BSD)
    if (
      buffer[0] === 0x7f &&
      buffer[1] === 0x45 &&
      buffer[2] === 0x4c &&
      buffer[3] === 0x46
    ) {
      return "ELF";
    }
    // Mach-O : 0xFEEDFACE / 0xFEEDFACF (32/64 bits, big/little endian)
    if (buffer[0] === 0xfe && buffer[1] === 0xed) return "Mach-O";
    if (buffer[0] === 0xcf && buffer[1] === 0xfa) return "Mach-O";
    if (buffer[0] === 0xce && buffer[1] === 0xfa) return "Mach-O";
    return "inconnu";
  } finally {
    await handle.close();
  }
}

/**
 * Verifie qu'un binaire est bien de la plate-forme attendue.
 *
 * @returns {Promise<boolean>} true si le format correspond.
 */
export async function verifierFormat(file) {
  const attendu = formatAttendu();
  const reel = await formatReel(file);
  if (reel === attendu) return true;
  warn(
    `  ✗ ${path.basename(file)} est ${reel ?? "illisible"}, ` +
      `alors que la cible attend ${attendu}`,
  );
  return false;
}

/** Lance une commande, avec `shell` sous Windows (`npm` y est `npm.cmd`). */
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...(onWindows ? { shell: true } : {}),
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
