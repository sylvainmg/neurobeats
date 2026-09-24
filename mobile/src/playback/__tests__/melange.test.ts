/**
 * La permutation du lecteur aléatoire : sans remise jusqu'au dernier titre.
 */
import { describe, expect, it } from "@jest/globals";

import { melanger, tirageEnTete } from "@/playback/melange";
import type { PisteLecture } from "@/playback/store";

function titre(id: string, titre = `Titre ${id}`): PisteLecture {
  return { id, titre, chaine: "Chaine", album: "Album", fichier: `file://${id}`, pochette: null, duree: 180 };
}

describe("melanger", () => {
  it("retourne une permutation sans perte ni ajout", () => {
    const file = [titre("a"), titre("b"), titre("c"), titre("d"), titre("e")];
    const ordre = melanger(file, () => 0.42);
    expect(ordre.map((p) => p.id).sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(ordre).toHaveLength(5);
  });

  it("ne tire aucun titre deux fois", () => {
    const file = Array.from({ length: 20 }, (_, i) => titre(String(i)));
    const ordre = melanger(file, () => 0.5);
    const ids = ordre.map((p) => p.id);
    expect(new Set(ids).size).toBe(20);
  });

  it("laisse une file d'un seul titre inchangée", () => {
    const file = [titre("a")];
    expect(melanger(file, () => 0.999).map((p) => p.id)).toEqual(["a"]);
  });

  it("mélange de façon déterministe pour un alea fixe", () => {
    const file = [titre("a"), titre("b"), titre("c"), titre("d")];
    const ordre = melanger(file, () => 0);
    expect(ordre.map((p) => p.id)).toEqual(["b", "c", "d", "a"]);
  });

  it("ne mute pas la file d'origine", () => {
    const file = [titre("a"), titre("b"), titre("c")];
    melanger(file, () => 0.37);
    expect(file.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("retourne une copie même quand rien ne bouge", () => {
    const file = [titre("a"), titre("b")];
    const ordre = melanger(file, () => 1);
    expect(ordre).not.toBe(file);
  });
});

describe("tirageEnTete", () => {
  it("garde le titre choisi en tête et tire le reste sans remise", () => {
    const file = [titre("a"), titre("b"), titre("c"), titre("d")];
    const ordre = tirageEnTete(file, titre("a"), () => 0);
    expect(ordre[0].id).toBe("a");
    expect(ordre.map((p) => p.id).sort()).toEqual(["a", "b", "c", "d"]);
    expect(ordre[0].id).not.toBe(ordre[1].id);
  });

  it("ne réordonne jamais la file d'origine (indexation préservée)", () => {
    const file = [titre("a"), titre("b"), titre("c"), titre("d"), titre("e")];
    const avant = file.map((p) => p.id);
    tirageEnTete(file, titre("c"), () => 0.61);
    expect(file.map((p) => p.id)).toEqual(avant);
  });

  it("une file d'un seul titre ne bouge pas", () => {
    const file = [titre("a")];
    expect(tirageEnTete(file, titre("a")).map((p) => p.id)).toEqual(["a"]);
  });
});