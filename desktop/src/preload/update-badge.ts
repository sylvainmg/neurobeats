import { ipcRenderer } from "electron";

/**
 * Pastille et signal de mise à jour, injectés dans l'interface web partagée.
 *
 * Pourquoi une injection DOM plutôt qu'un composant React dans `web/` : l'UI
 * web est la source de vérité de l'interface, et elle sert aussi le navigateur
 * seul, où aucune mise à jour n'existe. Tout ce qui est propre à l'app installée
 * vit donc ici (même convention que le panneau des modèles IA).
 *
 * La forme du signal est dictée par `shared/update/policy.ts`, jamais décidée
 * ici. Ce fichier ne fait que la mettre en scène, et il applique les trois
 * règles de mise en scène qui portent cette politique :
 *
 * 1. jamais de dialogue modal — un lecteur de musique n'interrompt pas une piste ;
 * 2. rien n'apparaît pendant une lecture, la pastille suffit ;
 * 3. un toast qui ne s'efface jamais est une notification qui harcèle : le
 *    premier signal s'auto-efface, seul le bandeau attend une action.
 */

const ROOT_ID = "neurobeats-update";
const STYLE_ID = "neurobeats-update-style";
/** Durée d'affichage du premier signal, assez long pour être lu une fois. */
const DUREE_TOAST_MS = 5000;

interface EtatMaj {
  versionCourante: string;
  versionDisponible: string | null;
  bruit: "rien" | "silencieux" | "information" | "proposition" | "obligatoire";
  raison: string;
  obligatoire: boolean;
  notes: string;
  differe: boolean;
  prochainControleDansMs: number | null;
  erreur: string | null;
}

const api = {
  etat: (): Promise<EtatMaj> => ipcRenderer.invoke("desktop:update-etat"),
  controler: (): Promise<EtatMaj> => ipcRenderer.invoke("desktop:update-controler"),
  reporter: (): Promise<EtatMaj> => ipcRenderer.invoke("desktop:update-reporter"),
  ignorer: (): Promise<EtatMaj> => ipcRenderer.invoke("desktop:update-ignorer"),
  installer: (): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke("desktop:update-installer"),
};

let etat: EtatMaj | null = null;
let toastTimer: number | null = null;
let installEnCours = false;

