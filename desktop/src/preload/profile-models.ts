import { ipcRenderer } from "electron";

const ROOT_ID = "neurobeats-local-models";
const STYLE_ID = "neurobeats-local-models-style";
/**
 * Événement partagé par les DEUX interfaces du choix IA (ce panneau et le
 * formulaire « Modèle d'IA » du profil, qui est du React). Le choix a une seule
 * source de vérité côté backend : dès que l'un écrit, il prévient l'autre, qui
 * se resynchronise — sans cela les deux blocs affichaient deux choix différents.
 */
const AI_SELECTION_EVENT = "neurobeats:ai-selection";

function announceSelection(): void {
  window.dispatchEvent(new CustomEvent(AI_SELECTION_EVENT));
}

interface DownloadedModel {
  model_id: string;
  name: string;
  file: string;
  size_bytes: number;
  downloaded_at: string;
}

interface Recommendation {
  id: string;
  name: string;
  family: string;
  size_gb: number;
  dl_mb: number;
  min_ram_gb: number;
  quality: number;
  french: number;
  tool_calling: string;
  license: string;
  notes: string;
  fits: boolean;
  downloadable: boolean;
}

interface RecommendationResponse {
  hardware: {
    ram_gb: number;
    cpu_cores: number;
    disk_free_gb: number;
    gpu?: { name?: string; vram_gb?: number } | null;
  };
  memory_budget_gb: number;
  models: Recommendation[];
  best?: string | null;
}

interface EmbeddedState {
  /** idle | loading | ready | error — lisible pendant un chargement. */
  state?: "idle" | "loading" | "ready" | "error";
  /** Le modele choisi est encore en telechargement : rien a charger encore. */
  waiting_for_download?: boolean;
  pid?: number;
  port?: number;
  model_id?: string;
  since?: string;
  error?: string;
}

interface AiSettings {
  provider: string;
  /** Le choix, source unique : {"kind", "model"?}. */
  selection?: { kind?: string; model?: string };
  label?: string;
  configured?: boolean;
  embedded?: { model?: string };
  [key: string]: unknown;
}

type DownloadStatus =
  | "queued"
  | "starting"
  | "resolving"
  | "downloading"
  | "running"
  | "pausing"
  | "paused"
  | "cancelling"
  | "cancelled"
  | "done"
  | "error";

interface DownloadProgress {
  job_id?: string;
  model_id?: string;
  status: DownloadStatus;
  received: number;
  total: number;
  pct: number;
  speed_mbps?: number;
  error?: string;
  created_at?: string;
  updated_at?: string;
}

interface DownloadJob extends DownloadProgress {
  job_id: string;
  model_id: string;
}

/** Un depot GGUF trouve sur Hugging Face (navigateur de modeles). */
interface HubRepo {
  repo_id: string;
  downloads: number;
  likes: number;
  gated: boolean;
  updated?: string;
}

/** Un fichier GGUF d'un depot, avec son verdict de compatibilite machine. */
interface HubFile {
  filename: string;
  size_bytes: number;
  quant: string;
  fits: boolean | null;
  hint: string;
  /** GGUF decoupe en parties : inchargeable seul (il faut toutes les parties). */
  split?: boolean;
}

interface PanelState {
  activeTab: "download" | "installed" | "active";
  downloaded: Record<string, DownloadedModel>;
  files: string[];
  recommendation: RecommendationResponse | null;
  engine: EmbeddedState | null;
  settings: AiSettings | null;
  downloads: Map<string, DownloadProgress>;
  downloadWatchers: Map<string, Promise<void>>;
  hubOpen: boolean;
  hubQuery: string;
  hubRepos: HubRepo[] | null;
  hubRepo: string;
  hubFiles: HubFile[] | null;
  hubBusy: boolean;
  hubError: string;
}

const state: PanelState = {
  activeTab: "download",
  downloaded: {},
  files: [],
  recommendation: null,
  engine: null,
  settings: null,
  downloads: new Map(),
  downloadWatchers: new Map(),
  hubOpen: false,
  hubQuery: "",
  hubRepos: null,
  hubRepo: "",
  hubFiles: null,
  hubBusy: false,
  hubError: "",
};

let root: HTMLElement | null = null;
let apiBasePromise: Promise<string> | null = null;
let observer: MutationObserver | null = null;
let fullRefresh: Promise<void> | null = null;

