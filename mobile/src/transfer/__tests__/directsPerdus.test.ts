/**
 * Les traces des directs achevés mais non rapatriés : deux règles simples — un
 * titre n'occupe qu'une trace, et l'effacer le retire vraiment.
 */
import { describe, expect, it } from "@jest/globals";

import {
  FICHIER_DIRECTS_PERDUS,
  fusionnerDirectPerdu,
  retirerDirectPerdu,
  type DirectPerdu,
} from "@/transfer/directsPerdus";

const direct = (videoId: string): DirectPerdu => ({
  videoId,
  source: `/transfert/${videoId}.m4a`,
  fichier: `${videoId}.m4a`,
});

describe("fusionnerDirectPerdu", () => {
  it("ajoute une trace inconnue", () => {
    expect(fusionnerDirectPerdu([], direct("v1"))).toEqual([direct("v1")]);
  });

  it("remplace la trace du même titre au lieu d'en empiler deux", () => {
    const avecV2 = fusionnerDirectPerdu([direct("v1")], direct("v2"));
    const remplacee = fusionnerDirectPerdu(avecV2, { ...direct("v2"), taille: 42 });
    expect(remplacee).toEqual([direct("v1"), { ...direct("v2"), taille: 42 }]);
    expect(remplacee.filter((e) => e.videoId === "v2")).toHaveLength(1);
  });
});

describe("retirerDirectPerdu", () => {
  it("retire le titre demandé et laisse les autres", () => {
    const entrees = fusionnerDirectPerdu(fusionnerDirectPerdu([], direct("v1")), direct("v2"));
    expect(retirerDirectPerdu(entrees, "v1")).toEqual([direct("v2")]);
  });

  it("est sans effet sur une liste vide", () => {
    expect(retirerDirectPerdu([], "v1")).toEqual([]);
  });
});

describe("FICHIER_DIRECTS_PERDUS", () => {
  it("est un nom de fichier stable", () => {
    expect(FICHIER_DIRECTS_PERDUS).toMatch(/\.json$/);
  });
});