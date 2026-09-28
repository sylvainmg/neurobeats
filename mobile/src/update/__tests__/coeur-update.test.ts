/**
 * Tests du cœur de mise à jour.
 *
 * Ils vivent dans `mobile/src` parce que c'est le seul paquetage du dépôt doté
 * d'un runner (jest) : les tester ailleurs obligerait à installer une seconde
 * chaîne de test pour six fichiers purs. Ce qu'ils couvrent reste entièrement
 * dans `shared/`, et le desktop en bénéficie sans les exécuter — d'où l'intérêt
 * de garder ce module sans dépendance : il ne peut pas se mettre à échouer
 * differently selon qui l'importe.
 */

import { describe, expect, it } from "@jest/globals";

import {
  artefactPour,
  comparerVersions,
  decider,
  estPlusRecent,
  ETAT_INITIAL,
  parseVersion,
  planifierControle,
  empreinteValide,
  sha256,
  sha256Texte,
  validerManifeste,
  apresControle,
  apresSignalement,
  ignorerVersion,
  CONFIGURATION_PAR_DEFAUT,
  type EtatPolitique,
  type Manifeste,
  type Plateforme,
} from "@neurobeats/shared/update";

const JOUR = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

function empreinteValideLongue(): string {
  return "a".repeat(64);
}

function manifeste(bruts: Record<string, unknown> = {}): Manifeste {
  const valide = validerManifeste({
    version: "0.2.0",
    released_at: "2026-09-27T18:00:00Z",
    notes: "Corrections de stability",
    artifacts: {
      "linux-x64": { file: "n.AppImage", url: "https://exemple/n.AppImage", sha256: empreinteValideLongue(), size: 10 },
      android: { file: "n.apk", url: "https://exemple/n.apk", sha256: empreinteValideLongue(), size: 20 },
    },
    ...bruts,
  });
  if (!valide) throw new Error("manifeste de test invalide");
  return valide;
}

function contexte(overrides: Partial<Parameters<typeof decider>[0]> = {}) {
  return {
    versionCourante: "0.1.0",
    manifeste: manifeste(),
    plateforme: "linux-x64" as Plateforme,
    maintenant: T0,
    enLecture: false,
    etat: { ...ETAT_INITIAL },
    ...overrides,
  };
}

// ------------------------------------------------------------------ versions

describe("version", () => {
  it("analyse une version simple et une pré-release", () => {
    expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: "" });
    expect(parseVersion("1.2.3-beta.2")?.prerelease).toBe("beta.2");
  });

  it("refuse ce qui n'est pas une version stricte", () => {
    for (const invalide of ["v1.2.3", "1.2", "1.2.3.4", "", "abc", null, 12, undefined]) {
      expect(parseVersion(invalide)).toBeNull();
    }
  });

  it("ordonne major, minor puis patch", () => {
    const cmp = (a: string, b: string) => comparerVersions(parseVersion(a)!, parseVersion(b)!);
    expect(cmp("1.0.0", "0.9.9")).toBeGreaterThan(0);
    expect(cmp("0.2.0", "0.1.9")).toBeGreaterThan(0);
    expect(cmp("0.1.1", "0.1.0")).toBeGreaterThan(0);
    expect(cmp("0.1.0", "0.1.0")).toBe(0);
    expect(cmp("0.1.0", "0.2.0")).toBeLessThan(0);
  });

  it("place une pré-release avant la version finale, et suit l'ordre semver", () => {
    const cmp = (a: string, b: string) => comparerVersions(parseVersion(a)!, parseVersion(b)!);
    expect(cmp("1.2.3-beta", "1.2.3")).toBeLessThan(0);
    expect(cmp("1.2.3-alpha", "1.2.3-beta")).toBeLessThan(0);
    expect(cmp("1.2.3-alpha.1", "1.2.3-alpha.2")).toBeLessThan(0);
    // Un identifiant numérique est plus grand qu'un alphanumérique.
    expect(cmp("1.2.3-1", "1.2.3-alpha")).toBeGreaterThan(0);
  });

  it("ne propose une mise à jour que si la version est strictement plus récente", () => {
    expect(estPlusRecent("0.2.0", "0.1.0")).toBe(true);
    expect(estPlusRecent("0.1.0", "0.1.0")).toBe(false);
    expect(estPlusRecent("0.0.9", "0.1.0")).toBe(false);
    // Un doubt sur la version courante ne doit jamais produire une mise à jour.
    expect(estPlusRecent("0.2.0", "bête")).toBe(false);
  });
});

// ------------------------------------------------------------------ manifeste

