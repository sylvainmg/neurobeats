// Persistance des logs (main + enfants backend/frontend) dans userData/logs.
// Un crash doit rester diagnosticable après coup, pas seulement visible au
// terminal (qui n'existe pas en mode packagé).
import { app } from "electron";
import fs from "fs";
import path from "path";

interface LogState {
  path: string;
}

let state: LogState | null = null;

/** Ouvre le journal de la run courante et retourne son chemin. */
export function initLogging(): string {
  const dir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `app-${ts}.log`);
  state = { path: file };
  // Pointeur texte vers la run courante (lisible par l'UI / les scripts).
  try {
    fs.writeFileSync(path.join(dir, "latest.log"), `${file}\n`);
  } catch {
    /* non bloquant */
  }
  return file;
}

/** Chemin du journal courant ("?" si pas initialisé). */
export function logPath(): string {
  return state?.path ?? "?";
}

// appendFileSync : synchrone — les dernières lignes (SIGTERM, crash) sont
// TOUJOURS sur disque, même si le process meurt juste après. Le débit est
// faible (une ligne par événement), le coût est négligeable.
/** Journalise une ligne (stdout/stderr d'un enfant ou message du main). */
export function logLine(line: string, stream?: string): void {
  if (!state) return;
  const entry = `${new Date().toISOString()}${stream ? ` [${stream}]` : ""} ${line}\n`;
  try {
    fs.appendFileSync(state.path, entry);
  } catch {
    /* disque plein / supprimé : on ne bloque pas le flux */
  }
}

/** Bloc de diagnostic (dialog, exception…) séparé visuellement dans le journal. */
export function logError(header: string, body: string): void {
  logLine(`===== ${header} =====`);
  for (const l of body.split("\n")) logLine(l);
  logLine("===== fin ===== ");
}