function escapeHtml(value: unknown): string {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return String(value ?? "").replace(/[&<>"']/g, (character) => entities[character]);
}

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function apiBase(): Promise<string> {
  apiBasePromise ??= ipcRenderer
    .invoke("desktop:info")
    .then((info: { apiUrl: string }) => info.apiUrl)
    .catch(() => "http://127.0.0.1:8041");
  return apiBasePromise;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const base = await apiBase();
  const response = await fetch(`${base}${path}`, init);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let body: { status?: string; error?: string; data?: T } & Partial<T> = {};
  if (text) {
    body = JSON.parse(text) as typeof body;
  }
  if (!response.ok || (body.status !== undefined && body.status !== "ok")) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return (body.status === "ok" ? body.data : body) as T;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const gib = 1024 ** 3;
  if (bytes >= gib) return `${(bytes / gib).toFixed(1)} Go`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} Mo`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date inconnue";
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/** Vitesse de transfert lisible (Mo/s), vide si inconnue. */
function formatSpeed(mbps: number | undefined): string {
  if (!Number.isFinite(mbps) || (mbps ?? 0) <= 0) return "";
  return `${(mbps as number).toFixed(1)} Mo/s`;
}

/** Libellé de progression partagé : statut · reçu/total · vitesse. */
function transferLabel(progress: DownloadProgress, fallbackTotal = 0): string {
  const total = progress.total || fallbackTotal;
  const parts = [
    downloadStatusLabel(progress.status),
    `${formatBytes(progress.received)} / ${formatBytes(total)}`,
  ];
  if (progress.status === "downloading" || progress.status === "running") {
    const speed = formatSpeed(progress.speed_mbps);
    if (speed) parts.push(speed);
  }
  return parts.join(" · ");
}

function selectedModelId(): string | null {
  // Source unique : la sélection persistée. Jamais l'état du moteur — le
  // moteur ne sert de toute façon que le modèle sélectionné.
  const selection = state.settings?.selection;
  return selection?.kind === "embedded" ? selection.model || null : null;
}

function runningModelId(): string | null {
  return state.engine?.model_id || null;
}

function currentProviderLabel(): string {
  return state.settings?.label || state.settings?.provider || "Aucun fournisseur";
}

function setPanelStatus(message: string, kind: "ok" | "error" | "info" = "info"): void {
  const status = byId("nb-model-status-message");
  if (!status) return;
  status.textContent = message;
  status.dataset.kind = kind;
}

function installStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${ROOT_ID}, #${ROOT_ID} * { box-sizing: border-box; }
    #${ROOT_ID} {
      color: var(--foreground);
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: calc(var(--radius) * 1.6);
      padding: 20px;
      display: grid;
      gap: 18px;
      overflow: hidden;
    }
    #${ROOT_ID} .nb-m-header {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }
    #${ROOT_ID} .nb-m-icon {
      width: 36px;
      height: 36px;
      flex: 0 0 auto;
      display: grid;
      place-items: center;
      border-radius: 10px;
      color: var(--accent);
      background: color-mix(in oklab, var(--accent) 10%, transparent);
      border: 1px solid color-mix(in oklab, var(--accent) 25%, transparent);
    }
    #${ROOT_ID} .nb-m-icon svg { width: 18px; height: 18px; }
    #${ROOT_ID} .nb-m-heading { min-width: 0; flex: 1; }
    #${ROOT_ID} .nb-m-heading h3 { margin: 0; font-size: 14px; font-weight: 650; }
    #${ROOT_ID} .nb-m-heading p { margin: 2px 0 0; color: var(--muted-foreground); font-size: 12px; }
    #${ROOT_ID} .nb-m-badge {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      padding: 4px 9px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      white-space: nowrap;
      color: var(--muted-foreground);
      background: color-mix(in oklab, var(--muted-foreground) 10%, transparent);
      border: 1px solid var(--border);
    }
    #${ROOT_ID} .nb-m-badge[data-state="ready"] {
      color: color-mix(in oklab, var(--accent) 85%, white);
      background: color-mix(in oklab, var(--accent) 10%, transparent);
      border-color: color-mix(in oklab, var(--accent) 28%, transparent);
    }
    #${ROOT_ID} .nb-m-summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
    }
    #${ROOT_ID} .nb-m-summary-card {
      min-width: 0;
      padding: 10px 12px;
      border-radius: 11px;
      background: color-mix(in oklab, var(--background) 48%, transparent);
      border: 1px solid color-mix(in oklab, var(--border) 78%, transparent);
    }
    #${ROOT_ID} .nb-m-summary-card span {
      display: block;
      color: var(--muted-foreground);
      font-size: 10.5px;
      margin-bottom: 3px;
    }
    #${ROOT_ID} .nb-m-summary-card strong {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
      font-weight: 650;
    }
    #${ROOT_ID} .nb-m-tabs {
      display: flex;
      gap: 3px;
      overflow-x: auto;
      border-bottom: 1px solid var(--border);
      scrollbar-width: thin;
    }
    #${ROOT_ID} .nb-m-tab {
      appearance: none;
      border: 0;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      padding: 9px 12px;
      min-height: 38px;
      white-space: nowrap;
      cursor: pointer;
      color: var(--muted-foreground);
      background: transparent;
      font: inherit;
      font-size: 12px;
      font-weight: 650;
    }
    #${ROOT_ID} .nb-m-tab:hover { color: var(--foreground); }
    #${ROOT_ID} .nb-m-tab[aria-selected="true"] {
      color: var(--accent);
      border-bottom-color: var(--accent);
    }
    #${ROOT_ID} .nb-m-tab:focus-visible,
    #${ROOT_ID} button:focus-visible,
    #${ROOT_ID} [role="tabpanel"]:focus-visible {
      outline: 2px solid var(--ring);
      outline-offset: 2px;
    }
    #${ROOT_ID} .nb-m-count {
      display: inline-grid;
      place-items: center;
      min-width: 18px;
      height: 18px;
      padding: 0 5px;
      margin-left: 5px;
      border-radius: 999px;
      background: color-mix(in oklab, var(--muted-foreground) 14%, transparent);
      font-size: 10px;
    }
    #${ROOT_ID} .nb-m-panel[hidden] { display: none; }
    #${ROOT_ID} .nb-m-panel:focus-visible { border-radius: 10px; }
    #${ROOT_ID} .nb-m-hardware {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      margin-bottom: 12px;
    }
    #${ROOT_ID} .nb-m-chip {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      padding: 4px 9px;
      border-radius: 999px;
      color: var(--muted-foreground);
      background: color-mix(in oklab, var(--background) 45%, transparent);
      border: 1px solid var(--border);
      font-size: 10.5px;
    }
    #${ROOT_ID} .nb-m-chip strong { color: var(--foreground); font-weight: 650; }
    #${ROOT_ID} .nb-m-list { display: grid; gap: 9px; }
    #${ROOT_ID} .nb-m-model-card {
      min-width: 0;
      padding: 14px;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: color-mix(in oklab, var(--background) 38%, transparent);
    }
    #${ROOT_ID} .nb-m-model-card.is-recommended {
      border-color: color-mix(in oklab, var(--accent) 35%, var(--border));
    }
    #${ROOT_ID} .nb-m-model-card.is-selected {
      border-color: color-mix(in oklab, var(--accent) 60%, var(--border));
      box-shadow: inset 3px 0 0 var(--accent);
    }
    /* Un seul modèle actif : les autres sont visiblement désélectionnés. */
    #${ROOT_ID} .nb-m-model-card.is-inactive { opacity: .62; }
    #${ROOT_ID} .nb-m-model-card.is-inactive:hover { opacity: .82; }
    #${ROOT_ID} .nb-m-model-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    #${ROOT_ID} .nb-m-model-title { min-width: 0; }
    #${ROOT_ID} .nb-m-model-title strong { display: block; font-size: 13.5px; }
    #${ROOT_ID} .nb-m-model-title small {
      display: block;
      color: var(--muted-foreground);
      margin-top: 2px;
      font-size: 10.5px;
    }
    #${ROOT_ID} .nb-m-actions { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
    #${ROOT_ID} .nb-m-badges { display: flex; flex-wrap: wrap; gap: 6px; margin: 9px 0 7px; }
    #${ROOT_ID} .nb-m-tag {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      padding: 2px 7px;
      border-radius: 6px;
      color: var(--muted-foreground);
      background: color-mix(in oklab, var(--muted-foreground) 9%, transparent);
      font-size: 10px;
    }
    #${ROOT_ID} .nb-m-tag[data-tone="accent"] {
      color: color-mix(in oklab, var(--accent) 86%, white);
      background: color-mix(in oklab, var(--accent) 10%, transparent);
    }
    #${ROOT_ID} .nb-m-tag[data-tone="warn"] {
      color: #f6ad72;
      background: color-mix(in oklab, #f6ad72 10%, transparent);
    }
    #${ROOT_ID} .nb-m-notes { margin: 0; color: var(--muted-foreground); font-size: 11.5px; }
    #${ROOT_ID} .nb-m-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      margin-top: 11px;
    }
    #${ROOT_ID} .nb-m-meta > small { color: var(--muted-foreground); font-size: 10.5px; }
    #${ROOT_ID} .nb-m-button {
      appearance: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      min-height: 32px;
      padding: 6px 10px;
      border-radius: 8px;
      border: 1px solid var(--border);
      color: var(--foreground);
      background: color-mix(in oklab, var(--surface-hover) 82%, transparent);
      font: inherit;
      font-size: 11.5px;
      font-weight: 650;
      cursor: pointer;
    }
    #${ROOT_ID} .nb-m-button:hover:not(:disabled) {
      background: var(--surface-hover);
      border-color: color-mix(in oklab, var(--foreground) 20%, var(--border));
    }
    #${ROOT_ID} .nb-m-button[data-variant="primary"] {
      color: var(--primary-foreground);
      background: var(--primary);
      border-color: var(--primary);
    }
    #${ROOT_ID} .nb-m-button[data-variant="danger"] {
      color: #fca5a5;
      background: color-mix(in oklab, #ef4444 10%, transparent);
      border-color: color-mix(in oklab, #ef4444 30%, var(--border));
    }
    #${ROOT_ID} .nb-m-button:disabled { opacity: .48; cursor: not-allowed; }
    #${ROOT_ID} .nb-m-progress {
      height: 5px;
      margin-top: 11px;
      overflow: hidden;
      border-radius: 999px;
      background: color-mix(in oklab, var(--muted-foreground) 14%, transparent);
      display: none;
    }
    #${ROOT_ID} .nb-m-progress[data-visible="true"] { display: block; }
    #${ROOT_ID} .nb-m-progress span {
      display: block;
      height: 100%;
      width: 0;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--primary), var(--accent));
      transition: width .2s ease;
    }
    #${ROOT_ID} .nb-m-progress-label {
      display: none;
      margin-top: 5px;
      color: var(--muted-foreground);
      font-size: 10.5px;
      text-align: right;
    }
    #${ROOT_ID} .nb-m-progress-label[data-visible="true"] { display: block; }
    #${ROOT_ID} .nb-m-empty {
      padding: 24px 14px;
      text-align: center;
      border: 1px dashed var(--border);
      border-radius: 12px;
      color: var(--muted-foreground);
      font-size: 12px;
    }
    #${ROOT_ID} .nb-m-active-grid { display: grid; gap: 9px; }
    #${ROOT_ID} .nb-m-active-card {
      padding: 13px 14px;
      border-radius: 11px;
      border: 1px solid var(--border);
      background: color-mix(in oklab, var(--background) 38%, transparent);
    }
    #${ROOT_ID} .nb-m-active-card header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      margin-bottom: 7px;
    }
    #${ROOT_ID} .nb-m-active-card header strong { font-size: 12.5px; }
    #${ROOT_ID} .nb-m-active-card p { margin: 0; color: var(--muted-foreground); font-size: 11.5px; }
    #${ROOT_ID} .nb-m-status-message {
      min-height: 20px;
      color: var(--muted-foreground);
      font-size: 11.5px;
    }
    #${ROOT_ID} .nb-m-status-message[data-kind="ok"] { color: color-mix(in oklab, var(--accent) 84%, white); }
    #${ROOT_ID} .nb-m-status-message[data-kind="error"] { color: #fca5a5; }
    #${ROOT_ID} .nb-m-hub-row {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    #${ROOT_ID} .nb-m-hint {
      margin: 0;
      color: var(--muted-foreground);
      font-size: 11.5px;
    }
    /* Modal « Parcourir Hugging Face » : voile + carte, tout est scope. */
    #${ROOT_ID} .nb-m-modal {
      position: fixed;
      inset: 0;
      z-index: 60;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: color-mix(in oklab, black 62%, transparent);
      backdrop-filter: blur(2px);
    }
    #${ROOT_ID} .nb-m-modal[hidden] { display: none; }
    #${ROOT_ID} .nb-m-modal-card {
      width: min(720px, 100%);
      max-height: min(80vh, 720px);
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 16px 18px;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: var(--surface);
      box-shadow: 0 24px 60px rgba(0, 0, 0, .5);
    }
    #${ROOT_ID} .nb-m-modal-card > header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    #${ROOT_ID} .nb-m-modal-card > header strong { font-size: 13px; }
    #${ROOT_ID} .nb-m-hub-results {
      overflow-y: auto;
      display: grid;
      gap: 9px;
      min-height: 80px;
    }
    #${ROOT_ID} .nb-m-input {
      width: 100%;
      height: 38px;
      padding: 0 12px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: color-mix(in oklab, var(--background) 55%, transparent);
      color: var(--foreground);
      font: inherit;
      font-size: 12.5px;
      outline: none;
    }
    #${ROOT_ID} .nb-m-input:focus-visible {
      outline: 2px solid var(--ring);
      outline-offset: 1px;
    }
    #${ROOT_ID} .nb-m-hub-files { margin-top: 8px; display: grid; gap: 6px; }
    #${ROOT_ID} .nb-m-hub-file {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      padding: 7px 9px;
      border-radius: 9px;
      border: 1px solid color-mix(in oklab, var(--border) 80%, transparent);
      background: color-mix(in oklab, var(--background) 34%, transparent);
      font-size: 11.5px;
    }
    #${ROOT_ID} .nb-m-hub-file code {
      font-size: 11px;
      overflow-wrap: anywhere;
    }
    @media (max-width: 720px) {
      #${ROOT_ID} { padding: 16px; }
      #${ROOT_ID} .nb-m-header { align-items: flex-start; flex-wrap: wrap; }
      #${ROOT_ID} .nb-m-badge { margin-left: 48px; }
      #${ROOT_ID} .nb-m-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 480px) {
      #${ROOT_ID} .nb-m-summary { grid-template-columns: 1fr; }
    }
    @media (prefers-reduced-motion: reduce) {
      #${ROOT_ID} .nb-m-progress span { transition: none; }
    }
  `;
  document.head.appendChild(style);
}

function createPanel(): HTMLElement {
  const panel = document.createElement("section");
  panel.id = ROOT_ID;
  panel.setAttribute("aria-labelledby", "nb-model-manager-title");
  panel.innerHTML = `
    <header class="nb-m-header">
      <span class="nb-m-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3v3"></path><path d="M12 18v3"></path><path d="M3 12h3"></path><path d="M18 12h3"></path>
          <rect x="6" y="6" width="12" height="12" rx="3"></rect>
          <path d="M9.5 10.5v3l2.5 1.5 2.5-1.5v-3l-2.5-1.5z"></path>
        </svg>
      </span>
      <div class="nb-m-heading">
        <h3 id="nb-model-manager-title">Modèles IA locaux</h3>
        <p>Téléchargez plusieurs modèles, gardez-les sur cet appareil et choisissez-en un seul comme modèle IA local.</p>
      </div>
      <span id="nb-model-manager-badge" class="nb-m-badge">Analyse…</span>
    </header>

    <div class="nb-m-summary" aria-label="Résumé des modèles locaux">
      <div class="nb-m-summary-card"><span>Modèles téléchargés</span><strong id="nb-model-local-count">—</strong></div>
      <div class="nb-m-summary-card"><span>Modèle sélectionné</span><strong id="nb-model-selected-name">—</strong></div>
      <div class="nb-m-summary-card"><span>Fournisseur actif</span><strong id="nb-model-active-provider">—</strong></div>
      <div class="nb-m-summary-card"><span>Moteur local</span><strong id="nb-model-engine-state">—</strong></div>
    </div>

    <nav class="nb-m-tabs" role="tablist" aria-label="Gestion des modèles IA">
      <button id="nb-model-tab-download" class="nb-m-tab" type="button" role="tab" data-model-tab="download" aria-controls="nb-model-panel-download" aria-selected="true" tabindex="0">Télécharger</button>
      <button id="nb-model-tab-installed" class="nb-m-tab" type="button" role="tab" data-model-tab="installed" aria-controls="nb-model-panel-installed" aria-selected="false" tabindex="-1">Mes modèles <span id="nb-model-installed-tab-count" class="nb-m-count">0</span></button>
      <button id="nb-model-tab-active" class="nb-m-tab" type="button" role="tab" data-model-tab="active" aria-controls="nb-model-panel-active" aria-selected="false" tabindex="-1">Modèle actif</button>
    </nav>

    <section id="nb-model-panel-download" class="nb-m-panel" role="tabpanel" aria-labelledby="nb-model-tab-download" tabindex="0">
      <div class="nb-m-hub-row">
        <button class="nb-m-button" type="button" data-model-action="hub-open">Parcourir Hugging Face</button>
        <p class="nb-m-hint">Chercher un modèle GGUF hors catalogue (recommandations ci-dessous).</p>
      </div>
      <div id="nb-model-hardware" class="nb-m-hardware"><span class="nb-m-chip">Analyse du matériel…</span></div>
      <div id="nb-model-catalog" class="nb-m-list"><div class="nb-m-empty">Chargement des recommandations…</div></div>
    </section>

    <div id="nb-model-hub" class="nb-m-modal" role="dialog" aria-modal="true" aria-labelledby="nb-model-hub-title" hidden>
      <div class="nb-m-modal-card">
        <header>
          <strong id="nb-model-hub-title">Parcourir Hugging Face</strong>
          <button class="nb-m-button" type="button" data-model-action="hub-close">Fermer</button>
        </header>
        <input id="nb-model-hub-query" class="nb-m-input" type="search" autocomplete="off"
               placeholder="ex. qwen3 gguf, granite gguf…" aria-label="Rechercher un modèle sur Hugging Face" />
        <p id="nb-model-hub-status" class="nb-m-hint" role="status" aria-live="polite"></p>
        <div id="nb-model-hub-results" class="nb-m-hub-results"></div>
      </div>
    </div>

    <section id="nb-model-panel-installed" class="nb-m-panel" role="tabpanel" aria-labelledby="nb-model-tab-installed" tabindex="0" hidden>
      <div id="nb-model-installed" class="nb-m-list"></div>
    </section>

    <section id="nb-model-panel-active" class="nb-m-panel" role="tabpanel" aria-labelledby="nb-model-tab-active" tabindex="0" hidden>
      <div id="nb-model-active" class="nb-m-active-grid"></div>
    </section>

    <div id="nb-model-status-message" class="nb-m-status-message" role="status" aria-live="polite"></div>
  `;
  return panel;
}

function selectTab(tab: "download" | "installed" | "active", focus = false): void {
  if (!root) return;
  state.activeTab = tab;
  const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-model-tab]"));
  for (const button of tabs) {
    const selected = button.dataset.modelTab === tab;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    const panel = byId(`nb-model-panel-${button.dataset.modelTab}`);
    if (panel) panel.hidden = !selected;
  }
  if (focus) byId<HTMLButtonElement>(`nb-model-tab-${tab}`)?.focus();
}