describe("manifeste", () => {
  it("valide un manifeste complet", () => {
    const m = validerManifeste({
      version: "1.0.0",
      released_at: "2026-01-01T00:00:00Z",
      notes: "n",
      artifacts: {
        "win32-x64": { file: "a.exe", url: "https://e/a.exe", sha256: "b".repeat(64), size: 5 },
      },
    });
    expect(m?.versionTexte).toBe("1.0.0");
    expect(artefactPour(m!, "win32-x64")?.file).toBe("a.exe");
  });

  it("rejette un manifeste sans version exploitable", () => {
    expect(validerManifeste(null)).toBeNull();
    expect(validerManifeste({})).toBeNull();
    expect(validerManifeste({ version: "pas-une-version" })).toBeNull();
    expect(validerManifeste({ version: 2 })).toBeNull();
  });

  it("accepte une empreinte en majuscules et la normalise", () => {
    const m = validerManifeste({
      version: "1.0.0",
      artifacts: { android: { file: "a", url: "https://e/a", sha256: "C".repeat(64), size: 1 } },
    });
    expect(artefactPour(m!, "android")?.sha256).toBe("c".repeat(64));
  });

  it("abandonne un artefact à l'empreinte mal formée sans perdre les autres", () => {
    const m = validerManifeste({
      version: "1.0.0",
      artifacts: {
        // 63 caractères : refusé.
        "win32-x64": { file: "a", url: "https://e/a", sha256: "c".repeat(63), size: 1 },
        // URL absente : refusé.
        "darwin-arm64": { file: "a", sha256: "c".repeat(64), size: 1 },
        // Taille négative : refusée.
        "linux-x64": { file: "a", url: "https://e/a", sha256: "c".repeat(64), size: -1 },
        // Seul celui-ci est conforme.
        android: { file: "a.apk", url: "https://e/a.apk", sha256: "c".repeat(64), size: 7 },
      },
    });
    expect(artefactPour(m!, "win32-x64")).toBeNull();
    expect(artefactPour(m!, "darwin-arm64")).toBeNull();
    expect(artefactPour(m!, "linux-x64")).toBeNull();
    expect(artefactPour(m!, "android")?.size).toBe(7);
  });
});

// ------------------------------------------------------------------ sha256

