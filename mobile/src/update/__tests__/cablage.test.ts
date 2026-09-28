/**
 * Câblage du vérificateur de mise à jour dans les deux applications.
 *
 * Ce que les autres suites ne couvrent pas : que le service est *appelé* et que
 * l'interface *écoute*. Les règles sont testées dans `coeur-update`, le chemin
 * réseau réel dans `scripts/verifier-reseau.mjs` (hors jest, dont le `fetch` est
 * simulé). Il reste donc ceci : que les branchements existent, et qu'ils ne sont
 * pas conditionnés à une variable absente.
 *
 * On lit les sources plutôt que de les importer : importer le processus
 * principal Electron depuis le paquetage mobile échouerait sur `electron`, et
 * le preload n'est pas un module. Ce qui compte ici est textuel et stable.
 *
 * Limite assumée : ce test ne prouve pas que la pastille s'affiche à l'écran.
 * Cela demande une vraie fenêtre, et reste la seule chose que personne n'a
 * observée jusqu'ici — parce que l'URL du manifeste par défaut ne répond pas.
 */

import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";

const RACINE = path.resolve(__dirname, "..", "..", "..", "..");
const lire = (...chemins: string[]) => readFileSync(path.join(RACINE, ...chemins), "utf8");

describe("desktop : le service est appelé", () => {
  const index = lire("desktop", "src", "main", "index.ts");
  const service = lire("desktop", "src", "main", "update.ts");

  it("le contrôle part au démarrage, une fois l'interface affichée", () => {
    expect(index).toContain("demarrerServiceUpdate()");
    // Après `showMain()` : sinon la fenêtre n'existe pas pour recevoir la
    // décision, et le premier son est retardé par une question de version.
    expect(index.indexOf("demarrerServiceUpdate()")).toBeGreaterThan(index.indexOf("showMain()"));
  });

  it("il est sauté en développement, mais forçable par variable d'environnement", () => {
    expect(service).toContain("isDev()");
    expect(service).toContain("NEUROBEATS_UPDATE_MANIFEST");
  });

  it("l'URL du manifeste est centralisée, pas dispersée en littéraux", () => {
    expect(service).toContain("URL_MANIFSTE_MAJ");
    const constantes = lire("desktop", "src", "shared", "constants.ts");
    expect(constantes).toContain("URL_MANIFSTE_MAJ");
    expect(constantes).toContain("https://");
  });

  it("les fenêtres sont diffusées à toutes les fenêtres", () => {
    expect(index).toContain("getAllWindows()");
    expect(index).toContain('webContents.send("desktop:update"');
  });
});

describe("desktop : l'interface réagit", () => {
  const badge = lire("desktop", "src", "preload", "update-badge.ts");
  const preload = lire("desktop", "src", "preload", "index.ts");

  it("le badge est installé au chargement du preload", () => {
    expect(preload).toContain("installUpdateBadge()");
  });

  it("il écoute les décisions ET demande l'état initial", () => {
    // Les deux sont nécessaires : la fenêtre peut être déjà rendue quand le
    // manifeste arrive, et l'événement du coup manqué ne serait jamais rejoué.
    expect(badge).toContain('ipcRenderer.on("desktop:update"');
    expect(badge).toContain("desktop:update-etat");
  });

  it("il ne force jamais de dialogue modal", () => {
    expect(badge).not.toMatch(/role="dialog"/);
    expect(badge).not.toMatch(/showErrorBox/);
  });

  it("le premier signal s'efface tout seul, le bandeau se replie", () => {
    expect(badge).toContain("DUREE_TOAST_MS");
    expect(badge).toContain("setTimeout");
  });
});

describe("desktop : rien ne s'exécute sans vérification", () => {
  const service = lire("desktop", "src", "main", "update.ts");

  it("le HTTPS est exigé avant tout téléchargement", () => {
    expect(service).toContain('protocol !== "https:"');
  });
  it("l'empreinte est vérifiée avant le lancement de l'installeur", () => {
    expect(service).toContain("empreinteValide");
    expect(service.indexOf("shell.openPath")).toBeGreaterThan(service.indexOf("empreinteValide"));
  });
  it("le fichier non conforme est supprimé", () => {
    expect(service).toContain("rmSync");
  });
  it("le téléchargement n'est jamais lancé tout seul", () => {
    // `telechargerEtInstaller` n'est appele que depuis un clic : le service ne
    // doit pas tenter d'installer quoi que ce soit sans demande.
    expect(service).toContain("export async function telechargerEtInstaller");
    expect(lire("desktop", "src", "preload", "update-badge.ts")).toContain("api.installer()");
  });
});

describe("mobile : le service est appelé", () => {
  const layout = lire("mobile", "src", "app", "_layout.tsx");
  const service = lire("mobile", "src", "update", "service.ts");

  it("le contrôle part au montage, sans bloquer le premier écran", () => {
    expect(layout).toContain("controler()");
    expect(layout).toContain("BandeauMiseAJour");
  });
  it("l'URL est configurable sans reconstruire l'application", () => {
    expect(service).toContain("EXPO_PUBLIC_UPDATE_MANIFEST");
  });
  it("l'APK n'est proposé que s'il peut réellement s'installer", () => {
    // Sans quoi l'utilisateur télécharge 40 Mo qu'Android refuse.
    expect(service).toContain("autoInstallationPossible");
    expect(service).toContain("EXPO_PUBLIC_MAJ_AUTO_INSTALLABLE");
  });
  it("le HTTPS est exigé et l'empreinte vérifiée", () => {
    expect(service).toContain('protocol !== "https:"');
    expect(service).toContain("empreinteValide");
  });
  it("l'état est persisté entre deux lancements", () => {
    expect(service).toContain("etat-maj.json");
  });
});

describe("mobile : l'interface réagit", () => {
  const bandeau = lire("mobile", "src", "update", "bandeau.tsx");

  it("il s'abonne au service", () => {
    expect(bandeau).toContain("surChangement");
  });
  it("ce n'est ni une modale ni un plein écran", () => {
    expect(bandeau).not.toMatch(/<Modal/);
    expect(bandeau).toContain("pointerEvents");
  });
  it("il se replie de lui-même", () => {
    expect(bandeau).toContain("REPLI_MS");
  });
  it("il propose les trois issues : installer, plus tard, ignorer", () => {
    expect(bandeau).toContain("Mettre à jour");
    expect(bandeau).toContain("Plus tard");
    expect(bandeau).toContain("Ignorer");
  });
});
