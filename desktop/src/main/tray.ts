// Tray : il reste disponible tant que l'application est ouverte. Le menu
// « Quitter » converge vers le même arrêt complet que la croix, les raccourcis
// et les signaux, avec confirmation explicite si un titre joue.
import { Menu, nativeImage, Tray } from "electron";

let tray: Tray | null = null;

export interface TrayHandlers {
  show: () => void;
  profileIa: () => void;
  quit: () => void;
}

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#0066ff"/><stop offset="1" stop-color="#00d9ff"/>
  </linearGradient></defs>
  <circle cx="12" cy="12" r="10" fill="none" stroke="url(#g)" stroke-width="2.2"/>
  <path d="M9.5 9v6.5l5.5-3.25z" fill="url(#g)"/>
</svg>`;

export function createTray(handlers: TrayHandlers, iconPath?: string | null): void {
  const logo = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  const img = logo.isEmpty()
    ? nativeImage.createFromDataURL(
        "data:image/svg+xml;base64," + Buffer.from(ICON_SVG).toString("base64"),
      )
    : logo;
  tray = new Tray(img.resize({ width: 18, height: 18, quality: "best" }));
  tray.setToolTip("NeuroBeats");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Afficher NeuroBeats", click: handlers.show },
      { label: "Profil → IA", click: handlers.profileIa },
      { type: "separator" },
      { label: "Quitter NeuroBeats", click: handlers.quit },
    ]),
  );
  // Windows : clic sur l'icône = afficher. macOS : laisse le menu s'ouvrir.
  if (process.platform === "win32") tray.on("click", handlers.show);
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}