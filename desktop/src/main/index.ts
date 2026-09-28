// Point d'entrée Electron : orchestration du conteneur NeuroBeats.
//
//   boot  : splash -> vérif port backend -> backend (FastAPI, mpv) ->
//           interface (Next) -> fenêtre
//   vie   : fermeture de la fenêtre = arrêt complet ; tray + single-instance
//   crash : backend mort -> dialog + relance ; frontend mort -> relance limitée
//   sortie: shutdown idempotent (frontend, backend, mpv, llama, downloads),
//           puis app.quit()
//
// ISOLATION : le backend est TOUJOURS un enfant de l'app. Si le port backend
// est déjà occupé par un process externe, l'app REFUSE de démarrer (dialog
// clair) — elle ne sonde, ne réutilise et ne tue jamais un backend tiers.
// À la sortie, seuls nos propres enfants sont tués.
import { ChildProcess, spawnSync } from "child_process";
import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import path from "path";

import {
  reapNeurobeatsOrphans,
  spawnBackend,
  stopBackend,
  waitForBackend,
} from "./backend";
import {
  appIconPath,
  backendDataDir,
  backendInstanceId,
  backendPort,
  configureUserDataPath,
  frontendPort,
  isDev,
  modelsDir,
} from "./config";
import { spawnFrontendDev, spawnFrontendStandalone, waitForFrontend } from "./frontend";
import { initLogging, logError, logLine, logPath } from "./logging";
import { isPortInUse } from "./ports";
import { closeSplash, createSplash, splashProgress } from "./splash";
import { createTray, destroyTray } from "./tray";
import {
  controler,
  demarrerServiceUpdate,
  etatCourant,
  ignorer,
  reporter,
  surChangement,
  telechargerEtInstaller,
} from "./update";

// Identité et isolation de l'instance : le userData est choisi avant le lock
// single-instance pour que l'AppImage et l'Electron de développement ne se
// focalisent pas mutuellement.
app.setName("NeuroBeats");
configureUserDataPath();

let mainWindow: BrowserWindow | null = null;
let backendProc: ChildProcess | null = null;
let frontendProc: ChildProcess | null = null;
let isQuitting = false;
// true dès qu'un shutdown() a été lancé → will-quit ne re-force PAS (sinon le
// SIGKILL immédiat annulerait la grâce SIGTERM du backend, et mpv serait coupé
// en plein sans nettoyage).
let shutdownInitiated = false;
let shutdownPromise: Promise<void> | null = null;
let quitRequest: Promise<void> | null = null;
let quitReady = false;
let backendCrashes = 0;
let lastCrashAt = 0;
let frontendCrashes = 0;
let lastFrontendCrashAt = 0;
let lastManualFrontendRelaunchAt = 0;
const recentLogs: string[] = [];

// ------------------------------------------------------------------- fenêtres

/** Dialog centré sur la fenêtre principale si elle est visible, sinon autonome. */
function msgBoxSync(opts: Electron.MessageBoxSyncOptions): number {
  return mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()
    ? dialog.showMessageBoxSync(mainWindow, opts)
    : dialog.showMessageBoxSync(opts);
}
function msgBox(opts: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  return mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()
    ? dialog.showMessageBox(mainWindow, opts)
    : dialog.showMessageBox(opts);
}

function mainWindowOpts(): Electron.BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "NeuroBeats",
    icon: appIconPath() ?? undefined,
    backgroundColor: "#0b0f14",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}

function showMain(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow(mainWindowOpts());
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  // Toute fermeture de fenêtre (X, protocole du compositeur, etc.) est une
  // vraie sortie : le nettoyage des enfants doit finir avant l'app Electron.
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    void requestQuit(false);
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (
      input.type === "keyDown"
      && input.key.toLowerCase() === "q"
      && (input.control || input.meta)
      && !input.alt
    ) {
      event.preventDefault();
      void requestQuit(false);
    }
  });
  void mainWindow.loadURL(`http://127.0.0.1:${frontendPort()}/`);
}