function renderSummary(): void {
  const localCount = Object.keys(state.downloaded).length;
  const selected = selectedModelId();
  const running = runningModelId();
  const localProvider = state.settings?.provider === "embedded";
  // « En marche » ne se déduit PAS de la présence d'un pid : llama-server est
  // lancé bien avant d'avoir chargé le modèle. Seul `ready` prouve qu'il répond.
  const engineState = state.engine?.state ?? "idle";
  const engineReady = engineState === "ready";
  const engineRunning = engineReady;
  // Modele choisi mais pas encore publie : ce n'est pas un echec, on attend.
  const waitingDownload = Boolean(state.engine?.waiting_for_download);
  const badge = byId("nb-model-manager-badge");

  if (badge) {
    if (engineRunning && localProvider && running === selected) {
      badge.textContent = "Modèle local utilisé";
      badge.dataset.state = "ready";
    } else if (waitingDownload) {
      badge.textContent = "Téléchargement du modèle…";
      badge.dataset.state = "ready";
    } else if (localProvider && engineState === "loading") {
      badge.textContent = "Chargement du modèle…";
      badge.dataset.state = "ready";
    } else if (localProvider && engineState === "error") {
      badge.textContent = "Chargement en échec";
      badge.dataset.state = "idle";
    } else if (selected && localProvider) {
      badge.textContent = "Modèle sélectionné";
      badge.dataset.state = "ready";
    } else if (selected) {
      // Un fournisseur externe est actif : le modèle local ne répond pas.
      badge.textContent = "Modèle local désactivé";
      badge.dataset.state = "idle";
    } else if (localCount > 0) {
      badge.textContent = localCount > 1 ? `${localCount} modèles locaux` : "1 modèle local";
      badge.dataset.state = "ready";
    } else {
      badge.textContent = "Aucun téléchargement";
      badge.dataset.state = "idle";
    }
  }

  const count = byId("nb-model-local-count");
  if (count) count.textContent = String(localCount);
  const tabCount = byId("nb-model-installed-tab-count");
  if (tabCount) tabCount.textContent = String(localCount);
  const selectedName = byId("nb-model-selected-name");
  if (selectedName) selectedName.textContent = selected || "Aucun";
  const provider = byId("nb-model-active-provider");
  if (provider) provider.textContent = currentProviderLabel();
  const engine = byId("nb-model-engine-state");
  if (engine) {
    engine.textContent = engineReady
      ? `En marche · ${running}`
      : waitingDownload
        ? "Téléchargement en cours"
        : engineState === "loading"
          ? `Chargement · ${state.engine?.model_id ?? ""}`.trim()
          : engineState === "error"
            ? "Échec du chargement"
            : "Arrêté";
  }
}

function renderHardware(): void {
  const target = byId("nb-model-hardware");
  if (!target) return;
  const recommendation = state.recommendation;
  if (!recommendation) {
    target.innerHTML = '<span class="nb-m-chip">Recommandations indisponibles</span>';
    return;
  }
  const { hardware } = recommendation;
  const gpu = hardware.gpu?.name
    ? `${hardware.gpu.name}${hardware.gpu.vram_gb ? ` · ${hardware.gpu.vram_gb.toFixed(1)} Go` : ""}`
    : "Calcul CPU";
  target.innerHTML = [
    `RAM <strong>${escapeHtml(hardware.ram_gb)} Go</strong>`,
    `GPU <strong>${escapeHtml(gpu)}</strong>`,
    `Budget IA <strong>${escapeHtml(recommendation.memory_budget_gb)} Go</strong>`,
    `Disque libre <strong>${escapeHtml(hardware.disk_free_gb)} Go</strong>`,
  ]
    .map((value) => `<span class="nb-m-chip">${value}</span>`)
    .join("");
}

const ACTIVE_DOWNLOAD_STATUSES = new Set<DownloadStatus>([
  "queued",
  "starting",
  "resolving",
  "downloading",
  "running",
]);

function isDownloading(modelId: string): boolean {
  const status = state.downloads.get(modelId)?.status;
  return status ? ACTIVE_DOWNLOAD_STATUSES.has(status) : false;
}

function isPaused(modelId: string): boolean {
  return state.downloads.get(modelId)?.status === "paused";
}

function downloadStatusLabel(status: DownloadStatus): string {
  const labels: Record<DownloadStatus, string> = {
    queued: "En file",
    starting: "Préparation",
    resolving: "Résolution",
    downloading: "Téléchargement",
    running: "Téléchargement",
    pausing: "Mise en pause",
    paused: "En pause",
    cancelling: "Annulation",
    cancelled: "Annulé",
    done: "Terminé",
    error: "Échec",
  };
  return labels[status];
}

