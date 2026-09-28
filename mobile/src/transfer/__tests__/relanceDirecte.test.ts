/**
 * Non-régression : une panne transitoire doit être relancée automatiquement.
 *
 * Régression couverte. `echouerTransfert` faisait, dans cet ordre :
 *
 *     this.siSourceStale(erreur);                                  // 1
 *     if (this.directs.has(...)) this.relancerDirect(spec, ...);  // 2
 *
 * et `siSourceStale` appelait `YtDlp.updateYtDlp()` — une fonction absente de
 * la facade JavaScript, des types et du module Kotlin. L'appel levait un
 * `TypeError` **synchrone**, que le `.catch()` accolé à la promesse ne pouvait
 * pas attraper : l'exception remontait de `siSourceStale` et la ligne 2
 * n'etait jamais atteinte.
 *
 * Concretement, ce code ne mettait pas yt-dlp a jour, il supprimait la relance
 * automatique des 403 et des pannes reseau — le cas meme qu'il pretendait
 * traiter. Le son se jouait, le telechargement direct ne se relancait plus, et
 * l'utilisateur devait recliquer.
 *
 * Ces tests branchent sur la vraie classe : ils instancient `Gestionnaire` et
 * appellent `echouerTransfert` avec une vraie `YtDlpError`. Un test qui
 * recopierait la logique documenterait le bug sans le couvrir.
 */
