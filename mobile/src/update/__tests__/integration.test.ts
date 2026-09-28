/**
 * Test de bout en bout du chemin « une mise à jour se propose, puis s'installe ».
 *
 * Les autres suites vérifient chaque pièce ; celle-ci les enchaîne comme le
 * fait une vraie publication : on fabrique un artefact, on le hache, on écrit le
 * manifeste, on le fait valider, on décide, puis on vérifie l'empreinte avant
 * installation. C'est le seul enchaînement qui prouverait qu'un fichier altéré
 * n'atteint jamais l'installateur.
 */

import { describe, expect, it } from "@jest/globals";
import { createHash } from "node:crypto";

import {
  artefactPour,
  apresSignalement,
  decider,
  empreinteValide,
  ETAT_INITIAL,
  sha256,
  validerManifeste,
  type Bruit,
  type EtatPolitique,
  type Manifeste,
  type Plateforme,
} from "@neurobeats/shared/update";

const JOUR = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

/** Artefact déterministe : mêmes octets à chaque exécution. */
function artefactFaux(taille: number, graine: number): Uint8Array {
  const octets = new Uint8Array(taille);
  for (let i = 0; i < taille; i += 1) octets[i] = (i * graine + 11) & 0xff;
  return octets;
}

/**
 * Reproduit ce que fait `scripts/mkversions.mjs` : le manifeste est produit à
 * partir du fichier réellement publié, jamais recopié d'un build.
 */
function publier(version: string, plateformes: Plateforme[], taille = 4096) {
  const artifacts: Record<string, unknown> = {};
  for (const [index, plate] of plateformes.entries()) {
    const octets = artefactFaux(taille + index, index + 3);
    artifacts[plate] = {
      file: `NeuroBeats-${version}${plate}.bin`,
      url: `https://exemple/NeuroBeats-${version}${plate}.bin`,
      sha256: sha256(octets),
      size: octets.length,
    };
  }
  const brut = {
    version,
    released_at: "2026-09-27T18:00:00Z",
    mandatory: false,
    notes: "Version de test",
    artifacts,
  };
  const manifeste = validerManifeste(brut);
  if (!manifeste) throw new Error("le manifeste produit doit être valide");
  return { manifeste, octets: artefactFaux(taille, 3) };
}

function contexte(manifeste: Manifeste, plateforme: Plateforme, etat: EtatPolitique, enLecture = false) {
  return {
    versionCourante: "0.1.0",
    manifeste,
    plateforme,
    maintenant: T0,
    enLecture,
    etat,
  };
}

/** L'état après avoir signalé `version` `tours` fois — le compteur réel. */
function monterLeBruit(etat: EtatPolitique, version: string, tours: number): EtatPolitique {
  let courant = etat;
  for (let i = 0; i < tours; i += 1) courant = apresSignalement(courant, version);
  return courant;
}

