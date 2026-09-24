/**
 * Bornage des seeks : un `seekTo` qui atterrit sur la fin fait reboucler le
 * moteur sur la même source au lieu de passer au suivant. La cible doit donc
 * rester à distance de la fin, sans jamais dépasser le début non plus.
 */
import { describe, expect, it } from "@jest/globals";

import { bornerCible } from "@/playback/cible";

describe("bornerCible", () => {
  it("laisse une cible dans le morceau inchangée", () => {
    expect(bornerCible(42, 180)).toBe(42);
  });

  it("ramène une cible à la fin avant la marge", () => {
    expect(bornerCible(180, 180)).toBe(179.7);
    expect(bornerCible(179.9, 180)).toBe(179.7);
  });

  it("ne dépasse jamais la durée réelle même si la cible est plus grande", () => {
    expect(bornerCible(300, 180)).toBe(179.7);
  });

  it("clamp vers le début une cible négative", () => {
    expect(bornerCible(-12, 180)).toBe(0);
  });

  it("renvoie 0 quand la durée est inconnue ou vide", () => {
    expect(bornerCible(42, 0)).toBe(0);
    expect(bornerCible(42, Number.NaN)).toBe(0);
  });

  it("traite un morceau plus court que la marge comme un seek au début", () => {
    expect(bornerCible(0.2, 0.2)).toBe(0);
  });
});