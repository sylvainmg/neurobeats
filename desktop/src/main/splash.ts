// Fenêtre de démarrage : progression réelle (backend + interface) sans UI web/.
import { BrowserWindow } from "electron";

let win: BrowserWindow | null = null;

export function createSplash(): void {
  win = new BrowserWindow({
    width: 430,
    height: 250,
    frame: false,
    resizable: false,
    movable: true,
    show: false,
    alwaysOnTop: true,
    backgroundColor: "#0b0f14",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  if (process.platform !== "darwin") win.setMenuBarVisibility(false);
  void win.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(
        `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  :root { color-scheme: dark; }
  * { margin: 0; box-sizing: border-box; }
  body {
    background: radial-gradient(120% 120% at 20% 0%, #0f1a2b 0%, #0b0f14 60%);
    color: #e6edf3; font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    height: 100vh; display: flex; flex-direction: column; justify-content: center;
    padding: 24px 28px; user-select: none;
  }
  .logo { font-size: 20px; font-weight: 700; letter-spacing: .3px; }
  .logo span { color: #00d9ff; }
  .sub { color: #8b949e; margin: 2px 0 22px; font-size: 12px; }
  .bar { height: 5px; border-radius: 3px; background: #1c2631; overflow: hidden; }
  .bar i {
    display: block; height: 100%; width: 0; border-radius: 3px;
    background: linear-gradient(90deg, #0066ff, #00d9ff);
    transition: width .35s ease;
  }
  #status { margin-top: 12px; color: #9aa7b3; font-size: 12px; min-height: 18px; }
  .pulse { animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: .45; } 50% { opacity: 1; } }
</style>
</head>
<body>
  <div class="logo">Neuro<span>Beats</span></div>
  <div class="sub">lecteur audio local · moteur embarqué</div>
  <div class="bar"><i id="fill"></i></div>
  <div id="status" class="pulse">Démarrage…</div>
</body>
</html>`,
      ),
  );
  win.once("ready-to-show", () => win?.show());
  win.on("closed", () => {
    win = null;
  });
}

/** Progression (0-100) + message. Appelable autant de fois que nécessaire. */
export function splashProgress(pct: number, status: string): void {
  if (!win || win.isDestroyed()) return;
  void win.webContents.executeJavaScript(
    `document.getElementById('fill').style.width='${Math.max(0, Math.min(100, pct))}%';
     document.getElementById('status').textContent=${JSON.stringify(status)};`,
  );
}

/** Ferme la fenêtre de démarrage (à la création de la fenêtre principale). */
export function closeSplash(): void {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}