function catalogAction(model: Recommendation, downloaded: DownloadedModel | undefined): string {
  const progress = state.downloads.get(model.id);
  const selected = selectedModelId() === model.id;
  if (progress && (isDownloading(model.id) || progress.status === "pausing")) {
    const busy = progress.status === "pausing" ? " disabled" : "";
    return `<button class="nb-m-button" type="button" data-model-action="pause-download" data-model-id="${escapeHtml(model.id)}" aria-label="Mettre ${escapeHtml(model.name)} en pause"${busy}>Pause</button>
      <button class="nb-m-button" type="button" data-variant="danger" data-model-action="cancel-download" data-model-id="${escapeHtml(model.id)}" aria-label="Annuler le téléchargement de ${escapeHtml(model.name)}"${busy}>Annuler</button>`;
  }
  if (progress?.status === "cancelling") {
    return '<button class="nb-m-button" type="button" data-variant="danger" disabled>Annulation…</button>';
  }
  if (isPaused(model.id)) {
    return `<button class="nb-m-button" type="button" data-variant="primary" data-model-action="resume-download" data-model-id="${escapeHtml(model.id)}" aria-label="Reprendre le téléchargement de ${escapeHtml(model.name)}">Reprendre</button>
      <button class="nb-m-button" type="button" data-variant="danger" data-model-action="cancel-download" data-model-id="${escapeHtml(model.id)}" aria-label="Annuler et supprimer le partiel de ${escapeHtml(model.name)}">Annuler</button>`;
  }
  if (downloaded) {
    return selected
      ? '<button class="nb-m-button" type="button" data-variant="primary" disabled>Sélectionné</button>'
      : `<button class="nb-m-button" type="button" data-model-action="select" data-model-id="${escapeHtml(model.id)}">Choisir ce modèle</button>`;
  }
  if (!model.downloadable) return '<button class="nb-m-button" type="button" disabled>Indisponible</button>';
  const requiredDisk = model.size_gb * 1.15;
  if (requiredDisk > (state.recommendation?.hardware.disk_free_gb || 0)) {
    return '<button class="nb-m-button" type="button" disabled>Espace disque insuffisant</button>';
  }
  const retrying = progress?.status === "error";
  const label = retrying ? "Réessayer" : "Télécharger";
  const cancel = retrying && progress?.job_id
    ? `<button class="nb-m-button" type="button" data-variant="danger" data-model-action="cancel-download" data-model-id="${escapeHtml(model.id)}">Supprimer le partiel</button>`
    : "";
  return `<button class="nb-m-button" type="button" data-variant="primary" data-model-action="download" data-model-id="${escapeHtml(model.id)}">${label} · ${escapeHtml(model.size_gb)} Go</button>${cancel}`;
}

function renderCatalog(): void {
  const target = byId("nb-model-catalog");
  if (!target) return;
  const recommendation = state.recommendation;
  if (!recommendation) {
    target.innerHTML = '<div class="nb-m-empty">Impossible de charger le catalogue. Le backend local est-il démarré ?</div>';
    return;
  }

  target.innerHTML = recommendation.models
    .map((model) => {
      const downloaded = state.downloaded[model.id];
      const progress = state.downloads.get(model.id);
      const isBest = recommendation.best === model.id;
      const memoryLabel = model.fits
        ? `Compatible · ${model.min_ram_gb} Go minimum`
        : `Nécessite environ ${model.min_ram_gb} Go de mémoire`;
      const progressValue = progress ? Math.max(0, Math.min(100, progress.pct || 0)) : 0;
      const progressVisible = Boolean(progress);
      const transfer = progress
        ? transferLabel(progress, model.dl_mb * 1024 ** 2)
        : "";
      return `<article class="nb-m-model-card ${isBest ? "is-recommended" : ""}">
        <div class="nb-m-model-head">
          <div class="nb-m-model-title">
            <strong>${escapeHtml(model.name)}</strong>
            <small>${escapeHtml(model.family || model.id)}</small>
          </div>
          <div class="nb-m-actions">${catalogAction(model, downloaded)}</div>
        </div>
        <div class="nb-m-badges">
          ${isBest ? '<span class="nb-m-tag" data-tone="accent">Recommandé pour cette machine</span>' : ""}
          <span class="nb-m-tag">${escapeHtml(model.size_gb)} Go</span>
          <span class="nb-m-tag">Qualité ${escapeHtml(model.quality)}/5</span>
          <span class="nb-m-tag">Français ${escapeHtml(model.french)}/5</span>
          <span class="nb-m-tag">Outils : ${escapeHtml(model.tool_calling)}</span>
          <span class="nb-m-tag" data-tone="${model.fits ? "accent" : "warn"}">${escapeHtml(memoryLabel)}</span>
        </div>
        <p class="nb-m-notes">${escapeHtml(model.notes)}</p>
        <div class="nb-m-meta">
          <small>Licence ${escapeHtml(model.license)}</small>
          ${downloaded ? '<small>Déjà téléchargé sur cet appareil</small>' : ""}
        </div>
        <div id="nb-progress-${escapeHtml(model.id)}" class="nb-m-progress" data-visible="${progressVisible}"><span style="width:${progressValue}%"></span></div>
        <div id="nb-progress-label-${escapeHtml(model.id)}" class="nb-m-progress-label" data-visible="${progressVisible}">${escapeHtml(progress?.error || transfer)}</div>
      </article>`;
    })
    .join("");
  renderHardware();
}

function renderInstalled(): void {
  const target = byId("nb-model-installed");
  if (!target) return;
  const entries = Object.values(state.downloaded);
  // Telechargements d'un modele HORS catalogue (Hub) encore en cours ou
  // interrompus : ils n'ont pas de carte dans l'onglet « Telecharger », et
  // doivent rester joignables ici — y compris apres un redemarrage, ou le job
  // revient en pause avec son fragment.
  const catalogIds = new Set((state.recommendation?.models || []).map((model) => model.id));
  const pending = [...state.downloads.entries()].filter(
    ([id, job]) => !state.downloaded[id] && !catalogIds.has(id)
      && job.status !== "cancelled" && job.status !== "done",
  );
  const pendingHtml = pending
    .map(([id, job]) => {
      const resumable = job.status === "paused" || job.status === "error";
      const actions = [
        resumable
          ? `<button class="nb-m-button" type="button" data-variant="primary" data-model-action="hub-resume" data-hub-model="${escapeHtml(id)}">Reprendre</button>`
          : "",
        `<button class="nb-m-button" type="button" data-variant="danger" data-model-action="hub-cancel" data-hub-model="${escapeHtml(id)}">Annuler</button>`,
      ].join("");
      return `<article class="nb-m-model-card">
        <div class="nb-m-model-head">
          <div class="nb-m-model-title">
            <strong>${escapeHtml(id.split("/").pop() || id)}</strong>
            <small>${escapeHtml(id)}</small>
          </div>
          <div class="nb-m-actions">${actions}</div>
        </div>
        <div class="nb-m-badges">
          <span class="nb-m-tag" data-tone="${resumable ? "warn" : ""}">${escapeHtml(downloadStatusLabel(job.status))}</span>
          <span class="nb-m-tag">${escapeHtml(formatBytes(job.received))} / ${escapeHtml(formatBytes(job.total))}</span>
        </div>
        <div class="nb-m-progress" data-visible="true"><span style="width:${Math.max(0, Math.min(100, job.pct || 0))}%"></span></div>
        <div class="nb-m-progress-label" data-visible="true">${escapeHtml(job.error || transferLabel(job))}</div>
      </article>`;
    })
    .join("");
  if (entries.length === 0 && !pendingHtml) {
    target.innerHTML = '<div class="nb-m-empty">Aucun modèle téléchargé. Ouvrez « Télécharger » pour installer le premier modèle.</div>';
    return;
  }
  const selected = selectedModelId();
  const engineLoading = state.engine?.state === "loading";
  const engineReady = state.engine?.state === "ready";
  entries.sort((left, right) => {
    if (left.model_id === selected) return -1;
    if (right.model_id === selected) return 1;
    return right.downloaded_at.localeCompare(left.downloaded_at);
  });
  const catalogById = new Map((state.recommendation?.models || []).map((model) => [model.id, model]));

  target.innerHTML = pendingHtml + entries
    .map((model) => {
      const catalog = catalogById.get(model.model_id);
      const isSelected = selected === model.model_id;
      const engineLoaded = engineReady && runningModelId() === model.model_id;
      const action = isSelected
        ? '<button class="nb-m-button" type="button" data-variant="primary" aria-pressed="true" disabled>Sélectionné</button>'
        : `<button class="nb-m-button" type="button" aria-pressed="false" data-model-action="select" data-model-id="${escapeHtml(model.model_id)}">Choisir et charger</button>`;
      // Un seul modèle actif : les autres sont explicitement désélectionnés.
      const memoryTag = isSelected
        ? engineLoaded
          ? '<span class="nb-m-tag" data-tone="accent">Chargé en mémoire</span>'
          : engineLoading
            ? '<span class="nb-m-tag" data-tone="warn">Chargement…</span>'
            : '<span class="nb-m-tag" data-tone="accent">Sélectionné</span>'
        : '<span class="nb-m-tag">Non sélectionné</span>';
      return `<article class="nb-m-model-card ${isSelected ? "is-selected" : "is-inactive"}">
        <div class="nb-m-model-head">
          <div class="nb-m-model-title">
            <strong>${escapeHtml(model.name)}</strong>
            <small>${escapeHtml(model.model_id)} · ${escapeHtml(formatDate(model.downloaded_at))}</small>
          </div>
          <div class="nb-m-actions">${action}
            <button class="nb-m-button" type="button" data-variant="danger" data-model-action="delete-model" data-model-id="${escapeHtml(model.model_id)}">Supprimer</button>
          </div>
        </div>
        <div class="nb-m-badges">
          <span class="nb-m-tag">${escapeHtml(formatBytes(model.size_bytes || (catalog?.size_gb || 0) * 1024 ** 3))}</span>
          ${memoryTag}
        </div>
      </article>`;
    })
    .join("");
}