describe("sha256", () => {
  it("reproduit les vecteurs officiels NIST", () => {
    // Vecteurs publiés dans FIPS 180-4 / examples de l'implémentation de référence.
    expect(sha256Texte("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Texte("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Texte("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("gère le passage d'un bloc à l'autre", () => {
    // 56 octets : le padding tombe exactement sur la frontière de bloc, ce qui
    // est le cas le plus facile à rater.
    expect(sha256Texte("a".repeat(56))).toBe(
      "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a",
    );
    // 64 octets : un bloc plein, plus le bloc de padding.
    expect(sha256Texte("a".repeat(64))).toBe(
      "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb",
    );
  });

  it("produit 64 caractères hexadécimaux, quel que soit l'entrée", () => {
    for (const taille of [0, 1, 63, 64, 65, 1000]) {
      expect(sha256(new Uint8Array(taille))).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("accorde son empreinte à celle de node:crypto sur une charge réelle", () => {
    // La comparaison inter-implémentations est la vraie garantie : c'est elle
    // qui détecte une divergence entre le SHA du mobile et celui du desktop.
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    const charge = new Uint8Array(200_000);
    for (let i = 0; i < charge.length; i += 1) charge[i] = (i * 31 + 7) & 0xff;
    const attendu = createHash("sha256").update(charge).digest("hex");
    expect(sha256(charge)).toBe(attendu);
  });

  it("ne dérape sur aucune frontière de bloc", () => {
    // Régression : le nombre de blocs ignorait les 8 octets de longueur, ce qui
    // ne se voyait qu'aux longueurs qui remplissent le dernier bloc (56 et
    // voisines). On balaie donc la frontière entière, plus deux blocs pleins.
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    const reference = (octets: Uint8Array) => createHash("sha256").update(octets).digest("hex");
    for (let taille = 0; taille <= 70; taille += 1) {
      const charge = new Uint8Array(taille);
      for (let i = 0; i < taille; i += 1) charge[i] = (i * 17 + 3) & 0xff;
      expect(sha256(charge)).toBe(reference(charge));
    }
    for (const taille of [127, 128, 129, 191, 192, 255, 256]) {
      const charge = new Uint8Array(taille).fill(0xa5);
      expect(sha256(charge)).toBe(reference(charge));
    }
  });
});

// ------------------------------------------------------------------ intégrité

describe("intégrité", () => {
  it("accepte une empreinte identique quelle que soit la casse", () => {
    expect(empreinteValide("AB".repeat(32), "ab".repeat(32))).toBe(true);
    expect(empreinteValide(`  ${"a".repeat(64)}  `, "a".repeat(64))).toBe(true);
  });

  it("refuse un écart, une longueur différente ou un type inattendu", () => {
    expect(empreinteValide("a".repeat(64), "b".repeat(64))).toBe(false);
    expect(empreinteValide("a".repeat(63), "a".repeat(64))).toBe(false);
    expect(empreinteValide(null, "a".repeat(64))).toBe(false);
    expect(empreinteValide(123, "a".repeat(64))).toBe(false);
  });
});

// ------------------------------------------------------------------ planning

describe("planification du contrôle", () => {
  it("contrôle au premier lancement", () => {
    expect(planifierControle(ETAT_INITIAL, T0).doitController).toBe(true);
  });

  it("n'y revient pas avant 24 h, puis recontrôle", () => {
    const etat: EtatPolitique = { ...ETAT_INITIAL, dernierControle: T0 };
    const tropTot = planifierControle(etat, T0 + 60_000);
    expect(tropTot.doitController).toBe(false);
    expect(tropTot.dansMs).toBeGreaterThan(0);
    expect(planifierControle(etat, T0 + JOUR).doitController).toBe(true);
  });

  it("double l'attente à chaque échec, sans dépasser le plafond", () => {
    const base: EtatPolitique = { ...ETAT_INITIAL, dernierControle: T0 };
    const e1 = planifierControle({ ...base, echecsConsecutifs: 1 }, T0 + 1000);
    const e2 = planifierControle({ ...base, echecsConsecutifs: 2 }, T0 + 1000);
    const e3 = planifierControle({ ...base, echecsConsecutifs: 3 }, T0 + 1000);
    expect(e2.dansMs).toBeGreaterThan(e1.dansMs);
    expect(e3.dansMs).toBeGreaterThan(e2.dansMs);

    const sature = planifierControle({ ...base, echecsConsecutifs: 40 }, T0 + 1000);
    expect(sature.dansMs).toBeLessThanOrEqual(CONFIGURATION_PAR_DEFAUT.delaiMaximumEchecMs);
  });

  it("remet le compteur d'échecs à zéro après un succès", () => {
    const etat = apresControle({ ...ETAT_INITIAL, echecsConsecutifs: 5 }, T0, true);
    expect(etat.echecsConsecutifs).toBe(0);
    expect(etat.dernierControle).toBe(T0);
    // Et le rythme normal reprend.
    expect(planifierControle(etat, T0 + JOUR).doitController).toBe(true);
  });
});

// ------------------------------------------------------------------ décision

describe("décision de signalement", () => {
  it("ne dit rien quand il n'y a rien à dire", () => {
    expect(decider(contexte({ manifeste: null })).bruit).toBe("rien");
    expect(decider(contexte({ versionCourante: "0.2.0" })).bruit).toBe("rien");
  });

  it("se tait si la plateforme n'a pas d'artefact, plutôt que de promettre", () => {
    const d = decider(contexte({ plateforme: "darwin-arm64" }));
    expect(d.bruit).toBe("rien");
    expect(d.raison).toContain("plate-forme");
  });

  it("monte en volume puis se taît : c'est la règle anti-harcèlement", () => {
    expect(decider(contexte()).bruit).toBe("information");

    const uneFois = apresSignalement(ETAT_INITIAL, "0.2.0");
    expect(decider(contexte({ etat: uneFois })).bruit).toBe("proposition");

    const deuxFois = apresSignalement(uneFois, "0.2.0");
    expect(decider(contexte({ etat: deuxFois })).bruit).toBe("silencieux");

    const troisFois = apresSignalement(deuxFois, "0.2.0");
    expect(decider(contexte({ etat: troisFois })).bruit).toBe("silencieux");
  });

  it("n'interrompt jamais une lecture", () => {
    for (const etat of [ETAT_INITIAL, apresSignalement(ETAT_INITIAL, "0.2.0")]) {
      expect(decider(contexte({ etat, enLecture: true })).bruit).toBe("silencieux");
    }
  });

  it("respecte un report en cours", () => {
    const etat: EtatPolitique = { ...ETAT_INITIAL, reporteeJusqua: T0 + JOUR };
    expect(decider(contexte({ etat, maintenant: T0 })).bruit).toBe("silencieux");
    // Une fois l'échéance passée, la parole redevient possible.
    expect(decider(contexte({ etat, maintenant: T0 + JOUR })).bruit).toBe("information");
  });

  it("ne repropose jamais une version ignorée, même après redémarrage", () => {
    const etat = ignorerVersion(ETAT_INITIAL, "0.2.0");
    expect(decider(contexte({ etat })).bruit).toBe("rien");
    // Un état relu depuis le disque se comporte pareil.
    const relu: EtatPolitique = JSON.parse(JSON.stringify(etat));
    expect(decider(contexte({ etat: relu, maintenant: T0 + 30 * JOUR })).bruit).toBe("rien");
  });

  it("redonne la parole quand une version plus récente arrive", () => {
    const etat = ignorerVersion({ ...ETAT_INITIAL, nbSignaux: 9, versionSignalee: "0.2.0" }, "0.2.0");
    const nouveau = manifeste({ version: "0.3.0" });
    expect(decider(contexte({ etat, manifeste: nouveau })).bruit).toBe("information");
  });

  it("court-circuite report et cadence pour une mise à jour obligatoire", () => {
    const reporte: EtatPolitique = { ...ETAT_INITIAL, reporteeJusqua: T0 + JOUR };
    const obligatoire = manifeste({ version: "0.2.0", mandatory: true });
    expect(decider(contexte({ etat: reporte, manifeste: obligatoire })).bruit).toBe("obligatoire");
  });
});
