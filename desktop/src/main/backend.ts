// Processus backend FastAPI : spawn, health poll, sorties, arrêt propre.
// Le backend est TOUJOURS un enfant de l'app (isolation) : Jamais de sonde ni
// de réutilisation d'un backend externe ; l'arrêt ne tue que notre processus.
import { ChildProcess, spawn, spawnSync } from "child_process";
import fs from "fs";
import path from "path";

import {
  backendEnv,
  backendInstanceId,
  backendPort,
  backendRuntime,
  desktopUserDataDir,
  modelsDir,
  standaloneDir,
  webDevSrcDir,
} from "./config";

export type LogSink = (line: string, stream: "stdout" | "stderr") => void;

export function backendHealthUrl(port: number): string {
  return `http://127.0.0.1:${port}/api/health`;
}

export async function backendHealthy(
  port: number,
  timeoutMs = 2500,
  expectedInstanceId?: string,
): Promise<boolean> {
  try {
    const res = await fetch(backendHealthUrl(port), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    if (!expectedInstanceId) return true;
    const envelope = (await res.json()) as {
      status?: string;
      data?: { service?: string; instance_id?: string | null };
      service?: string;
      instance_id?: string | null;
    };
    const health = envelope.data ?? envelope;
    return health.service === "neurobeats-backend" && health.instance_id === expectedInstanceId;
  } catch {
    return false;
  }
}

/** Poll le /api/health jusqu'à disponibilité (défaut 90 s, comme dev.sh). */
export async function waitForBackend(
  port: number,
  onTick?: (elapsedMs: number) => void,
  timeoutMs = 90_000,
  expectedInstanceId = backendInstanceId(port),
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await backendHealthy(port, 1500, expectedInstanceId)) return;
    onTick?.(Date.now() - start);
    await new Promise((r) => setTimeout(r, 600));
  }
  throw new Error(
    `Backend attendu ${expectedInstanceId} absent ou incompatible après ` +
      `${Math.round(timeoutMs / 1000)} s`,
  );
}