function renderActive(): void {
  const target = byId("nb-model-active");
  if (!target) return;
  const localCount = Object.keys(state.downloaded).length;
  const engine = state.engine;
  const selected = selectedModelId();
  const running = runningModelId();
  const selectedDownloaded = selected ? state.downloaded[selected] : undefined;
  const providerIsLocal = state.settings?.provider === "embedded";

  // Un seul modèle actif : tant qu'un fournisseur externe est actif, le modèle
  // local est en veille. On peut toujours le désigner (bouton « Choisir ce
  // modèle ») — cela bascule le fournisseur — mais on ne charge pas en mémoire
  // un modèle qui ne répond pas.
  const selectionTag = providerIsLocal
    ? `<span class="nb-m-tag" data-tone="accent">${escapeHtml(selectedDownloaded?.name || selected || "")}</span>`
    : `<span class="nb-m-tag">Aucun</span>`;
  const engineState = engine?.state ?? "idle";
  const engineLoading = engineState === "loading";
  const engineReady = engineState === "ready";
  const selectionText = !providerIsLocal
    ? `Les fournisseurs externes sont actifs : le modèle local est désactivé. Choisissez un modèle pour le remplacer.`
    : engineLoading
      ? `Chargement de ${escapeHtml(selected || "ce modèle")}… le moteur sera prêt dans un instant.`
      : engineReady
        ? "Ce modèle est chargé et prêt à répondre."
        : engineState === "error"
          ? `Le chargement a échoué : ${escapeHtml(engine?.error || "erreur inconnue")}`
          : "Ce modèle est choisi ; son chargement n’a pas encore démarré.";
  const selectionAction = !providerIsLocal
    ? `<button class="nb-m-button" type="button" data-model-action="open-installed">Voir mes modèles</button>`
    : engineReady
      ? '<button class="nb-m-button" type="button" data-variant="primary" disabled>Modèle actif</button>'
      : engineLoading
        ? '<button class="nb-m-button" type="button" disabled>Chargement…</button>'
        : '<button class="nb-m-button" type="button" data-variant="primary" data-model-action="use-selected">Réessayer le chargement</button>';

  const selectionCard = providerIsLocal && selectedDownloaded
    ? `<div class="nb-m-active-card">
        <header><strong>Modèle local actif</strong>${selectionTag}</header>
        <p>${selectionText}</p>
        <div class="nb-m-actions" style="margin-top:10px">${selectionAction}</div>
      </div>`
    : `<div class="nb-m-active-card">
        <header><strong>Modèle local actif</strong><span class="nb-m-tag">Aucun</span></header>
        <p>${localCount > 0 ? selectionText : "Téléchargez d’abord un modèle compatible avec votre machine."}</p>
        <div class="nb-m-actions" style="margin-top:10px"><button class="nb-m-button" type="button" data-model-action="open-${localCount > 0 ? "installed" : "download"}">${localCount > 0 ? "Voir mes modèles" : "Voir les modèles"}</button></div>
      </div>`;

  const engineTone = engineLoading ? "warn" : engineReady ? "accent" : engineState === "error" ? "warn" : "";
  const engineLabel = engineLoading ? "Chargement…" : engineReady ? "En marche" : engineState === "error" ? "Échec" : "Arrêté";
  const engineCard = engine?.model_id
    ? `<div class="nb-m-active-card">
        <header><strong>Moteur NeuroBeats local</strong><span class="nb-m-tag" data-tone="${engineTone}">${engineLabel}</span></header>
        <p>${engineLoading ? "Chargement" : "Modèle"} ${escapeHtml(engine.model_id)} · PID ${escapeHtml(engine.pid ?? "—")} · port ${escapeHtml(engine.port ?? "—")}</p>
        <div class="nb-m-actions" style="margin-top:10px"><button class="nb-m-button" type="button" data-variant="danger" data-model-action="stop-engine">Arrêter le moteur</button></div>
      </div>`
    : `<div class="nb-m-active-card">
        <header><strong>Moteur NeuroBeats local</strong><span class="nb-m-tag">Arrêté</span></header>
        <p>Le moteur se charge automatiquement quand un modèle local est choisi.</p>
      </div>`;

  const providerDescription = providerIsLocal
    ? engineReady
      ? `Le chat utilise le modèle local ${escapeHtml(selected || "sélectionné")}.`
      : engineLoading
        ? "Le modèle local se charge : le chat sera prêt dès qu’il répond."
        : "Le modèle local est choisi ; en cas d’échec, relancez son chargement ici."
    : "Un fournisseur externe est actif : le modèle local est désactivé et n’est pas utilisé.";

  target.innerHTML = `
    <div class="nb-m-active-card">
      <header><strong>Fournisseur de l’application</strong><span class="nb-m-tag" data-tone="${providerIsLocal ? "accent" : "warn"}">${escapeHtml(currentProviderLabel())}</span></header>
      <p>${providerDescription}</p>
      <div class="nb-m-actions" style="margin-top:10px"><button class="nb-m-button" type="button" data-model-action="scroll-provider">Configurer un fournisseur</button></div>
    </div>
    ${selectionCard}
    ${engineCard}
  `;
}

// ---------------------------------------------------- navigateur Hugging Face
// Le catalogue cure reste l'affichage par defaut ; ce modal ouvre la recherche
// au Hub pour un modele hors catalogue. Le choix d'un fichier cree un job
// ordinaire (`repo` + `filename`) : la suite du flux est inchangee.
let hubDebounce: number | null = null;

function renderHub(): void {
  const modal = byId("nb-model-hub");
  if (!modal) return;
  modal.hidden = !state.hubOpen;
  if (!state.hubOpen) return;
  const status = byId("nb-model-hub-status");
  const results = byId("nb-model-hub-results");
  if (status) {
    if (state.hubBusy) status.textContent = "Interrogation de Hugging Face…";
    else if (state.hubError) status.textContent = state.hubError;
    else if (state.hubRepos) status.textContent = `${state.hubRepos.length} dépôt(s) trouvé(s).`;
    else status.textContent = "Cherchez un modèle GGUF (ex. « qwen3 gguf »).";
  }
  if (!results) return;
  if (state.hubBusy && !state.hubRepos && !state.hubRepo) {
    results.innerHTML = '<div class="nb-m-empty">Recherche…</div>';
    return;
  }
  if (state.hubError && !state.hubRepos) {
    results.innerHTML = `<div class="nb-m-empty">${escapeHtml(state.hubError)}</div>`;
    return;
  }
  if (!state.hubRepos || state.hubRepos.length === 0) {
    results.innerHTML = state.hubRepos
      ? '<div class="nb-m-empty">Aucun dépôt trouvé.</div>'
      : '<div class="nb-m-empty">Saisissez une recherche pour explorer le Hub.</div>';
    return;
  }
  results.innerHTML = state.hubRepos
    .map((repo) => {
      const open = state.hubRepo === repo.repo_id;
      const files = open ? renderHubFiles(repo.repo_id) : "";
      const info = `${repo.downloads.toLocaleString("fr-FR")} téléchargements · ${repo.likes} ★`;
      return `<article class="nb-m-model-card ${open ? "is-selected" : ""}">
        <div class="nb-m-model-head">
          <div class="nb-m-model-title">
            <strong>${escapeHtml(repo.repo_id)}</strong>
            <small>${escapeHtml(info)}</small>
          </div>
          <div class="nb-m-actions">
            <button class="nb-m-button" type="button" data-model-action="hub-repo" data-hub-repo="${escapeHtml(repo.repo_id)}">${open ? "Masquer" : "Voir les fichiers"}</button>
          </div>
        </div>
        <div class="nb-m-badges">
          ${repo.gated ? '<span class="nb-m-tag" data-tone="warn">Accès restreint</span>' : ""}
          ${repo.updated ? `<span class="nb-m-tag">Mis à jour ${escapeHtml(repo.updated)}</span>` : ""}
        </div>
        ${files}
      </article>`;
    })
    .join("");
}

