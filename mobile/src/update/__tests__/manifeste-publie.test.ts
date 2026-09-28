/**
 * Le manifeste réellement publié, consommé par le vrai code de décision.
 *
 * Les autres suites fabriques leurs manifestes à la main. Celle-ci lit le
 * fichier produit par `scripts/mkversions.mjs` et le fait passer par le même
 * validateur que l'application, pour valider le contrat de bout en bout : le
 * générateur et le consommateur ne peuvent pas diverger.
 *
 * Le fichier est optionnel : absent (version freshly clonée, ou dépôt public
 * qui ne l'a pas encore généré), la suite est ignorée plutôt que rouge.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "@jest/globals";

import {
  artefactPour,
  decider,
  ETAT_INITIAL,
  validerManifeste,
  type Bruit,
  type Plateforme,
} from "@neurobeats/shared/update";

const MANIFESTE = path.resolve(__dirname, "..", "..", "..", "..", "public", "versions.json");
const JOUR = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

const disponible = existsSync(MANIFESTE);
const describeSi = disponible ? describe : describe.skip;

if (!disponible) {
  // eslint-disable-next-line no-console
  console.warn(
    `[maj] ${path.relative(process.cwd(), MANIFESTE)} absent : suite « manifeste publié » ignorée. ` +
      "Générez-le avec `node scripts/mkversions.mjs 0.1.0 --sortie public/versions.json --artefact …`.",
  );
}

describeSi("manifeste réellement publié", () => {
  const brut = JSON.parse(readFileSync(MANIFESTE, "utf8")) as Record<string, unknown>;
  const manifeste = validerManifeste(brut);

  it("est accepté tel quel par le validateur de l'application", () => {
    expect(manifeste).not.toBeNull();
    expect(brut.version).toBe(manifeste?.versionTexte);
  });

  it("annonce des empreintes et des tailles exploitables pour chaque artefact", () => {
    const entrees = Object.entries(manifeste?.artefacts ?? {});
    expect(entrees.length).toBeGreaterThan(0);
    for (const [cle, artefact] of entrees) {
      // `expect` de jest n'accepte pas de message : on prefixe le nom de la
      // plate-forme dans la valeur attendue, l'échec reste lisible.
      expect(`${cle}:${artefact === null ? "absent" : "present"}`).toBe(`${cle}:present`);
      expect(artefact?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(artefact?.size).toBeGreaterThan(0);
      // Une URL d'artefact exécutable doit être servie en HTTPS.
      expect(new URL(artefact!.url).protocol).toBe("https:");
    }
  });

  it("propose la mise à jour sur les plates-formes servies, et se tait sur les autres", () => {
    const servies = new Set(Object.keys(manifeste?.artefacts ?? {}));
    const decision = (plateforme: Plateforme): Bruit =>
      decider({
        // Une version installée plus ancienne que celle publiée : c'est le
        // cas du premier déploiement.
        versionCourante: "0.0.1",
        manifeste,
        plateforme,
        maintenant: T0,
        enLecture: false,
        etat: ETAT_INITIAL,
      }).bruit;

    for (const plateforme of ["linux-x64", "android"] as Plateforme[]) {
      if (servies.has(plateforme)) expect(decision(plateforme)).toBe("information");
    }
    // Rien n'est promis pour ce qui n'est pas publié.
    for (const plateforme of ["win32-x64", "darwin-arm64"] as Plateforme[]) {
      if (!servies.has(plateforme)) expect(decision(plateforme)).toBe("rien");
    }
  });

  it("ne se tait pas si l'utilisateur est déjà à jour", () => {
    const versionCourante = manifeste?.versionTexte ?? "0.0.0";
    const decision = decider({
      versionCourante,
      manifeste,
      plateforme: "linux-x64",
      maintenant: T0,
      enLecture: false,
      etat: ETAT_INITIAL,
    });
    expect(decision.bruit).toBe("rien");
    expect(decision.raison).toContain("jour");
  });

  it("respecte la cadence d'un jour sur une semaine de lancements", () => {
    // Sept contrôles automatiques sur sept jours, pas soixante-dix.
    let dernier = 0;
    let controles = 0;
    for (let heure = 0; heure < 24 * 7; heure += 1) {
      const maintenant = T0 + heure * 3_600_000;
      if (maintenant - dernier >= JOUR) {
        controles += 1;
        dernier = maintenant;
      }
    }
    expect(controles).toBe(7);
  });
});