function showProfileIa(): void {
  showMain();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const target = `http://127.0.0.1:${frontendPort()}/profile?tab=ia`;
  if (mainWindow.webContents.getURL() !== target) {
    void mainWindow.webContents.loadURL(target);
  }
}

// ------------------------------------------------------------------- logs

function collectLog(line: string, stream: "stdout" | "stderr"): void {
  recentLogs.push(line);
  if (recentLogs.length > 400) recentLogs.shift();
  logLine(line, stream);
  if (isDev()) console.log(`[${stream}] ${line}`);
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("desktop:backend-log", line, stream);
  }
  if (line.includes("[API] NeuroBeats backend prêt")) {
    splashProgress(70, "Moteur prêt");
  }
}

// ------------------------------------------------------------------- backend

function watchBackend(): void {
  backendProc?.on("exit", (code) => {
    if (isQuitting) return;
    // Le leader a peut-être disparu brutalement en laissant mpv vivant dans
    // son groupe. Le groupe reste adressable par l'ancien PGID : le couper ici
    // garantit qu'un « crash backend » n'est jamais un « son orphelin ».
    void stopBackend(backendProc, true);
    const now = Date.now();
    if (now - lastCrashAt > 60_000) backendCrashes = 0;
    lastCrashAt = now;
    backendCrashes += 1;
    const detail =
      `Code de sortie : ${code ?? "?"}\n\n` +
      recentLogs.slice(-25).join("\n") +
      `\n\n(La musique et le moteur d'IA local sont coupés.)\nJournaux complets : ${logPath()}`;
    const choice = msgBoxSync({
      type: "error",
      buttons: ["Relancer le moteur", "Quitter"],
      defaultId: 0,
      cancelId: 1,
      title: "Moteur NeuroBeats arrêté",
      message: "Le moteur interne s'est arrêté de façon inattendue.",
      detail,
    });
    if (choice === 0 && backendCrashes <= 3) {
      splashProgress(5, "Relance du moteur…");
      backendProc = spawnBackend(backendPort(), collectLog);
      watchBackend();
      void waitForBackend(backendPort(), (el) => splashProgress(10, `Moteur… ${Math.round(el / 1000)} s`))
        .then(() => splashProgress(70, "Moteur relancé"))
        .catch(() => {
          backendProc = null;
          app.quit();
        });
    } else {
      backendProc = null;
      app.quit();
    }
  });
}

// ------------------------------------------------------------------- frontend

function spawnFrontend(): ChildProcess {
  const port = frontendPort();
  // --dev = itération sur le source web/ (next dev) ; sans --dev = build
  // standalone (server.js servi via ELECTRON_RUN_AS_NODE). Comportement
  // prévisible : la présence d'un vieux build ne change rien au choix du mode.
  return isDev() ? spawnFrontendDev(port, collectLog) : spawnFrontendStandalone(port, collectLog);
}

function watchFrontend(): void {
  frontendProc?.on("exit", () => {
    if (isQuitting) return;
    // Anti-tempête de dialogs : au plus 2 relances en 60 s, sinon on laisse
    // la musique continuer et l'utilisateur relance via le tray.
    const now = Date.now();
    if (now - lastFrontendCrashAt > 60_000) frontendCrashes = 0;
    lastFrontendCrashAt = now;
    frontendCrashes += 1;
    if (frontendCrashes <= 2) {
      frontendProc = spawnFrontend();
      watchFrontend();
      void waitForFrontend(frontendPort()).catch(() => {
        frontendProc = null;
      });
      return;
    }
    const choice = msgBoxSync({
      type: "warning",
      buttons: ["Relancer l'interface", "Quitter"],
      defaultId: 0,
      cancelId: 1,
      title: "Interface arrêtée",
      message: "L'interface s'est arrêtée de façon inattendue (plusieurs fois).",
      detail: "La musique peut continuer ; relancer l'interface la rend à nouveau contrôlable.",
    });
    const doRelaunch = (): void => {
      frontendCrashes = 0;
      frontendProc = spawnFrontend();
      watchFrontend();
      void waitForFrontend(frontendPort()).catch(() => {
        frontendProc = null;
      });
    };
    if (choice === 0) {
      // Relance manuelle qui re-crash dans les 30 s = état irrécupérable :
      // on arrête proprement l'app au lieu de boucler sur des dialogs.
      if (Date.now() - lastManualFrontendRelaunchAt < 30_000) {
        frontendProc = null;
        dialog.showErrorBox(
          "Interface instable",
          "L'interface s'est arrêtée immédiatement après la relance. Le moteur audio " +
            `a été arrêté. Relancez l'application ; si le problème persiste, consultez les logs :\n${logPath()}`,
        );
        app.quit();
        return;
      }
      lastManualFrontendRelaunchAt = Date.now();
      doRelaunch();
    } else {
      app.quit();
    }
  });
}