/** Fichiers GGUF du depot ouvert : quantification, taille, verdict memoire. */
function renderHubFiles(repoId: string): string {
  if (state.hubBusy) return '<div class="nb-m-hub-files"><span class="nb-m-hint">Chargement des fichiers…</span></div>';
  if (state.hubError) return `<div class="nb-m-hub-files"><span class="nb-m-hint">${escapeHtml(state.hubError)}</span></div>`;
  const files = state.hubFiles || [];
  if (files.length === 0) {
    return '<div class="nb-m-hub-files"><span class="nb-m-hint">Aucun fichier GGUF dans ce dépôt.</span></div>';
  }
  return `<div class="nb-m-hub-files">${files
    .map((file) => {
      const modelId = `${repoId}/${file.filename}`;
      const progress = state.downloads.get(modelId);
      const tone = file.fits === true ? "accent" : file.fits === false ? "warn" : "";
      // Sous Q4_K_M, la fiabilite des appels d'outils chute : on previent sans
      // interdire (l'utilisateur choisit).
      const lowQuant = file.quant && /^(IQ?1|Q2)/i.test(file.quant);
      const downloadButton = `<button class="nb-m-button" type="button" data-variant="${file.fits === false ? "danger" : "primary"}" data-model-action="hub-download" data-hub-repo="${escapeHtml(repoId)}" data-hub-file="${escapeHtml(file.filename)}" data-hub-size="${file.size_bytes}">${file.fits === false ? "Télécharger quand même" : "Télécharger"}</button>`;
      // Une partie de GGUF decoupe ne se charge pas seule : on ne propose pas un
      // telechargement qui donnerait un modele casse.
      let action = file.split
        ? '<span class="nb-m-tag" data-tone="warn">Découpé : télécharger le dépôt complet</span>'
        : downloadButton;
      if (progress) {
        const state_label = `<span class="nb-m-hint">${escapeHtml(downloadStatusLabel(progress.status))}</span>`;
        const model = escapeHtml(modelId);
        const cancel = `<button class="nb-m-button" type="button" data-variant="danger" data-model-action="hub-cancel" data-hub-model="${model}">Annuler</button>`;
        if (isDownloading(modelId) || progress.status === "pausing" || progress.status === "cancelling") {
          action = `${state_label}${cancel}`;
        } else if (progress.status === "paused" || progress.status === "error") {
          // Une coupure reseau ou une fermeture d'app laisse le fragment : on
          // reprend ici, sans retelecharger depuis zero.
          action = `${state_label}<button class="nb-m-button" type="button" data-variant="primary" data-model-action="hub-resume" data-hub-model="${model}">Reprendre</button>${cancel}`;
        } else if (progress.status === "done") {
          action = '<span class="nb-m-tag" data-tone="accent">Téléchargé</span>';
        } else {
          action = `${state_label}${downloadButton}`;
        }
      }
      return `<div class="nb-m-hub-file">
        <code>${escapeHtml(file.filename)}</code>
        ${file.quant ? `<span class="nb-m-tag">${escapeHtml(file.quant)}</span>` : ""}
        <span class="nb-m-tag" data-tone="${tone}">${escapeHtml(file.hint)}</span>
        ${lowQuant ? '<span class="nb-m-tag" data-tone="warn">Quant. faible : outils peu fiables</span>' : ""}
        <span class="nb-m-actions" style="margin-left:auto">${action}</span>
      </div>`;
    })
    .join("")}</div>`;
}

function openHub(): void {
  state.hubOpen = true;
  state.hubError = "";
  renderHub();
  const query = byId<HTMLInputElement>("nb-model-hub-query");
  if (query) {
    query.value = state.hubQuery;
    query.focus();
  }
}

function closeHub(): void {
  state.hubOpen = false;
  renderHub();
}

async function searchHub(query: string): Promise<void> {
  const wanted = query.trim();
  state.hubQuery = wanted;
  state.hubRepo = "";
  state.hubFiles = null;
  if (!wanted) {
    state.hubRepos = null;
    state.hubError = "";
    renderHub();
    return;
  }
  state.hubBusy = true;
  state.hubError = "";
  renderHub();
  try {
    const data = await requestJson<{ models: HubRepo[] }>(
      `/api/profile/ai/models/hub?q=${encodeURIComponent(wanted)}&limit=20`,
    );
    state.hubRepos = data.models || [];
  } catch (error) {
    state.hubRepos = null;
    state.hubError = error instanceof Error ? error.message : "Recherche impossible.";
  } finally {
    state.hubBusy = false;
    renderHub();
  }
}

async function openHubRepo(repoId: string): Promise<void> {
  if (state.hubRepo === repoId) {
    state.hubRepo = "";
    state.hubFiles = null;
    renderHub();
    return;
  }
  state.hubRepo = repoId;
  state.hubFiles = null;
  state.hubBusy = true;
  state.hubError = "";
  renderHub();
  try {
    const data = await requestJson<{ files: HubFile[] }>(
      `/api/profile/ai/models/hub/files?repo=${encodeURIComponent(repoId)}`,
    );
    state.hubFiles = data.files || [];
  } catch (error) {
    state.hubError = error instanceof Error ? error.message : "Dépôt illisible.";
  } finally {
    state.hubBusy = false;
    renderHub();
  }
}

async function downloadFromHub(
  repoId: string,
  filename: string,
  sizeBytes: number,
  button: HTMLButtonElement,
): Promise<void> {
  const modelId = `${repoId}/${filename}`;
  if (isDownloading(modelId)) return;
  button.disabled = true;
  setPanelStatus(`Téléchargement de ${filename}…`);
  let progress = updateDownloadProgress(modelId, {
    model_id: modelId, status: "starting",
    received: 0, total: sizeBytes, pct: 0,
  });
  try {
    const response = await requestJson<{ job_id: string }>("/api/profile/ai/models/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: repoId, filename, size_bytes: sizeBytes }),
    });
    progress = updateDownloadProgress(modelId, {
      model_id: modelId, job_id: response.job_id, status: "resolving",
    });
    ensureDownloadWatcher(progress);
    setPanelStatus(`${filename} : téléchargement lancé (suivi dans « Mes modèles »).`, "ok");
  } catch (error) {
    state.downloads.delete(modelId);
    if (button.isConnected) button.disabled = false;
    setPanelStatus(error instanceof Error ? error.message : "Téléchargement impossible.", "error");
  }
  renderHub();
}

function renderAll(): void {
  renderSummary();
  renderCatalog();
  renderInstalled();
  renderActive();
}

let enginePoll: number | null = null;

/**
 * Suit le chargement du modèle actif : tant que le moteur charge, on rafraîchit
 * souvent (l'utilisateur doit voir que ça progresse), sinon on s'arrête.
 */
function scheduleEnginePoll(): void {
  if (enginePoll !== null) return;
  enginePoll = window.setInterval(() => {
    void refreshCore();
    if (state.engine?.state !== "loading") {
      if (enginePoll !== null) window.clearInterval(enginePoll);
      enginePoll = null;
      const loading = selectedModelId();
      if (state.engine?.state === "ready") {
        setPanelStatus(`Modèle local ${loading ?? ""} chargé et actif.`, "ok");
      } else if (state.engine?.state === "error") {
        setPanelStatus(state.engine.error || "Le chargement du modèle a échoué.", "error");
      }
    }
  }, 1000);
}

async function refreshCore(): Promise<void> {
  const [settingsResult, downloadedResult, engineResult, downloadsResult] = await Promise.allSettled([
    requestJson<AiSettings>("/api/profile/ai"),
    requestJson<{ models: Record<string, DownloadedModel>; files: string[] }>("/api/profile/ai/models"),
    requestJson<EmbeddedState>("/api/profile/ai/embedded"),
    requestJson<{ jobs: DownloadJob[] } | DownloadJob[]>("/api/profile/ai/models/downloads"),
  ]);
  if (settingsResult.status === "fulfilled") state.settings = settingsResult.value;
  if (downloadedResult.status === "fulfilled") {
    state.downloaded = downloadedResult.value.models || {};
    state.files = downloadedResult.value.files || [];
  }
  if (engineResult.status === "fulfilled") {
    state.engine = engineResult.value && Object.keys(engineResult.value).length > 0 ? engineResult.value : null;
  }
  if (downloadsResult.status === "fulfilled") {
    const response = downloadsResult.value;
    applyDownloadJobs(Array.isArray(response) ? response : response.jobs || []);
  }
  renderSummary();
  renderInstalled();
  renderActive();
}

async function refreshRecommendation(): Promise<void> {
  state.recommendation = await requestJson<RecommendationResponse>("/api/profile/ai/recommend");
  renderCatalog();
}

async function refreshAll(): Promise<void> {
  if (fullRefresh) return fullRefresh;
  fullRefresh = (async () => {
    setPanelStatus("Analyse de la machine et des modèles locaux…");
    try {
      await Promise.all([refreshCore(), refreshRecommendation()]);
      setPanelStatus("Gestion des modèles locaux prête.", "ok");
    } catch (error) {
      setPanelStatus(error instanceof Error ? error.message : "Impossible de charger les modèles.", "error");
    } finally {
      fullRefresh = null;
    }
  })();
  return fullRefresh;
}