function escapeHtml(value: unknown): string {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return String(value ?? "").replace(/[&<>"']/g, (c) => entities[c]);
}

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function delaiLisible(ms: number | null): string {
  if (ms === null || ms <= 0) return "";
  const heures = Math.round(ms / 3_600_000);
  if (heures < 1) return "dans moins d'une heure";
  if (heures < 48) return `dans ${heures} h`;
  return `dans ${Math.round(heures / 24)} jours`;
}

function installStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${ROOT_ID}, #${ROOT_ID} * { box-sizing: border-box; }
    #${ROOT_ID} {
      position: fixed;
      right: 20px;
      bottom: 20px;
      z-index: 80;
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-width: 360px;
      font-family: inherit;
      pointer-events: none;
    }
    #${ROOT_ID} > * { pointer-events: auto; }

    /* Pastille : la seule trace en lecture. Emplacement stable, elle ne
       réserve pas de place mais ne pousse rien non plus quand elle apparaît. */
    #${ROOT_ID} .nb-u-dot {
      align-self: flex-end;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-height: 30px;
      padding: 5px 11px;
      border-radius: 999px;
      border: 1px solid color-mix(in oklab, var(--accent) 32%, var(--border));
      background: color-mix(in oklab, var(--accent) 12%, var(--surface));
      color: color-mix(in oklab, var(--accent) 88%, white);
      font-size: 11.5px;
      font-weight: 650;
      cursor: pointer;
    }
    #${ROOT_ID} .nb-u-dot:hover { background: color-mix(in oklab, var(--accent) 20%, var(--surface)); }
    #${ROOT_ID} .nb-u-dot::before {
      content: "";
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: currentColor;
    }
    #${ROOT_ID} .nb-u-dot:focus-visible,
    #${ROOT_ID} button:focus-visible {
      outline: 2px solid var(--ring);
      outline-offset: 2px;
    }

    #${ROOT_ID} .nb-u-card {
      padding: 14px 15px;
      border-radius: 13px;
      border: 1px solid var(--border);
      background: var(--surface);
      box-shadow: 0 16px 40px rgba(0, 0, 0, .38);
      display: grid;
      gap: 10px;
    }
    #${ROOT_ID} .nb-u-card[data-kind="obligatoire"] {
      border-color: color-mix(in oklab, #f6ad72 45%, var(--border));
    }
    #${ROOT_ID} .nb-u-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 10px;
    }
    #${ROOT_ID} .nb-u-title { font-size: 13px; font-weight: 650; margin: 0; }
    #${ROOT_ID} .nb-u-version {
      font-size: 11px;
      color: var(--muted-foreground);
      font-variant-numeric: tabular-nums;
    }
    #${ROOT_ID} .nb-u-notes {
      margin: 0;
      font-size: 11.5px;
      line-height: 1.45;
      color: var(--muted-foreground);
      max-height: 7.5em;
      overflow: auto;
      white-space: pre-wrap;
    }
    #${ROOT_ID} .nb-u-actions { display: flex; gap: 7px; flex-wrap: wrap; }
    #${ROOT_ID} .nb-u-button {
      appearance: none;
      min-height: 30px;
      padding: 5px 11px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: color-mix(in oklab, var(--surface-hover) 82%, transparent);
      color: var(--foreground);
      font: inherit;
      font-size: 11.5px;
      font-weight: 650;
      cursor: pointer;
    }
    #${ROOT_ID} .nb-u-button:hover:not(:disabled) {
      background: var(--surface-hover);
      border-color: color-mix(in oklab, var(--foreground) 20%, var(--border));
    }
    #${ROOT_ID} .nb-u-button[data-variant="primary"] {
      background: var(--primary);
      border-color: var(--primary);
      color: var(--primary-foreground);
    }
    #${ROOT_ID} .nb-u-button:disabled { opacity: .5; cursor: not-allowed; }
    #${ROOT_ID} .nb-u-status {
      font-size: 11.5px;
      color: var(--muted-foreground);
      min-height: 16px;
    }
    #${ROOT_ID} .nb-u-status[data-kind="error"] { color: #fca5a5; }
    /* La carte s'efface d'elle-même : rien de ce qui reste à l'écran ne
       commande une action ne doit disparaître sur un délai lu comme un reproche. */
    #${ROOT_ID} .nb-u-card[data-auto="true"] { transition: opacity .25s ease; }
    @media (prefers-reduced-motion: reduce) {
      #${ROOT_ID} .nb-u-card[data-auto="true"] { transition: none; }
    }
  `;
  document.head.appendChild(style);
}

function createRoot(): HTMLElement {
  const root = document.createElement("div");
  root.id = ROOT_ID;
  document.body.appendChild(root);
  return root;
}

function renderPastille(): void {
  const existant = byId("nb-u-dot");
  if (existant) existant.remove();
  // Une pastille n'a de sens que s'il y a une version à installer.
  if (!etat?.versionDisponible) return;
  if (etat.bruit === "rien") return;

  const bouton = document.createElement("button");
  bouton.id = "nb-u-dot";
  bouton.type = "button";
  bouton.className = "nb-u-dot";
  bouton.textContent = `Version ${etat.versionDisponible}`;
  bouton.title = "Voir la mise à jour";
  bouton.addEventListener("click", () => ouvrirDetail());
  byId(ROOT_ID)?.appendChild(bouton);
}

function renderCarte(): void {
  const existant = byId("nb-u-card");
  if (existant) existant.remove();
  if (toastTimer !== null) {
    window.clearTimeout(toastTimer);
    toastTimer = null;
  }
  if (!etat || !etat.versionDisponible) return;

  // `rien` et `silencieux` ne laissent que la pastille : c'est le cas pendant
  // une lecture, après un report, et une fois le quota de signalements épuisé.
  const bruit = etat.bruit;
  if (bruit === "rien" || bruit === "silencieux") return;

  // Le toast ne porte qu'un message et une action. Le bandeau, lui, reste tant
  // que l'utilisateur ne l'a pas tranché.
  const automatique = bruit === "information" && !etat.obligatoire;

  const carte = document.createElement("div");
  carte.id = "nb-u-card";
  carte.className = "nb-u-card";
  carte.dataset.kind = bruit;
  carte.dataset.auto = String(automatique);
  // `status` plutôt que `alert` : annoncé sans interrompre la lecture en cours.
  carte.setAttribute("role", "status");

  const notes = etat.notes.trim();
  carte.innerHTML = `
    <div class="nb-u-head">
      <p class="nb-u-title">${
        etat.obligatoire ? "Mise à jour nécessaire" : `NeuroBeats ${escapeHtml(etat.versionDisponible)}`
      }</p>
      <span class="nb-u-version">${escapeHtml(etat.versionCourante)} → ${escapeHtml(etat.versionDisponible)}</span>
    </div>
    ${notes ? `<p class="nb-u-notes">${escapeHtml(notes)}</p>` : ""}
    <div class="nb-u-actions">
      <button class="nb-u-button" data-variant="primary" type="button" data-u-action="installer">Mettre à jour</button>
      ${
        etat.obligatoire
          ? ""
          : `<button class="nb-u-button" type="button" data-u-action="reporter">Plus tard</button>
             <button class="nb-u-button" type="button" data-u-action="ignorer">Ignorer</button>`
      }
    </div>
    <div class="nb-u-status" role="status" aria-live="polite"></div>
  `;

  carte.addEventListener("click", (event) => {
    const cible = (event.target as HTMLElement).closest<HTMLElement>("[data-u-action]");
    if (!cible) return;
    void agir(cible.dataset.uAction as "installer" | "reporter" | "ignorer");
  });

  byId(ROOT_ID)?.appendChild(carte);

  if (automatique) {
    toastTimer = window.setTimeout(() => {
      carte.style.opacity = "0";
      window.setTimeout(() => carte.remove(), 260);
    }, DUREE_TOAST_MS);
  }
}

function rendre(): void {
  installStyles();
  if (!byId(ROOT_ID)) createRoot();
  renderPastille();
  renderCarte();
}

async function agir(action: "installer" | "reporter" | "ignorer"): Promise<void> {
  const statut = byId("nb-u-status");
  if (action === "installer") {
    if (installEnCours) return;
    installEnCours = true;
    // Un téléchargement d'installeur dure : on le dit, et on ne laisse pas
    // l'utilisateur croire que rien ne se passe.
    if (statut) {
      statut.dataset.kind = "";
      statut.textContent = "Téléchargement en cours…";
    }
    const boutons = byId(ROOT_ID)?.querySelectorAll<HTMLButtonElement>("button");
    boutons?.forEach((b) => {
      b.disabled = true;
    });

    const resultat = await api.installer();
    installEnCours = false;
    if (statut) {
      statut.dataset.kind = resultat.ok ? "" : "error";
      statut.textContent = resultat.message;
    }
    if (resultat.ok) {
      // L'installeur prend la main : on ne laisse pas une carte derrière lui.
      byId("nb-u-card")?.remove();
    } else {
      boutons?.forEach((b) => {
        b.disabled = false;
      });
    }
    return;
  }

  if (action === "reporter") {
    etat = await api.reporter();
  } else {
    etat = await api.ignorer();
  }
  rendre();
}

/** Ouvre le détail depuis la pastille : même carte, mais elle reste. */
function ouvrirDetail(): void {
  if (!etat) return;
  etat = { ...etat, bruit: etat.obligatoire ? "obligatoire" : "proposition" };
  rendre();
}

function appliquer(nouvelEtat: EtatMaj): void {
  etat = nouvelEtat;
  rendre();
}

/**
 * Point d'entrée, appelé par le preload principal.
 *
 * Le premier état est demandé explicitement : la fenêtre peut être déjà rendue
 * quand le processus principal reçoit le manifeste, et l'événement du coup
 * manqué ne serait jamais rejoué.
 */
export function installUpdateBadge(): void {
  void api
    .etat()
    .then((initial) => {
      if (initial && initial.raison !== "pas encore contrôlé") appliquer(initial);
      else rendre();
    })
    .catch(() => undefined);

  ipcRenderer.on("desktop:update", (_event, nouvelEtat: EtatMaj) => {
    appliquer(nouvelEtat);
  });

  // Vérification manuelle : le seul moment où l'on force une requête réseau.
  window.addEventListener("neurobeats:update-check", () => {
    void api
      .controler()
      .then(appliquer)
      .catch(() => undefined);
  });
}