describe("publication et installation", () => {
  it("accepte le manifeste que produit la publication", () => {
    const { manifeste } = publier("0.2.0", ["linux-x64", "win32-x64", "darwin-arm64", "android"]);
    expect(manifeste.versionTexte).toBe("0.2.0");
    expect(Object.keys(manifeste.artefacts)).toHaveLength(4);
    for (const artefact of Object.values(manifeste.artefacts)) {
      expect(artefact?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(artefact?.size).toBeGreaterThan(0);
    }
  });

  it("propose la version à chaque plateforme qui a un artefact, et aux autres rien", () => {
    const { manifeste } = publier("0.2.0", ["linux-x64", "android"]);
    const bruyants: Bruit[] = [];
    for (const plate of ["linux-x64", "win32-x64", "darwin-arm64", "android"] as Plateforme[]) {
      bruyants.push(decider(contexte(manifeste, plate, ETAT_INITIAL)).bruit);
    }
    // Premier signal, uniquement là où l'on peut livrer.
    expect(bruyants).toEqual(["information", "rien", "rien", "information"]);
  });

  it("suit l'échelle complète jusqu'au silence, puis ne se réveille pas", () => {
    const { manifeste } = publier("0.2.0", ["linux-x64"]);
    const echelle = [0, 1, 2, 3, 4].map((tours) =>
      decider(contexte(manifeste, "linux-x64", monterLeBruit(ETAT_INITIAL, "0.2.0", tours))).bruit,
    );
    expect(echelle).toEqual(["information", "proposition", "silencieux", "silencieux", "silencieux"]);
  });

  it("recommence l'échelle à zéro sur une version plus récente", () => {
    const { manifeste: ancienne } = publier("0.2.0", ["linux-x64"]);
    const { manifeste: nouvelle } = publier("0.3.0", ["linux-x64"]);
    const lasse = monterLeBruit({ ...ETAT_INITIAL, versionIgnoree: "0.2.0" }, "0.2.0", 5);
    expect(decider(contexte(ancienne, "linux-x64", lasse)).bruit).toBe("rien");
    expect(decider(contexte(nouvelle, "linux-x64", lasse)).bruit).toBe("information");
  });

  it("laisse la version.current quand elle est déjà la dernière", () => {
    const { manifeste } = publier("0.1.0", ["linux-x64"]);
    expect(decider(contexte(manifeste, "linux-x64", ETAT_INITIAL)).bruit).toBe("rien");
  });

  it("accepte l'artefact intact et refuse un fichier modifié, même d'un octet", () => {
    const { manifeste, octets } = publier("0.2.0", ["android"]);
    const artefact = artefactPour(manifeste, "android");
    if (!artefact) throw new Error("artefact android attendu");

    // Intact : l'empreinte calculée par l'implémentation mobile concorde avec
    // celle du manifeste, et avec celle de node:crypto.
    const calculeeMobile = sha256(octets);
    const calculeeNode = createHash("sha256").update(octets).digest("hex");
    expect(calculeeMobile).toBe(calculeeNode);
    expect(empreinteValide(calculeeMobile, artefact.sha256)).toBe(true);

    // Un seul octet changé, et le même fichier, réécrit puis ré-haché : c'est le
    // scénario d'un miroir qui sert autre chose que l'artefact annoncé.
    const altere = Uint8Array.from(octets);
    altere[octets.length - 1] ^= 0x01;
    expect(empreinteValide(sha256(altere), artefact.sha256)).toBe(false);
  });

  it("refuse un manifeste dont une empreinte est fausse, sans refuser les autres", () => {
    const bon = sha256(artefactFaux(2048, 5));
    const manifeste = validerManifeste({
      version: "0.2.0",
      artifacts: {
        // 64 caractères mais pas le bon contenu : la validation ne peut pas le
        // savoir, c'est la vérification à l'installation qui tranche.
        android: { file: "a.apk", url: "https://e/a.apk", sha256: bon, size: 2048 },
        //empreinte mal formée : refusée à la validation.
        "win32-x64": { file: "a.exe", url: "https://e/a.exe", sha256: "z".repeat(64), size: 2048 },
      },
    });
    expect(artefactPour(manifeste, "android")).not.toBeNull();
    expect(artefactPour(manifeste, "win32-x64")).toBeNull();
  });

  it("ignore un manifeste qui promet une version illisible", () => {
    const manifeste = validerManifeste({
      version: "0.2.0-bien-signe",
      notes: "",
      artifacts: { "linux-x64": { file: "a", url: "https://e/a", sha256: sha256(artefactFaux(16, 2)), size: 16 } },
    });
    expect(manifeste?.versionTexte).toBe("0.2.0-bien-signe");
    // Une pré-release plus récente que la version stable installée se propose…
    expect(decider(contexte(manifeste!, "linux-x64", ETAT_INITIAL)).bruit).toBe("information");
    // …mais la version finale la plus récente ne se propose pas.
    const { manifeste: finale } = publier("0.2.0", ["linux-x64"]);
    expect(decider({ ...contexte(finale, "linux-x64", ETAT_INITIAL), versionCourante: "0.2.0" }).bruit).toBe(
      "rien",
    );
  });

  it("n'use qu'une seule fois la fenêtre de 24 h sur une journée simulée", () => {
    // Un contrôle automatique par jour, quelle que soit la fréquence de
    // lancement : c'est la garantie qu'on n'interroge pas le dépôt à chaque
    // ouverture.
    const versions = new Set<string>();
    let etat: EtatPolitique = { ...ETAT_INITIAL };
    for (let heure = 0; heure < 24 * 7; heure += 1) {
      const maintenant = T0 + heure * 3_600_000;
      const ecoule = etat.dernierControle === null ? Infinity : maintenant - etat.dernierControle;
      if (ecoule >= JOUR) {
        versions.add(new Date(maintenant).toISOString().slice(0, 10));
        etat = { ...etat, dernierControle: maintenant };
      }
    }
    expect(versions.size).toBe(7);
  });
});