function progressFromJob(job: DownloadJob): DownloadProgress {
  return {
    job_id: job.job_id,
    model_id: job.model_id,
    status: job.status,
    received: Number(job.received) || 0,
    total: Number(job.total) || 0,
    pct: Number(job.pct) || 0,
    speed_mbps: Number(job.speed_mbps) || 0,
    error: job.error,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

function mergeDownloadProgress(
  modelId: string,
  patch: Partial<DownloadProgress>,
): DownloadProgress {
  const previous = state.downloads.get(modelId);
  return {
    ...previous,
    ...patch,
    model_id: patch.model_id || previous?.model_id || modelId,
    job_id: patch.job_id || previous?.job_id,
    status: patch.status || previous?.status || "queued",
    received: Number(patch.received ?? previous?.received) || 0,
    total: Number(patch.total ?? previous?.total) || 0,
    pct: Number(patch.pct ?? previous?.pct) || 0,
    speed_mbps: Number(patch.speed_mbps ?? previous?.speed_mbps) || 0,
  };
}

function updateDownloadProgress(modelId: string, patch: Partial<DownloadProgress>): DownloadProgress {
  const previousStatus = state.downloads.get(modelId)?.status;
  const progress = mergeDownloadProgress(modelId, patch);
  state.downloads.set(modelId, progress);

  // Un telechargement lance depuis le navigateur Hub n'a pas de carte dans le
  // catalogue : c'est le modal qui porte sa progression.
  if (state.hubOpen) renderHub();

  if (previousStatus && previousStatus !== progress.status) {
    renderCatalog();
    return progress;
  }

  const fill = byId(`nb-progress-${modelId}`)?.querySelector<HTMLElement>("span");
  const label = byId(`nb-progress-label-${modelId}`);
  const progressElement = byId(`nb-progress-${modelId}`);
  if (fill) fill.style.width = `${Math.max(0, Math.min(100, progress.pct || 0))}%`;
  if (progressElement) progressElement.dataset.visible = "true";
  if (label) {
    label.dataset.visible = "true";
    label.textContent = progress.error || transferLabel(progress);
  }
  return progress;
}

function isTerminalDownload(status: DownloadStatus): boolean {
  return status === "done" || status === "cancelled" || status === "error";
}

function unwrapDownloadJob(response: DownloadJob | { job: DownloadJob }): DownloadJob {
  return "job" in response ? response.job : response;
}

async function getDownloadJob(jobId: string): Promise<DownloadJob> {
  return unwrapDownloadJob(
    await requestJson<DownloadJob | { job: DownloadJob }>(
      `/api/profile/ai/models/downloads/${encodeURIComponent(jobId)}`,
    ),
  );
}

async function finishDownloadWatch(progress: DownloadProgress): Promise<void> {
  if (progress.status === "done") {
    state.downloads.delete(progress.model_id || "");
    await Promise.allSettled([refreshCore(), refreshRecommendation()]);
    setPanelStatus("Modèle téléchargé. Il est disponible dans « Mes modèles ».", "ok");
    renderCatalog();
  } else if (progress.status === "cancelled") {
    state.downloads.delete(progress.model_id || "");
    renderCatalog();
    setPanelStatus("Téléchargement annulé ; le fichier partiel a été supprimé.", "info");
  } else if (progress.status === "paused") {
    renderCatalog();
    setPanelStatus("Téléchargement en pause. Le fichier partiel est conservé.", "info");
  } else if (progress.status === "error") {
    renderCatalog();
    setPanelStatus(progress.error || "Le téléchargement a échoué.", "error");
  }
}

async function consumeDownloadStream(
  modelId: string,
  initial: DownloadProgress,
): Promise<DownloadProgress> {
  const jobId = initial.job_id;
  if (!jobId) throw new Error("Identifiant de téléchargement manquant.");
  const base = await apiBase();
  const response = await fetch(
    `${base}/api/profile/ai/models/download/${encodeURIComponent(jobId)}`,
  );
  if (!response.ok || !response.body) {
    throw new Error(`Flux de téléchargement indisponible (HTTP ${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let snapshot = initial;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
      const data = rawEvent
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      const event = JSON.parse(data) as Partial<DownloadProgress> & { type?: string };
      if (event.status) {
        snapshot = updateDownloadProgress(modelId, event);
        if (snapshot.status === "paused" || isTerminalDownload(snapshot.status)) return snapshot;
      }
      if (event.type === "end" && event.error) {
        return updateDownloadProgress(modelId, { status: "error", error: event.error });
      }
    }
  }

  if (snapshot.status === "paused" || isTerminalDownload(snapshot.status)) return snapshot;
  throw new Error("Flux SSE interrompu pendant le téléchargement.");
}

async function watchDownloadJob(initial: DownloadProgress): Promise<void> {
  const modelId = initial.model_id;
  const jobId = initial.job_id;
  if (!modelId || !jobId) return;
  let snapshot = initial;

  while (isDownloading(modelId)) {
    try {
      snapshot = await consumeDownloadStream(modelId, snapshot);
      if (snapshot.status === "paused" || isTerminalDownload(snapshot.status)) break;
    } catch (error) {
      setPanelStatus(
        `Connexion au téléchargement interrompue : ${error instanceof Error ? error.message : "reconnexion…"}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      try {
        snapshot = progressFromJob(await getDownloadJob(jobId));
        updateDownloadProgress(modelId, snapshot);
      } catch {
        continue;
      }
    }
  }
  await finishDownloadWatch(snapshot);
}

function ensureDownloadWatcher(progress: DownloadProgress): void {
  const jobId = progress.job_id;
  if (!jobId || !progress.model_id || !isDownloading(progress.model_id)) return;
  const existing = state.downloadWatchers.get(jobId);
  if (existing) {
    void existing.finally(() => {
      const latest = state.downloads.get(progress.model_id || "");
      if (latest) ensureDownloadWatcher(latest);
    });
    return;
  }
  const watcher = watchDownloadJob(progress)
    .catch((error) => {
      setPanelStatus(error instanceof Error ? error.message : "Suivi du téléchargement interrompu.", "error");
    })
    .finally(() => {
      if (state.downloadWatchers.get(jobId) === watcher) state.downloadWatchers.delete(jobId);
    });
  state.downloadWatchers.set(jobId, watcher);
}

function applyDownloadJobs(jobs: DownloadJob[]): void {
  const next = new Map<string, DownloadProgress>();
  for (const job of jobs) {
    if (!job.model_id || job.status === "done" || job.status === "cancelled") continue;
    const progress = progressFromJob(job);
    next.set(job.model_id, progress);
  }
  state.downloads = next;
  for (const progress of next.values()) ensureDownloadWatcher(progress);
  renderCatalog();
}

async function refreshDownloadJobs(): Promise<void> {
  const response = await requestJson<{ jobs: DownloadJob[] } | DownloadJob[]>(
    "/api/profile/ai/models/downloads",
  );
  applyDownloadJobs(Array.isArray(response) ? response : response.jobs || []);
}

async function startDownload(modelId: string): Promise<void> {
  for (const [activeId] of state.downloads) {
    if (isDownloading(activeId) || state.downloads.get(activeId)?.status === "pausing") {
      setPanelStatus("Un téléchargement est déjà en cours.", "error");
      return;
    }
  }

  updateDownloadProgress(modelId, { status: "starting", received: 0, total: 0, pct: 0 });
  setPanelStatus("Préparation du téléchargement…");

  try {
    const response = await requestJson<
      { job_id: string; job?: DownloadJob } | DownloadJob
    >("/api/profile/ai/models/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model_id: modelId }),
    });
    const job = "model_id" in response ? response : response.job;
    const jobId = response.job_id || job?.job_id;
    if (!jobId) throw new Error("Le backend n'a pas retourné d'identifiant de job.");
    const progress = updateDownloadProgress(modelId, {
      ...(job ? progressFromJob(job) : {}),
      job_id: jobId,
      model_id: modelId,
      status: job?.status || "queued",
    });
    ensureDownloadWatcher(progress);
    setPanelStatus("Téléchargement démarré. Vous pouvez le mettre en pause à tout moment.", "ok");
  } catch (error) {
    const previous = state.downloads.get(modelId);
    const message = error instanceof Error ? error.message : "Téléchargement impossible";
    state.downloads.set(modelId, {
      ...previous,
      job_id: previous?.job_id,
      model_id: modelId,
      status: "error",
      received: previous?.received || 0,
      total: previous?.total || 0,
      pct: previous?.pct || 0,
      error: message,
    });
    renderCatalog();
    setPanelStatus(`Échec du téléchargement : ${message}`, "error");
  }
}

async function pauseDownload(modelId: string, button: HTMLButtonElement): Promise<void> {
  const jobId = state.downloads.get(modelId)?.job_id;
  if (!jobId) return;
  button.disabled = true;
  setPanelStatus("Mise en pause du téléchargement…");
  try {
    const job = unwrapDownloadJob(
      await requestJson<DownloadJob | { job: DownloadJob }>(
        `/api/profile/ai/models/downloads/${encodeURIComponent(jobId)}/pause`,
        { method: "POST" },
      ),
    );
    updateDownloadProgress(modelId, progressFromJob(job));
    setPanelStatus("Téléchargement en pause. Le fichier partiel est conservé.", "ok");
  } catch (error) {
    setPanelStatus(error instanceof Error ? error.message : "Mise en pause impossible.", "error");
    await refreshDownloadJobs().catch(() => undefined);
  } finally {
    renderCatalog();
  }
}

async function resumeDownload(modelId: string, button: HTMLButtonElement): Promise<void> {
  const jobId = state.downloads.get(modelId)?.job_id;
  if (!jobId) return;
  button.disabled = true;
  setPanelStatus("Reprise du téléchargement…");
  try {
    const job = unwrapDownloadJob(
      await requestJson<DownloadJob | { job: DownloadJob }>(
        `/api/profile/ai/models/downloads/${encodeURIComponent(jobId)}/resume`,
        { method: "POST" },
      ),
    );
    const progress = updateDownloadProgress(modelId, progressFromJob(job));
    ensureDownloadWatcher(progress);
    setPanelStatus("Téléchargement repris depuis le fichier partiel.", "ok");
  } catch (error) {
    setPanelStatus(error instanceof Error ? error.message : "Reprise impossible.", "error");
    await refreshDownloadJobs().catch(() => undefined);
  } finally {
    renderCatalog();
    if (state.hubOpen) renderHub();
  }
}

async function cancelDownload(modelId: string, button: HTMLButtonElement): Promise<void> {
  const progress = state.downloads.get(modelId);
  if (!progress?.job_id) return;
  const modelName = state.recommendation?.models.find((model) => model.id === modelId)?.name || modelId;
  if (!window.confirm(`Annuler le téléchargement de « ${modelName} » et supprimer le fichier partiel ?`)) {
    return;
  }
  button.disabled = true;
  updateDownloadProgress(modelId, { status: "cancelling" });
  setPanelStatus("Annulation et suppression du fichier partiel…");
  try {
    await requestJson<void>(
      `/api/profile/ai/models/downloads/${encodeURIComponent(progress.job_id)}`,
      { method: "DELETE" },
    );
    state.downloads.delete(modelId);
    renderCatalog();
    setPanelStatus("Téléchargement annulé ; le fichier partiel a été supprimé.", "ok");
  } catch (error) {
    setPanelStatus(error instanceof Error ? error.message : "Annulation impossible.", "error");
    await refreshDownloadJobs().catch(() => undefined);
    renderCatalog();
  }
  if (state.hubOpen) renderHub();
}

async function selectDownloadedModel(modelId: string, button: HTMLButtonElement): Promise<void> {
  if (!state.downloaded[modelId]) {
    setPanelStatus("Ce modèle n’est pas dans la liste des modèles téléchargés.", "error");
    return;
  }
  button.disabled = true;
  setPanelStatus(`Sélection de ${modelId}…`);
  try {
    // Le choix est UN enregistrement (source unique) : l'écrire ici rend ce
    // modèle le seul actif et déclenche son chargement ; tous les autres,
    // locaux comme externes, sont désélectionnés.
    state.settings = await requestJson<AiSettings>("/api/profile/ai", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selection: { kind: "embedded", model: modelId } }),
    });
    renderAll();
    setPanelStatus(
      `${modelId} est le modèle actif : chargement en cours, tout le reste est désactivé.`,
      "ok",
    );
    announceSelection();
    scheduleEnginePoll();
  } catch (error) {
    if (button.isConnected) button.disabled = false;
    setPanelStatus(error instanceof Error ? error.message : "Sélection impossible", "error");
  }
}

