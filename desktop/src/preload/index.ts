// Pont preload : l'interface web/ reste inchangée (read-only) ; les extensions
// desktop sont montées dans son isolated world et communiquent via Electron.
import { contextBridge, ipcRenderer } from "electron";

import { installProfileModelsPanel } from "./profile-models";

installProfileModelsPanel();

contextBridge.exposeInMainWorld("desktopAPI", {
  /** Infos d'environnement de l'app desktop (résolues côté main). */
  info(): Promise<{
    isDev: boolean;
    apiUrl: string;
    backendPort: number;
    frontendPort: number;
    dataDir: string;
    modelsDir: string;
    instanceId: string;
    platform: string;
    versions: { electron: string; node: string; chrome: string };
  }> {
    return ipcRenderer.invoke("desktop:info");
  },

  /** Abonnement aux logs du backend (moteur) pour un éventuel inspecteur. */
  onBackendLog(cb: (line: string, stream: "stdout" | "stderr") => void): () => void {
    const listener = (_event: unknown, line: string, stream: "stdout" | "stderr") =>
      cb(line, stream);
    ipcRenderer.on("desktop:backend-log", listener);
    return () => ipcRenderer.removeListener("desktop:backend-log", listener);
  },
});