export function spawnBackend(port: number, onLog: LogSink): ChildProcess {
  const rt = backendRuntime();
  const proc = spawn(rt.cmd, rt.args, {
    cwd: rt.dir,
    env: backendEnv(port),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // groupe de process propre → killTree(-pid) à la sortie
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

/**
 * Arrêt (SIGTERM par défaut — le lifespan backend coupe mpv proprement).
 * `force` passe au SIGKILL immédiat (échec de shutdown).
 */
function waitForProcessGroupExit(pid: number, timeoutMs = 2000): Promise<void> {
  if (process.platform === "win32") return Promise.resolve();
  const started = Date.now();
  return new Promise((resolve) => {
    const check = (): void => {
      try {
        process.kill(-pid, 0);
      } catch {
        resolve();
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        resolve();
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
}

export function stopBackend(proc: ChildProcess | null, force = false): Promise<void> {
  return new Promise((resolve) => {
    if (!proc?.pid) {
      resolve();
      return;
    }
    // Le PGID reste valable après la mort du leader : c'est précisément ce cas
    // où mpv peut survivre dans son groupe. Figer ce PID évite qu'un event
    // tardif de ChildProcess ne rende le kill de groupe non déterministe.
    const pid = proc.pid;

    // ISOLATION + SON : le moteur backend vit dans son PROPRE groupe de
    // process (detached:true) et y embarque le daemon mpv (spawné sans
    // start_new_session → même groupe). Tuer le PID seul laisserait mpv
    // orphelin → le son « tourne toujours » après quitter l'app.
    // → on signale le GROUPE (-pid), POSIX comme Windows (/T /F).
    const signalGroup = (sig: NodeJS.Signals): boolean => {
      try {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
          return true;
        }
        process.kill(-pid, sig);
        return true;
      } catch {
        // Groupe déjà mort ou perdu : repli sur le PID seul.
        try {
          proc.kill(sig);
          return true;
        } catch {
          return false;
        }
      }
    };

    // Si le leader backend a déjà quitté, `exit` ne sera plus émis : on coupe
    // malgré tout le groupe survivant puis on termine immédiatement.
    if (proc.exitCode !== null || proc.signalCode !== null) {
      signalGroup("SIGKILL");
      void waitForProcessGroupExit(pid).then(resolve);
      return;
    }

    let settled = false;
    let escalation: NodeJS.Timeout | null = null;
    let deadline: NodeJS.Timeout | null = null;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (escalation) clearTimeout(escalation);
      if (deadline) clearTimeout(deadline);
      void waitForProcessGroupExit(pid).then(resolve);
    };
    proc.once("exit", finish);

    if (!signalGroup(force ? "SIGKILL" : "SIGTERM")) {
      finish();
      return;
    }

    escalation = setTimeout(() => signalGroup("SIGKILL"), 8000);
    // Filet final : un OS très lent ne doit pas empêcher Electron de quitter.
    deadline = setTimeout(finish, 9000);
    escalation.unref();
    deadline.unref();
  });
}

/**
 * Récolte les processus d'une session dont le main est mort sans shutdown
 * (crash, SIGKILL) : le backend et le daemon mpv survivent, le port reste
 * occupé et le son continue au relaunch.
 *
 * Fingerprints stricts, tous spécifiques au userData de CETTE instance :
 * - backend : profil desktop + userData + ligne main.py ;
 * - mpv : profil desktop + userData + socket NeuroBeats reconnaissable ;
 * - llama-server : profil desktop + userData + répertoire de modèles ;
 * - worker : profil desktop + userData + script de téléchargement connu ;
 * - frontend : profil desktop + userData + bundle web dev ou standalone.
 *
 * Un occupant qui ne correspond pas à ces signatures est étranger : il n'est
 * jamais tué et le refus de démarrage reste appliqué (isolation stricte).
 */
export async function reapNeurobeatsOrphans(): Promise<void> {
  if (process.platform !== "linux") return;
  const userDataMarker = `NEUROBEATS_USER_DATA_DIR=${desktopUserDataDir()}`;
  const standalone = standaloneDir();
  const devSource = webDevSrcDir();
  const webNodeModules = standalone ? path.join(standalone, "web-node-modules") : null;
  const entries = await fs.promises.readdir("/proc").catch(() => [] as string[]);
  const victims = new Map<number, { killGroup: boolean }>();

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    const [cmdline, environ, status] = await Promise.all([
      fs.promises.readFile(`/proc/${entry}/cmdline`, "utf8").catch(() => ""),
      fs.promises.readFile(`/proc/${entry}/environ`, "utf8").catch(() => ""),
      fs.promises.readFile(`/proc/${entry}/status`, "utf8").catch(() => ""),
    ]);
    const args = cmdline.split("\0").filter(Boolean);
    const env = environ.split("\0");
    // Le fingerprint ne suffit pas pour distinguer un orphan de la session
    // d'un autre lancement (notamment le backend dev sur le même port). Un
    // enfant encore attaché à un parent vivant ne doit jamais être récolté.
    const parentPid = Number(status.match(/^PPid:\s+(\d+)/m)?.[1] ?? 0);
    if (parentPid !== 1) continue;
    const isOurUserData =
      env.includes(userDataMarker) && env.includes("NEUROBEATS_PROFILE=desktop");
    const isOurBackend =
      args.some((arg) => arg === "main.py" || arg.endsWith("/main.py")) &&
      isOurUserData;
    const isOurMpv =
      args.some((arg) => /^--input-ipc-server=\/tmp\/neurobeats-mpv-\d+\.sock$/.test(arg)) &&
      isOurUserData;
    // llama-server hérite de l'environnement du backend. Le userData et le
    // répertoire de modèles évitent de tuer le runtime d'une autre instance.
    const isOurLlama =
      args.some((arg) => path.basename(arg) === "llama-server") &&
      isOurUserData &&
      (env.includes(`NEUROBEATS_MODELS_DIR=${modelsDir()}`) ||
        args.some((arg) => arg.startsWith(`${modelsDir()}/`)));
    const isOurDownloadWorker =
      args.some(
        (arg) =>
          path.basename(arg) === "model_download_worker.py" ||
          arg === "services.model_download_worker",
      ) && isOurUserData;
    const nodePath = env.find((value) => value.startsWith("NODE_PATH="))?.slice(9) || "";
    const nodePathEntries = nodePath.split(path.delimiter);
    const isNextServer = args.some((arg) => arg === "next-server" || arg.startsWith("next-server "));
    // Le nom d'un AppImage peut changer entre deux lancements et l'ancien
    // répertoire extrait est ensuite supprimé. Le suffixe reste stable, contrairement
    // à une égalité avec process.resourcesPath de la nouvelle instance.
    const isStandaloneNodePath = nodePathEntries.some(
      (entry) =>
        (webNodeModules && entry === webNodeModules) ||
        entry.endsWith(path.join("resources", "web", "web-node-modules")),
    );
    const isDevNext =
      args.some((arg) => path.basename(arg) === "next" || arg === "next") &&
      args.includes("dev");
    // `npm run dev` est le leader de groupe du frontend dev. npm réécrit son
    // process title : /proc/<pid>/cmdline ne contient alors qu'UN seul argument,
    // « npm run dev -p 3150 -H 127.0.0.1 ». Tester args.includes("run") échouerait
    // ; c'est ce leader (et non next) qu'il faut tuer pour emporter toute la
    // subtree npm → sh → next.
    const flatCmdline = args.join(" ");
    const isDevNpm = /\bnpm\b[^|]*\brun\b[^|]*\bdev\b/.test(flatCmdline);
    const isOurFrontend = Boolean(
      isOurUserData &&
        ((isNextServer && isStandaloneNodePath && env.includes("ELECTRON_RUN_AS_NODE=1")) ||
          (isDevNext && args.some((arg) => arg.startsWith(devSource))) ||
          isDevNpm),
    );
    if (
      !isOurBackend
      && !isOurMpv
      && !isOurLlama
      && !isOurDownloadWorker
      && !isOurFrontend
    ) continue;
    victims.set(pid, { killGroup: isOurBackend || isOurFrontend });
  }

  for (const [pid, victim] of victims) {
    try {
      if (victim.killGroup) {
        // Le groupe (-pid) contient aussi mpv lorsqu'il est encore vivant.
        process.kill(-pid, "SIGKILL");
      } else {
        process.kill(pid, "SIGKILL");
      }
    } catch {
      if (!victim.killGroup) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Déjà disparu entre la lecture et le signal.
      }
    }
  }

  // Le port doit être libéré avant le contrôle d'occupation qui suit.
  const deadline = Date.now() + 3000;
  for (const pid of victims.keys()) {
    while (Date.now() < deadline) {
      const alive = await fs.promises
        .access(`/proc/${pid}`)
        .then(() => true)
        .catch(() => false);
      if (!alive) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}