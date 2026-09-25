// Config du wrapper : ports, chemins runtime, environnement du backend.
//
// ISOLATION : l'app spawn TOUJOURS son propre backend ; elle ne sonde, ne
// réutilise ni ne tue jamais un process externe. Si le port backend est occupé
// par un autre programme, l'app refuse de démarrer (message clair) au lieu de
// se brancher dessus.
//
// Ports : défaut 8041 (port DÉDIÉ à l'app — distinct du backend de dev sur 8040)
// et 3150 (page). Les
// deux sont surchargables par env (NEUROBEATS_PORT / NEUROBEATS_FRONTEND_PORT)
// pour échapper à une collision ou tester sans gêner un backend existant.
// ATTENTION : la page du front lit l'URL API *inlinée au build* — en mode
// standalone, builder avec NEUROBEATS_API_URL=http://localhost:<port> pour
// que page et backend restent cohérents (voir scripts/sync-web.sh).
import { app } from "electron";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import { BACKEND_PORT, FRONTEND_PORT } from "../shared/constants";

/** Port backend effectif : env NEUROBEATS_PORT ou défaut 8041 (dédié à l'app). */
export function backendPort(): number {
  const fromEnv = parsePort(process.env.NEUROBEATS_PORT);
  return fromEnv ?? BACKEND_PORT;
}

/** Port de la page : env NEUROBEATS_FRONTEND_PORT ou défaut 3150. */
export function frontendPort(): number {
  const fromEnv = parsePort(process.env.NEUROBEATS_FRONTEND_PORT);
  return fromEnv ?? FRONTEND_PORT;
}

function parsePort(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  return null;
}

export function isDev(): boolean {
  return process.argv.includes("--dev");
}

/**
 * Configure le userData avant le verrou single-instance et la création des
 * fenêtres. L'AppImage installée et l'Electron lancé depuis le dépôt ne
 * doivent pas partager ce répertoire : sinon le second lancement est
 * simplement focalisé sur le premier au lieu de démarrer son propre moteur.
 */
export function configureUserDataPath(): void {
  const override = process.env.NEUROBEATS_USER_DATA_DIR;
  const appData = app.getPath("appData");
  const instanceName = app.isPackaged ? "NeuroBeats" : "NeuroBeats-dev";
  const target = override && override.trim()
    ? path.resolve(override)
    : path.join(appData, instanceName);
  app.setPath("userData", target);
  fs.mkdirSync(target, { recursive: true });
}

// Racine du repo : desktop/dist/main -> desktop -> repo
export const repoRoot = path.resolve(__dirname, "..", "..", "..");

/** Point d'entrée du backend (python + main.py), dev ou packagé. */
export function backendRuntime(): { cmd: string; args: string[]; dir: string } {
  const pyName = process.platform === "win32" ? "python.exe" : "python";
  const base = app.isPackaged
    ? path.join(process.resourcesPath, "backend")
    : path.join(repoRoot, "backend");
  const candidates = app.isPackaged
    ? [
        path.join(base, ".venv", "bin", pyName),
        path.join(base, "python", "bin", pyName),
      ]
    : [path.join(base, ".venv", "bin", pyName)];
  const cmd = candidates.find((candidate) => fs.existsSync(candidate));
  if (!cmd) {
    throw new Error(
      `Runtime Python backend introuvable (${candidates.join(" ou ")}). ` +
      "Lancez `npm run stage` avant le packaging.",
    );
  }
  return { cmd, args: ["main.py"], dir: base };
}

/** Répertoire des modèles GGUF téléchargés (userData, vide si inutile). */
export function modelsDir(): string {
  return path.join(app.getPath("userData"), "models");
}

/** Racine Electron propre à l'instance installée ou de développement. */
export function desktopUserDataDir(): string {
  return app.getPath("userData");
}

/** Données mutables du backend, hors du bundle de ressources en lecture seule. */
export function backendDataDir(): string {
  return path.join(desktopUserDataDir(), "data");
}

/**
 * Identité opaque du backend enfant. Le endpoint /api/health doit la renvoyer :
 * un backend web occupant le même port ne peut donc jamais être pris pour le
 * nôtre, même si sa route health répond parfaitement.
 */
export function backendInstanceId(port = backendPort()): string {
  const identity = `${app.getPath("userData")}\0${port}`;
  return `desktop-${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
}

/** Logo NeuroBeats officiel, réutilisé par les fenêtres, le tray et le packager. */
export function appIconPath(): string | null {
  const candidates = [
    path.join(__dirname, "..", "..", "build", "icon.png"),
    path.join(process.resourcesPath, "icon.png"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/** Binaire llama-server bundlé (resources/runtime ou desktop/runtime en dev). */
export function llamaServerPath(): string | null {
  const fromEnv = process.env.NEUROBEATS_LLAMA_SERVER;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const names = process.platform === "win32" ? ["llama-server.exe"] : ["llama-server"];
  for (const base of [
    path.join(process.resourcesPath, "runtime"),
    path.join(repoRoot, "desktop", "runtime"),
  ]) {
    for (const n of names) {
      const p = path.join(base, n);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/** Répertoires bundlés (mpv, ffmpeg, ffprobe) à injecter dans le PATH du backend. */
export function bundledBinDirs(): string[] {
  const dirs: string[] = [];
  for (const base of [
    path.join(process.resourcesPath, "bin"),
    path.join(repoRoot, "desktop", "runtime"),
  ]) {
    if (fs.existsSync(base)) dirs.push(base);
  }
  return dirs;
}

/** Environnement complet du processus backend. */
export function backendEnv(port: number): NodeJS.ProcessEnv {
  const env = { ...process.env };
  env.NEUROBEATS_PORT = String(port);
  env.NEUROBEATS_TIMING = "1";
  env.NEUROBEATS_PROFILE = "desktop";
  env.NEUROBEATS_INSTANCE_ID = backendInstanceId(port);
  env.NEUROBEATS_USER_DATA_DIR = desktopUserDataDir();
  env.NEUROBEATS_DATA_DIR = backendDataDir();
  env.NEUROBEATS_MODELS_DIR = modelsDir();
  const llama = llamaServerPath();
  if (llama) env.NEUROBEATS_LLAMA_SERVER = llama;
  const binDirs = bundledBinDirs();
  if (binDirs.length > 0) {
    env.PATH = [...binDirs, env.PATH || ""].join(path.delimiter);
  }
  return env;
}

/** Répertoire du build standalone Next (mode prod), ou null (dev). */
export function standaloneDir(): string | null {
  const fromEnv = process.env.NEUROBEATS_STANDALONE_DIR;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  if (app.isPackaged) {
    const p = path.join(process.resourcesPath, "web");
    return fs.existsSync(p) ? p : null;
  }
  const p = path.join(repoRoot, "desktop", ".runtime", "web-standalone");
  return fs.existsSync(p) ? p : null;
}

/**
 * Copie dev du front (mode --dev) : web/ est read-only, on travaille sur
 * .runtime/web-dev-src (node_modules en symlink). Chaque copie a son propre
 * .next — aucun conflit avec un `next dev` externe tournant sur web/ (lock
 * Next 16 partagé par dossier) et aucune écriture dans web/.
 */
export function webDevSrcDir(): string {
  const fromEnv = process.env.NEUROBEATS_WEB_DEV_SRC;
  if (fromEnv) return fromEnv;
  return path.join(repoRoot, "desktop", ".runtime", "web-dev-src");
}

export const MPV_PATH_HINT = `mpv via PATH (${os.platform()})`;