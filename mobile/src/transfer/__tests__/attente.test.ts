/**
 * Budget d'attente d'un titre en préparation côté téléphone.
 *
 * Régression couverte : un titre dont le manifeste ne dit rien (ni taille, ni
 * durée — le cas ordinaire d'une playlist dont le bureau n'a jamais joué les
 * titres) pesait 0 octets, donc son budget retombait sur le plancher de 90 s.
 * Avec deux workers et ~35 Ko/s, la queue de la playlist n'est jamais servie
 * dans ce délai : le téléphone marquait « la préparation traîne », ne
 * retéléchargait rien, et il fallait rescanner pour obtenir le reste.
 */
import { describe, expect, it } from "@jest/globals";

import { budgetPreparation, fileAAttendre, WORKERS_BUREAU } from "@/transfer/attente";
import type { PisteManifeste } from "@/transfer/manifest";

function piste(partiel: Partial<PisteManifeste> & { video_id: string }): PisteManifeste {
  return {
    titre: "T",
    chaine: "C",
    duree: 0,
    etat: "preparation",
    taille: null,
    ...partiel,
  } as PisteManifeste;
}

describe("budgetPreparation", () => {
  it("ne retombe pas sur le plancher quand le titre est inconnu", () => {
    const inconnu = piste({ video_id: "a" });
    const budget = budgetPreparation(inconnu, [inconnu], 0);
    // Avant correctif : 90 s exactement (le poids 0 × 1.3, borné par le plancher).
    expect(budget).toBeGreaterThan(90_000);
  });

  it("donne un budget à un titre inconnu situé en fin de playlist", () => {
    // 20 titres tous inconnus : le dernier ne peut pas être servi en 90 s.
    const file = Array.from({ length: 20 }, (_, i) => piste({ video_id: `v${i}` }));
    const dernier = file[file.length - 1];
    expect(budgetPreparation(dernier, file, 19)).toBeGreaterThan(90_000);
  });

  it("accorde plus de temps à un titre de fin de file qu'à un titre de tête", () => {
    const tete = piste({ video_id: "tete", duree: 180, taille: 5_000_000 });
    const fin = piste({ video_id: "fin", duree: 180, taille: 5_000_000 });
    const file = [tete, fin];
    expect(budgetPreparation(fin, file, 1)).toBeGreaterThan(
      budgetPreparation(tete, file, 0),
    );
  });

  it("ignore les titres déjà prêts dans le calcul de la file d'attente", () => {
    // Un titre « pret » ne prend pas de place : il ne doit pas gonfler le budget.
    const pret = piste({ video_id: "pret", etat: "pret", duree: 600, taille: 40_000_000 });
    const cible = piste({ video_id: "cible", duree: 180, taille: 5_000_000 });
    const file = [pret, cible];
    const avecPret = budgetPreparation(cible, file, 1);
    const sansPret = budgetPreparation(cible, [cible], 0);
    expect(avecPret).toBe(sansPret);
  });

  it("reste borné par le plafond même pour une file énorme", () => {
    const file = Array.from({ length: 500 }, (_, i) =>
      piste({ video_id: `g${i}`, duree: 600, taille: 24 * 1024 * 1024 }),
    );
    const dernier = file[file.length - 1];
    expect(budgetPreparation(dernier, file, 499)).toBeLessThanOrEqual(40 * 60_000);
  });

  it("refuse un budget négatif ou aberrant sur une position hors file", () => {
    const seul = piste({ video_id: "seul", duree: 180, taille: 5_000_000 });
    expect(budgetPreparation(seul, [seul], -1)).toBeGreaterThan(0);
  });

  it("croît strictement avec la position dans la file", () => {
    // Propriété centrale : plus un titre est loin dans la file, plus il doit
    // avoir le temps d'attendre. L'ancien calcul ne	totalisait que la
    // dernière vague de workers, ce qui rendait le budget NON monotone — le
    // titre 10 d'une playlist de 20 se faisait abandonner avec le même délai
    // que le titre 2, bien avant que le bureau ne serve la queue.
    const file = Array.from({ length: 20 }, (_, i) =>
      piste({ video_id: `m${i}`, duree: 180, taille: 5_000_000 }),
    );
    const budgets = file.map((p, i) => budgetPreparation(p, file, i));
    for (let i = 1; i < budgets.length; i += 1) {
      expect(budgets[i]).toBeGreaterThanOrEqual(budgets[i - 1]);
    }
    // Et l'écart doit être réel, pas deux valeurs arrondies au plancher.
    expect(budgets[19]).toBeGreaterThan(budgets[0] * 5);
  });
});

describe("fileAAttendre", () => {
  it("ne garde que les titres pas encore prêts, dans l'ordre du manifeste", () => {
    const file = fileAAttendre([
      piste({ video_id: "a" }),
      piste({ video_id: "b", etat: "pret", taille: 1_000_000 }),
      piste({ video_id: "c" }),
    ]);
    expect(file.map((p) => p.video_id)).toEqual(["a", "c"]);
  });

  it("sait compter les vagues de workers du bureau", () => {
    // Deux workers : 5 titres à attendre = 3 vagues, donc le dernier attend
    // bien deux titres devant lui au lieu d'être servi tout de suite.
    expect(WORKERS_BUREAU).toBe(2);
    const file = Array.from({ length: 5 }, (_, i) => piste({ video_id: `w${i}` }));
    expect(budgetPreparation(file[4], file, 4)).toBeGreaterThan(
      budgetPreparation(file[0], file, 0),
    );
  });
});