// ------------------------------------------------------------------- sortie

async function confirmQuitIfPlaying(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${backendPort()}/api/now`, {
      signal: AbortSignal.timeout(3000),
    });
    const data = (await res.json()) as { data?: { playing?: boolean; paused?: boolean; title?: string } };
    const now = data?.data;
    if (now?.playing && !now?.paused) {
      const { response } = await msgBox({
        type: "question",
        buttons: ["Quitter (coupe la musique)", "Annuler"],
        defaultId: 1,
        cancelId: 1,
        title: "Musique en cours",
        message: "Un titre est en cours de lecture.",
        detail: `« ${now.title ?? "?"} » — Quitter NeuroBeats coupera le son.`,
      });
      return response === 0;
    }
  } catch {
    // backend absent : on quitte sans confirmation
  }
  return true;
}

/** Tue un process ET son arbre (groupe de process POSIX / taskkill sur Windows).
 *
 * Les enfants sont spawnés avec `detached: true` : sur POSIX ils forment leur
 * propre groupe (PGID == pid) — `kill(-pid)` atteint tout le groupe, y compris
 * les générations intermédiaires (ex. npm → next dev). Sans ça, tuer l'enfant
 * direct laisse des orphelins sur les ports. */
function killTree(proc: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
  if (!proc.pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"]);
      return;
    }
    process.kill(-proc.pid, signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {
      /* déjà terminé */
    }
  }
}

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopFrontend(proc: ChildProcess | null, force: boolean): Promise<void> {
  const pid = proc?.pid;
  if (!proc || !pid) return;
  killTree(proc, force ? "SIGKILL" : "SIGTERM");
  if (process.platform === "win32") return;

  const deadline = Date.now() + (force ? 1_000 : 3_000);
  while (Date.now() < deadline && processGroupAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (processGroupAlive(pid)) {
    killTree(proc, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function shutdown(force = false): Promise<void> {
  if (shutdownPromise) {
    if (force) {
      void stopFrontend(frontendProc, true);
      void stopBackend(backendProc, true);
    }
    return shutdownPromise;
  }
  shutdownInitiated = true;
  isQuitting = true;

  const backend = backendProc;
  const frontend = frontendProc;
  shutdownPromise = (async () => {
    // Les deux groupes sont arrêtés en parallèle, puis ATTENDUS avant
    // app.quit(). Sans cette attente, le processus Electron peut disparaître
    // pendant que Next, Python, mpv, llama-server ou un worker terminent.
    await Promise.all([
      stopFrontend(frontend, force),
      stopBackend(backend, force),
    ]);
  })();

  return shutdownPromise;
}

async function finishQuit(force = false): Promise<void> {
  await shutdown(force);
  quitReady = true;
  app.quit();
}

async function requestQuit(confirmPlaying = false): Promise<void> {
  if (quitReady) {
    app.quit();
    return;
  }
  if (quitRequest) return quitRequest;

  quitRequest = (async () => {
    if (confirmPlaying && !(await confirmQuitIfPlaying())) return;
    await finishQuit();
  })().finally(() => {
    if (!quitReady) quitRequest = null;
  });
  return quitRequest;
}

// ------------------------------------------------------------------- boot

function showPortOccupied(port: number): void {
  splashProgress(100, "Port occupé");
  msgBoxSync({
    type: "error",
    buttons: ["Quitter"],
    defaultId: 0,
    cancelId: 0,
    title: "NeuroBeats ne peut pas démarrer",
    message: `Le port ${port} est déjà utilisé par un autre programme.`,
    detail:
      "NeuroBeats fonctionne en conteneur isolé : il lance son propre moteur et son " +
      "propre interface sur des ports dédiés, et ne s'attache jamais à un programme " +
      "existant.\n\nFermez l'autre programme qui occupe ce port puis relancez, ou " +
      "choisissez un autre port :\n" +
      "  NEUROBEATS_PORT=8090 NEUROBEATS_FRONTEND_PORT=3150 …\n" +
      "(le build standalone doit alors être fait avec\n" +
      "  NEUROBEATS_API_URL=http://localhost:8090 npm run standalone)",
  });
}

async function boot(): Promise<void> {
  const port = backendPort();
  createSplash();
  splashProgress(5, "Vérification de l'environnement…");

  // ISOLATION + SOUCIS DE RELANCE : un main tué durement (crash, SIGKILL —
  // pas de shutdown()) laisse nos deux enfants, le backend NEUROBEATS_AGENT
  // (8041) ET son daemon mpv (même groupe process, spawné en detached:true),
  // orphelins (ppid=1) sur le port. Au relaunch, isPortInUse(port) les voyait
  // comme « backend étranger » → refus net → l'app NE démarrait plus, et le
  // SON continuait à tourner.
  //
  // → ON S'EN OCCUPE ICI, AVANT tout refus : on récolte les orphelins dont le
  //   fingerprint est NOTRE (moteur NeuroBeats : simili git/python dans notre
  //   runtime + mpv-neurobeats), et seulement eux. Un process qui occupe le
  //   port sans être identifiable comme un NEUROBEATS est un occupant
  //   étranger : on le laisse — le refus ci-dessous s'applique, jamais le kill.
  await reapNeurobeatsOrphans();

  // ISOLATION : on ne partage JAMAIS le port d'un process existant. Occupé ->
  // refus net, message clair, sortie. (Le lock single-instance couvre déjà le
  // cas d'un autre wrapper ; ici il s'agit d'un backend externe — devant être
  // lancé par le dev, l'autre app desktop n'existant pas.)
  if (await isPortInUse(port)) {
    showPortOccupied(port);
    app.quit();
    return;
  }
  if (await isPortInUse(frontendPort())) {
    showPortOccupied(frontendPort());
    app.quit();
    return;
  }

  splashProgress(10, "Lancement du moteur audio…");
  backendProc = spawnBackend(port, collectLog);
  watchBackend();

  try {
    await waitForBackend(port, (el) =>
      splashProgress(Math.min(55, 10 + (el / 90_000) * 45), `Moteur… ${Math.round(el / 1000)} s`),
    );
  } catch (err) {
    splashProgress(100, "Échec du démarrage");
    dialog.showErrorBox(
      "NeuroBeats n'a pas pu démarrer",
      `${String(err)}\n\nDernières lignes du moteur :\n${recentLogs.slice(-15).join("\n")}\n\nJournaux complets : ${logPath()}`,
    );
    app.quit();
    return;
  }
  splashProgress(70, "Moteur prêt — interface…");

  frontendProc = spawnFrontend();
  watchFrontend();
  try {
    await waitForFrontend(frontendPort(), (el) =>
      splashProgress(Math.min(90, 70 + (el / 120_000) * 20), `Interface… ${Math.round(el / 1000)} s`),
    );
  } catch (err) {
    splashProgress(100, "Échec de l'interface");
    dialog.showErrorBox(
      "NeuroBeats n'a pas pu démarrer",
      `${String(err)}\n\nDernières lignes :\n${recentLogs.slice(-15).join("\n")}\n\nJournaux complets : ${logPath()}`,
    );
    app.quit();
    return;
  }

  splashProgress(100, "Prêt");
  showMain();
  setTimeout(closeSplash, 450);

  // Le contrôle de version part APRÈS l'affichage : il interroge le backend
  // pour savoir si une piste joue, et la fenêtre doit exister pour recevoir la
  // décision. Il est volontairement le dernier geste du démarrage — un joueur
  // musical ne doit pas retarder son premier son pour une question de version.
  demarrerServiceUpdate();
}

// ------------------------------------------------------------------- lifecycle

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showMain());

  app.whenReady().then(() => {
    const journal = initLogging();
    logLine(`démarrage — mode ${isDev() ? "dev" : "prod"} — journal ${journal}`);
    logLine(`instance — userData=${app.getPath("userData")} data=${backendDataDir()} models=${modelsDir()}`);
    if (process.platform === "darwin") {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }]),
      );
    } else {
      Menu.setApplicationMenu(null);
    }

    // Pont pour le préload / l'UI desktop locale.
    ipcMain.handle("desktop:info", () => ({      isDev: isDev(),
      apiUrl: `http://127.0.0.1:${backendPort()}`,
      backendPort: backendPort(),
      frontendPort: frontendPort(),
      dataDir: backendDataDir(),
      modelsDir: modelsDir(),
      instanceId: backendInstanceId(),
      logPath: logPath(),
      platform: process.platform,
      versions: { ...process.versions } as Record<string, string>,
    }));

    // Vérificateur de mise à jour : l'état courant, un contrôle manuel, les deux
    // réponses possibles (« plus tard » / « ignorer ») et l'installation. Voir
    // shared/update/README.md — la règle de bruit est décidée dans le module
    // partagé, pas ici.
    surChangement((etat) => {
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send("desktop:update", etat);
      }
    });
    ipcMain.handle("desktop:update-etat", () => etatCourant());
    ipcMain.handle("desktop:update-controler", () => controler(true));
    ipcMain.handle("desktop:update-reporter", () => reporter());
    ipcMain.handle("desktop:update-ignorer", () => ignorer());
    ipcMain.handle("desktop:update-installer", () => telechargerEtInstaller());

    createTray({
      show: showMain,
      profileIa: showProfileIa,
      quit: () => {
        void requestQuit(true);
      },
    }, appIconPath());

    void boot().catch((err) => {
      splashProgress(100, "Échec du démarrage");
      dialog.showErrorBox(
        "NeuroBeats n'a pas pu démarrer",
        `${String(err)}\n\nDernières lignes :\n${recentLogs.slice(-15).join("\n")}\n\nJournaux complets : ${logPath()}`,
      );
      app.quit();
    });
  });

  app.on("before-quit", (event) => {
    if (quitReady) return;
    event.preventDefault();
    void requestQuit(false);
  });

  app.on("will-quit", () => {
    // Filet de sécurité pour les sorties SANS shutdown préalable (échec de
    // boot, port occupé…) : ne jamais laisser traîner un backend qui joue.
    // Les signaux du groupe partent avant la première await de shutdown().
    if (!shutdownInitiated) void shutdown(true);
    logError("ARRÊT", "sortie de l'app — voir lignes précédentes pour le détail");
    destroyTray();
  });

  // Si le compositeur détruit la fenêtre sans close preventDefault (session
  // Hyprland, fermeture WM), on converge quand même vers le même arrêt.
  app.on("window-all-closed", () => {
    if (!isQuitting) void requestQuit(false);
  });

  // Un signal peut être transformé en app.quit() par Electron, ou delivered
  // directement au process Node selon la plateforme. Les deux chemins doivent
  // produire exactement le même nettoyage et ne jamais tuer un backend tiers.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as NodeJS.Signals[]) {
    process.on(signal, () => {
      logLine(`signal ${signal} reçu — arrêt orderly demandé`);
      void requestQuit(false);
    });
  }

  // Le menu tray « Quitter NeuroBeats » demande une confirmation explicite
  // avant de lancer cette même séquence.

  // Exception inattendue dans le main : on la journalise ET on sort proprement
  // (un état mi-démarré avec un backend orphelin serait pire).
  process.on("uncaughtException", (err) => {
    logError("UNCAUGHT EXCEPTION", err?.stack ?? String(err));
    dialog.showErrorBox(
      "Erreur interne",
      `${String(err)?.split("\n")[0]}\n\nJournaux : ${logPath()}`,
    );
    void finishQuit(true);
  });
}