async function useSelectedModel(button: HTMLButtonElement): Promise<void> {
  const modelId = selectedModelId();
  if (!modelId) {
    selectTab("installed");
    setPanelStatus("Choisissez d’abord un modèle téléchargé.", "error");
    return;
  }
  await activateModel(modelId, button);
}

async function activateModel(modelId: string, button: HTMLButtonElement): Promise<void> {
  // Réessai explicite : le choix est réécrit (source unique, sans effet s'il est
  // déjà en place) et le chargement est relancé ; la progression se suit ensuite
  // par polling, comme pour une première sélection.
  button.disabled = true;
  setPanelStatus(`Chargement de ${modelId}…`);
  try {
    state.settings = await requestJson<AiSettings>("/api/profile/ai", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selection: { kind: "embedded", model: modelId } }),
    });
    setPanelStatus(`Chargement de ${modelId} en cours…`, "ok");
    renderAll();
    announceSelection();
    scheduleEnginePoll();
  } catch (error) {
    if (button.isConnected) button.disabled = false;
    setPanelStatus(error instanceof Error ? error.message : "Chargement impossible", "error");
  }
}

async function stopEngine(): Promise<void> {
  setPanelStatus("Arrêt du moteur local…");
  try {
    await requestJson("/api/profile/ai/embedded/stop", { method: "POST" });
    await refreshCore();
    setPanelStatus("Moteur local arrêté.", "ok");
    announceSelection();
  } catch (error) {
    setPanelStatus(error instanceof Error ? error.message : "Arrêt impossible", "error");
  }
}

async function deleteDownloadedModel(modelId: string, button: HTMLButtonElement): Promise<void> {
  const downloaded = state.downloaded[modelId];
  if (!downloaded) {
    setPanelStatus("Ce modèle n’est pas dans la liste des modèles téléchargés.", "error");
    return;
  }
  const size = formatBytes(downloaded.size_bytes || 0);
  if (!window.confirm(`Supprimer « ${downloaded.name} » (${size}) du disque ? Le moteur sera arrêté s’il l’utilise.`)) {
    return;
  }
  button.disabled = true;
  setPanelStatus(`Suppression de ${modelId}…`);
  try {
    await requestJson(`/api/profile/ai/models/${encodeURIComponent(modelId)}`, { method: "DELETE" });
    delete state.downloaded[modelId];
    selectTab("installed");
    await refreshAll();
    setPanelStatus(`${modelId} supprimé du disque.`, "ok");
    announceSelection();
  } catch (error) {
    if (button.isConnected) button.disabled = false;
    setPanelStatus(error instanceof Error ? error.message : "Suppression impossible.", "error");
    await refreshCore().catch(() => undefined);
  }
}

function handlePanelClick(event: MouseEvent): void {
  if (!(event.target instanceof Element) || !root) return;
  const tab = event.target.closest<HTMLButtonElement>("[data-model-tab]");
  if (tab?.dataset.modelTab) {
    selectTab(tab.dataset.modelTab as "download" | "installed" | "active");
    return;
  }
  const action = event.target.closest<HTMLButtonElement>("[data-model-action]");
  if (!action) return;
  const modelId = action.dataset.modelId;
  switch (action.dataset.modelAction) {
    case "download":
      if (modelId) void startDownload(modelId);
      break;
    case "pause-download":
      if (modelId) void pauseDownload(modelId, action);
      break;
    case "resume-download":
      if (modelId) void resumeDownload(modelId, action);
      break;
    case "cancel-download":
      if (modelId) void cancelDownload(modelId, action);
      break;
    case "select":
      if (modelId) void selectDownloadedModel(modelId, action);
      break;
    case "use-selected":
      void useSelectedModel(action);
      break;
    case "stop-engine":
      void stopEngine();
      break;
    case "delete-model":
      if (modelId) void deleteDownloadedModel(modelId, action);
      break;
    case "open-download":
      selectTab("download");
      break;
    case "open-installed":
      selectTab("installed");
      break;
    case "scroll-provider":
      byId("ai-settings-title")?.scrollIntoView({ behavior: "smooth", block: "start" });
      break;
    case "hub-open":
      openHub();
      break;
    case "hub-close":
      closeHub();
      break;
    case "hub-repo": {
      const repo = action.dataset.hubRepo;
      if (repo) void openHubRepo(repo);
      break;
    }
    case "hub-download": {
      const repo = action.dataset.hubRepo;
      const file = action.dataset.hubFile;
      const size = Number(action.dataset.hubSize) || 0;
      if (repo && file) void downloadFromHub(repo, file, size, action);
      break;
    }
    case "hub-resume": {
      const target = action.dataset.hubModel;
      if (target) void resumeDownload(target, action);
      break;
    }
    case "hub-cancel": {
      const target = action.dataset.hubModel;
      if (target) void cancelDownload(target, action);
      break;
    }
  }
}

function handlePanelKeydown(event: KeyboardEvent): void {
  if (!(event.target instanceof Element) || !root) return;
  // Escape ferme le navigateur Hugging Face (le panneau ne se ferme jamais).
  if (event.key === "Escape" && state.hubOpen) {
    event.preventDefault();
    closeHub();
    byId<HTMLButtonElement>("nb-model-hub-query")?.blur();
    return;
  }
  const tab = event.target.closest<HTMLButtonElement>("[data-model-tab]");
  if (!tab) return;
  const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-model-tab]"));
  const index = tabs.indexOf(tab);
  let next = index;
  if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
  else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = tabs.length - 1;
  else return;
  event.preventDefault();
  selectTab(tabs[next].dataset.modelTab as "download" | "installed" | "active", true);
}

function bindPanel(panel: HTMLElement): void {
  panel.addEventListener("click", handlePanelClick);
  panel.addEventListener("keydown", handlePanelKeydown);
  // Clic sur le voile (hors carte) : fermeture, comme un modal classique.
  panel.addEventListener("mousedown", (event) => {
    if (state.hubOpen && event.target instanceof Element && event.target.id === "nb-model-hub") {
      closeHub();
    }
  });
  const query = panel.querySelector<HTMLInputElement>("#nb-model-hub-query");
  query?.addEventListener("input", () => {
    if (hubDebounce !== null) window.clearTimeout(hubDebounce);
    hubDebounce = window.setTimeout(() => void searchHub(query.value), 400);
  });
  query?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (hubDebounce !== null) window.clearTimeout(hubDebounce);
    void searchHub(query.value);
  });
}

function mountPanel(): void {
  if (window.location.protocol === "file:") return;
  const aiSection = document.querySelector<HTMLElement>('section[aria-labelledby="ai-settings-title"]');
  const container = aiSection?.parentElement;
  if (!aiSection || !container) return;

  const existing = byId(ROOT_ID);
  if (existing) {
    root = existing;
    return;
  }

  installStyles();
  root = createPanel();
  bindPanel(root);
  container.insertBefore(root, aiSection);
  renderAll();
  selectTab(state.activeTab);
  void refreshAll();
}

/** Monte le gestionnaire local dans l'onglet IA sans modifier web/. */
export function installProfileModelsPanel(): void {
  if (window.location.protocol === "file:" || observer) return;

  const mountWhenReady = (): void => mountPanel();
  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", mountWhenReady, { once: true });
  } else {
    mountWhenReady();
  }

  observer = new MutationObserver(mountWhenReady);
  const startObserver = (): void => {
    if (document.documentElement) {
      observer?.observe(document.documentElement, { childList: true, subtree: true });
    }
  };
  if (document.documentElement) startObserver();
  else window.addEventListener("DOMContentLoaded", startObserver, { once: true });

  window.addEventListener("focus", () => {
    if (byId(ROOT_ID)?.isConnected) void refreshCore();
  });
  // Le formulaire du profil (React) écrit la même source de vérité : dès qu'il
  // enregistre un choix, on se resynchronise au lieu de garder un cache périmé.
  window.addEventListener(AI_SELECTION_EVENT, () => {
    if (!byId(ROOT_ID)?.isConnected) return;
    void refreshCore();
    scheduleEnginePoll();
  });
  // Filet de sécurité : le choix peut aussi changer hors de cette page.
  window.setInterval(() => {
    if (byId(ROOT_ID)?.isConnected) void refreshCore();
  }, 10_000);
}
