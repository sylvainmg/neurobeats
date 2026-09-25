// Processus frontend Next : next dev (copie runtime de web/, jamais web/ lui-même)
// ou server.js standalone (output: 'standalone') servi par Electron lui-même via
// ELECTRON_RUN_AS_NODE=1 — un Node gratuit, zéro dépendance système, et
// l'optimiseur next/image conservé.
import { ChildProcess, spawn } from "child_process";
import fs from "fs";
import path from "path";

import {
  backendInstanceId,
  backendPort,
  desktopUserDataDir,
  repoRoot,
  standaloneDir,
  webDevSrcDir,
} from "./config";
import { LogSink } from "./backend";

export function frontendTarget(port: number): string {
  return `http://127.0.0.1:${port}/`;
}

export async function frontendReady(port: number, timeoutMs = 2500): Promise<boolean> {
  try {
    const res = await fetch(frontendTarget(port), { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function waitForFrontend(
  port: number,
  onTick?: (elapsedMs: number) => void,
  timeoutMs = 120_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await frontendReady(port, 1500)) return;
    onTick?.(Date.now() - start);
    await new Promise((r) => setTimeout(r, 600));
  }
  throw new Error(`Interface injoignable après ${Math.round(timeoutMs / 1000)} s`);
}

/** Mode dev : next dev dans une COPIE runtime du source web/ (jamais web/).
 *
 * web/ est read-only : on (re)copie le source vers .runtime/web-dev-src
 * (node_modules en symlink) puis on y lance next dev. Avantages :
 *   - aucune écriture dans web/ (pas même .next) ;
 *   - .next dédié à la copie → aucun conflit de lock Next 16 avec un
 *     `next dev` externe (ex. dev.sh qui tourne sur 3100 dans web/) ;
 *   - l'URL API est inlinée au build : on injecte NEXT_PUBLIC_API_URL dans
 *     l'env du process (prioritaire sur .env.local) pour que la page pointe
 *     sur LE backend de l'app (port dédié, ex. 8041) — jamais un backend tiers.
 */
function ensureDevSource(): string {
  const src = path.join(repoRoot, "web");
  const dest = webDevSrcDir();
  // .env* jamais copiés : web/.env.local pointe le backend de DEV (8040) et
  // serait inliné par Turbopack dans le bundle CLIENT — l'app doit toujours
  // parler à SON backend (8041). Le .env.local de la copie est écrit plus bas.
  const EXCLUDE = new Set(["node_modules", ".next", ".git"]);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const copyTree = (fromDir: string, toDir: string): void => {
    for (const e of fs.readdirSync(fromDir, { withFileTypes: true })) {
      if (EXCLUDE.has(e.name) || e.name.startsWith(".env")) continue;
      const s = path.join(fromDir, e.name);
      const d = path.join(toDir, e.name);
      if (e.isDirectory()) {
        fs.mkdirSync(d, { recursive: true });
        copyTree(s, d);
      } else {
        fs.copyFileSync(s, d);
      }
    }
  };
  copyTree(src, dest);
  // Notre .env.local à nous : quelle que soit la priorité de Turbopack (process
  // env injecté OU fichier .env), la valeur de NEXT_PUBLIC_API_URL est celle de
  // l'app — le backend de dev 8040 ne peut jamais apparaître dans le bundle.
  fs.writeFileSync(
    path.join(dest, ".env.local"),
    `NEXT_PUBLIC_API_URL=http://127.0.0.1:${backendPort()}\n`,
  );
  const srcNm = path.join(src, "node_modules");
  if (!fs.existsSync(srcNm)) {
    throw new Error("web/node_modules introuvable — lancez d'abord `npm install` dans web/");
  }
  try {
    fs.symlinkSync(srcNm, path.join(dest, "node_modules"), "dir");
  } catch {
    fs.symlinkSync(srcNm, path.join(dest, "node_modules"), "junction"); // Windows
  }
  // Turbopack refuse un node_modules symlinké hors de sa racine de résolution.
  // On élargit la racine au repo (web/node_modules y est) — le next.config.ts
  // de la COPIE est patché en conséquence (jamais celui de web/).
  const cfgPath = path.join(dest, "next.config.ts");
  const cfg = fs.readFileSync(cfgPath, "utf8");
  const patched = cfg.replace(
    /export default (\w+);/,
    `export default { ...$1, turbopack: { root: ${JSON.stringify(repoRoot)} } };`,
  );
  if (patched === cfg) {
    throw new Error("next.config.ts de web/ : motif `export default <nom>;` introuvable");
  }
  fs.writeFileSync(cfgPath, patched);

  // next/font/google télécharge le .woff2 depuis fonts.gstatic.com AU COMPILE.
  // Le .next de la copie étant purgé à chaque boot, chaque lancement re-exige
  // le réseau — et peut bloquer Turbopack (« Compiling / » sans fin) sur réseau
  // lent ou hors-ligne. La copie remplace donc Inter par une pile système,
  // machine CSS identique (la variable --font-inter reste définie).
  patchOutGoogleFont(dest);
  return dest;
}

/** Retire next/font/google de la COPIE (layout.tsx + globals.css). */
function patchOutGoogleFont(dest: string): void {
  const layoutPath = path.join(dest, "app", "layout.tsx");
  const layout = fs.readFileSync(layoutPath, "utf8");
  const importLine = `import { Inter } from "next/font/google";\n`;
  const interBlock = `const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});`;
  if (!layout.includes(importLine) || !layout.includes(interBlock)) {
    throw new Error("web/app/layout.tsx : motifs next/font/google introuvables (source changée ?)");
  }
  fs.writeFileSync(
    layoutPath,
    layout
      .replace(importLine, "")
      .replace(
        interBlock,
        "// Copie desktop : Inter non téléchargé (pile système, voir globals.css).\nconst inter = { variable: \"--font-inter\" as const };",
      ),
  );

  const cssPath = path.join(dest, "app", "globals.css");
  const css = fs.readFileSync(cssPath, "utf8");
  const markers = `  --font-sans: var(--font-inter), ui-sans-serif, system-ui, sans-serif;
  --font-heading: var(--font-inter), ui-sans-serif, system-ui, sans-serif;`;
  if (!css.includes(markers)) {
    throw new Error("web/app/globals.css : motifs --font-* introuvables (source changée ?)");
  }
  const stack = `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;
  fs.writeFileSync(
    cssPath,
    css.replace(
      markers,
      `  /* Copie desktop : --font-inter sans téléchargement Google (pile système). */\n  --font-inter: ${stack};\n  --font-sans: ${stack};\n  --font-heading: ${stack};`,
    ),
  );
}

export function spawnFrontendDev(port: number, onLog: LogSink): ChildProcess {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const proc = spawn(
    npm,
    ["run", "dev", "--", "-p", String(port), "-H", "127.0.0.1"],
    {
      cwd: ensureDevSource(),
      env: {
        ...process.env,
        NEXT_PUBLIC_API_URL: `http://127.0.0.1:${backendPort()}`,
        NEUROBEATS_PROFILE: "desktop",
        NEUROBEATS_INSTANCE_ID: backendInstanceId(),
        NEUROBEATS_USER_DATA_DIR: desktopUserDataDir(),
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // npm → next dev : killTree(-pid) tue tout le groupe
    },
  );
  pipeLogs(proc, onLog);
  return proc;
}