import { describe, expect, it, beforeEach, afterEach, jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Le paquet publie est en ESM, que jest ne transforme pas. On le remplace donc
 * par un equivalent minimal — mais le SEUL test qui compte sur ce module
 * (`updateYtDlp` n'existe pas) lit les fichiers reels sur disque, jamais ce
 * mock : verifier une absence dans un mock ne prouverait rien.
 */
jest.mock("ytdlp-react-native", () => {
  class ErreurYtDlp extends Error {
    code: string;
    constructor(message: string, code = "UNKNOWN") {
      super(message);
      this.name = "YtDlpError";
      this.code = code;
    }
  }
  return {
    YtDlp: {
      getVersion: () => Promise.resolve({ version: "test", package: "test" }),
      extractInfo: () => Promise.resolve({}),
      getFormats: () => Promise.resolve([]),
      download: () => Promise.reject(new Error("non utilise dans ce test")),
      cancel: () => Promise.resolve(false),
    },
    YtDlpError: ErreurYtDlp,
  };
});

const { YtDlpError } = jest.requireMock("ytdlp-react-native") as {
  YtDlpError: new (message: string, code?: string) => Error & { code: string };
};

const { Gestionnaire } = require("@/transfer/downloader") as typeof import("@/transfer/downloader");

type Interne = {
  echouerTransfert: (spec: unknown, erreur: unknown) => void;
  relancerDirect: (spec: unknown, erreur: unknown, force?: boolean) => void;
  siSourceStale: (erreur: unknown) => void;
  annulations: Set<string>;
  /** Titres dont le transfert passe par le moteur yt-dlp, hors DownloadManager. */
  directs: Set<string>;
  specs: Map<string, unknown>;
  relances: Map<string, { essai: number; prochain: number }>;
  relancesDirects: Map<string, unknown>;
  // `videoId` est indispensable : le minuteur de relance retrouve le titre par
  // `lister().find((s) => s.videoId === ...)`, et sort donc s'il est absent.
  suivis: Map<string, { videoId: string; etat: string; recus: number; total: number; raison?: string }>;
};

const specDe = (videoId: string) => ({ videoId, titre: "Un titre", direct: true });

describe("relance automatique des pannes transitoires", () => {
  let gestionnaire: InstanceType<typeof Gestionnaire>;
  let interne: Interne;

  beforeEach(() => {
    jest.useFakeTimers();
    gestionnaire = new Gestionnaire(() => {});
    interne = gestionnaire as unknown as Interne;
    interne.specs.set("abc123", specDe("abc123"));
    interne.suivis.set("abc123", { videoId: "abc123", etat: "en_cours", recus: 0, total: 0 });
    // Seuls les directs sont relances par `echouerTransfert` : c'est la
    // condition de la ligne qui suit l'appel, et il faut donc la remplir.
    interne.directs.add("abc123");
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("siSourceStale ne leve jamais, quelle que soit l'erreur", () => {
    // C'est la garantie qui manquait : une methode appelee sur le chemin d'un
    // echec ne doit pas pouvoir interrompre la relance qui suit.
    for (const erreur of [
      new YtDlpError("HTTP Error 403", "NETWORK_ERROR"),
      new YtDlpError("indisponible", "VIDEO_UNAVAILABLE"),
      new Error("n'importe quoi"),
      null,
      undefined,
      42,
    ]) {
      expect(() => interne.siSourceStale(erreur)).not.toThrow();
    }
  });

  it("echouerTransfert ne leve pas sur une panne reseau", () => {
    // Avant le correctif : TypeError ici, et rien apres n'etait execute.
    expect(() =>
      interne.echouerTransfert(specDe("abc123"), new YtDlpError("HTTP Error 403", "NETWORK_ERROR")),
    ).not.toThrow();
  });

  it("une panne reseau programme bien la relance", () => {
    interne.echouerTransfert(specDe("abc123"), new YtDlpError("HTTP Error 403", "NETWORK_ERROR"));
    expect(interne.relances.get("abc123")?.essai).toBe(1);
    expect(interne.relancesDirects.has("abc123")).toBe(true);
  });

  it("le compteur progresse a chaque panne, puis s'arrete", () => {
    // Le plafond vient de `DELAIS_RELANCE` (5 delais : 5 s, 15 s, 30 s, 1 min,
    // 2 min). On ne le devine pas : le test le relit dans le code.
    const source = readFileSync(
      path.join(__dirname, "..", "..", "transfer", "downloader.ts"),
      "utf8",
    );
    const nb = Number(/DELAIS_RELANCE = \[[^\]]*\]/.exec(source)![0].split(",").length);
    expect(nb).toBe(5);

    for (let essai = 1; essai <= nb; essai += 1) {
      interne.relancerDirect(specDe("abc123"), new YtDlpError("403", "NETWORK_ERROR"), true);
      expect(interne.relances.get("abc123")?.essai).toBe(essai);
    }
    // Une relance de plus : rien. Assieger la source serait pire que de rendre
    // la main a l'utilisateur.
    interne.relancerDirect(specDe("abc123"), new YtDlpError("403", "NETWORK_ERROR"), true);
    expect(interne.relances.get("abc123")?.essai).toBe(nb);
  });

  it("reconnait une panne deguisee en DOWNLOAD_FAILED", () => {
    // Le module natif ne classe pas toujours un 403 en NETWORK_ERROR : c'est
    // pourquoi la decision regarde aussi la forme du message.
    const erreur = new YtDlpError("unable to download: HTTP Error 403: Forbidden", "DOWNLOAD_FAILED");
    interne.echouerTransfert(specDe("abc123"), erreur);
    expect(interne.relances.get("abc123")).toBeDefined();
  });

  it("une panne definitive n'est pas relancee", () => {
    interne.relancerDirect(specDe("abc123"), new YtDlpError("Video unavailable", "VIDEO_UNAVAILABLE"));
    expect(interne.relances.get("abc123")).toBeUndefined();
  });

  it("la remise en file est bien declenchee apres le delai", () => {
    // On observe les etats PUBLIES plutot que l'etat final : le
    // telechargement etant simule en echec, la boucle se relance et le titre
    // finit a nouveau en `echoue`. Ce qui compte est que le passage par
    // `en_file` ait eu lieu — sans quoi la relance ne servirait a rien.
    const etats: string[] = [];
    const observateur = new Gestionnaire((suivis) => {
      const suivi = suivis.find((s) => s.videoId === "abc123");
      if (suivi) etats.push(suivi.etat);
    });
    const interne2 = observateur as unknown as Interne;
    interne2.specs.set("abc123", specDe("abc123"));
    interne2.suivis.set("abc123", { videoId: "abc123", etat: "en_cours", recus: 0, total: 0 });
    interne2.directs.add("abc123");

    interne2.echouerTransfert(specDe("abc123"), new YtDlpError("HTTP Error 403", "NETWORK_ERROR"));
    expect(etats).toContain("echoue");

    // On avance du SEUL premier delai. `runAllTimers` ne conviendrait pas : la
    // veille directe arme un `setInterval`, et chaque nouvel echec reprogramme
    // une relance — la boucle ne s'arreterait jamais.
    const source = readFileSync(
      path.join(__dirname, "..", "..", "transfer", "downloader.ts"),
      "utf8",
    );
    const premier = Number(
      /DELAIS_RELANCE = \[([\d,\s]+)\]/.exec(source)![1].split(",")[0].trim(),
    );
    jest.advanceTimersByTime(premier);
    // La sequence elle-meme est le message d'echec : on voit le titre passer
    // par `en_file` plutot que d'apprendre qu'il n'y est pas.
    expect(etats.join(" > ")).toContain("en_file");
  });

  it("une annulation pendant l'attente empeche la relance", () => {
    interne.annulations.add("abc123");
    interne.echouerTransfert(specDe("abc123"), new YtDlpError("HTTP Error 403", "NETWORK_ERROR"));
    jest.runAllTimers();
    // Le titre reste en echec : l'utilisateur a tranche, on ne passe pas outre.
    expect(interne.suivis.get("abc123")?.etat).toBe("echoue");
  });
});

/**
 * Le garde-fou qui interdit le retour du bug.
 *
 * Il lit les fichiers PUBLIES du module, pas le mock : c'est la seule facon de
 * constater qu'une API n'existe pas reellement. Si quelqu'un ajoute un
 * `AsyncFunction("updateYtDlp")` sans l'exposer — ou l'inverse — ce test le dit.
 */
describe("la facade publiee n'expose pas updateYtDlp", () => {
  const MODULE = path.join(__dirname, "..", "..", "..", "node_modules", "ytdlp-react-native");

  it("la facade JavaScript ne l'exporte pas", () => {
    const source = readFileSync(path.join(MODULE, "build", "YtDlp.js"), "utf8");
    expect(source).not.toMatch(/export\s*\{[^}]*updateYtDlp/);
    expect(source).not.toMatch(/function\s+updateYtDlp/);
  });

  it("les types ne la declarent pas", () => {
    const types = readFileSync(path.join(MODULE, "build", "YtDlp.d.ts"), "utf8");
    expect(types).not.toContain("updateYtDlp");
    // Les cinq seules fonctions publiees, et rien d'autre : c'est ce que le
    // typecheck de l'application verrait.
    const declarees = [...types.matchAll(/declare function (\w+)/g)].map((m) => m[1]).sort();
    expect(declarees).toEqual(["cancel", "download", "extractInfo", "getFormats", "getVersion"]);
  });

  it("le module Kotlin ne declare pas la fonction correspondante", () => {
    const kotlin = readFileSync(
      path.join(
        MODULE,
        "android",
        "src",
        "main",
        "java",
        "expo",
        "modules",
        "ytdlp",
        "ExpoYtDlpModule.kt",
      ),
      "utf8",
    );
    expect(kotlin).not.toContain('AsyncFunction("updateYtDlp")');
  });
});