/** Mode prod : server.js du build standalone, exécuté par le binaire Electron. */
export function spawnFrontendStandalone(port: number, onLog: LogSink): ChildProcess {
  const dir = standaloneDir();
  if (!dir) {
    throw new Error(
      "Build standalone introuvable. Lancez `npm run standalone` (scripts/sync-web.sh) " +
        "ou passez NEUROBEATS_STANDALONE_DIR.",
    );
  }
  const nodeModules = path.join(dir, "web-node-modules");
  const proc = spawn(process.execPath, ["server.js"], {
    cwd: dir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      NEUROBEATS_PROFILE: "desktop",
      NEUROBEATS_INSTANCE_ID: backendInstanceId(),
      NEUROBEATS_USER_DATA_DIR: desktopUserDataDir(),
      NODE_PATH: [nodeModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // groupe de process propre → killTree(-pid)
  });
  pipeLogs(proc, onLog);
  return proc;
}

function pipeLogs(proc: ChildProcess, onLog: LogSink): void {
  const fwd =
    (stream: "stdout" | "stderr") =>
    (chunk: Buffer): void => {
      for (const line of chunk.toString("utf8").split("\n")) {
        const l = line.trimEnd();
        if (l) onLog(l, stream);
      }
    };
  proc.stdout?.setEncoding("utf8");
  proc.stderr?.setEncoding("utf8");
  proc.stdout?.on("data", fwd("stdout"));
  proc.stderr?.on("data", fwd("stderr"));
}