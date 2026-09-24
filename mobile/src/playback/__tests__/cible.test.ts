/**
 * Sauts de ±15 s : dépasser la fin doit passer au titre suivant, sortir par le
 * début doit repartir du précédent. Le bornage muet (rester sur le même titre)
 * fait travailler la barre alors que le lecteur n'avance pas.
 */
import { describe, expect, it } from "@jest/globals";

import {
  apresDernier,
  gardeFinInitial,
  majGardeFin,
  modeBoucleSuivant,
  planifierAvance,
  planifierRecul,
} from "@/playback/cible";

describe("planifierRecul", () => {
  it("recule dans le titre quand la marge reste positive", () => {
    expect(planifierRecul(120)).toEqual({ type: "seek", cible: 105 });
    expect(planifierRecul(16)).toEqual({ type: "seek", cible: 1 });
  });

  it("borne au début du morceau, sans jamais changer de titre", () => {
    expect(planifierRecul(15)).toEqual({ type: "seek", cible: 0 });
    expect(planifierRecul(5)).toEqual({ type: "seek", cible: 0 });
    expect(planifierRecul(0)).toEqual({ type: "seek", cible: 0 });
  });
});

describe("apresDernier", () => {
  it("repart en tête en lecture aléatoire, sans qu'aucune boucle soit demandée", () => {
    expect(apresDernier(12, true, "simple")).toBe(0);
  });

  it("repart en tête en boucle de file", () => {
    expect(apresDernier(3, false, "file")).toBe(0);
  });

  it("repart en tête quand la passe aléatoire est en boucle de file", () => {
    expect(apresDernier(7, true, "file")).toBe(0);
  });

  it("le mode titre répète le morceau avant la fin : la file ne décide rien", () => {
    expect(apresDernier(3, false, "titre")).toBeNull();
  });

  it("s'arrête sans mode, même en fin de file", () => {
    expect(apresDernier(5, false, "simple")).toBeNull();
  });

  it("une file vide ne boucle jamais, quoi qu'il arrive", () => {
    expect(apresDernier(0, true, "file")).toBeNull();
    expect(apresDernier(0, false, "simple")).toBeNull();
    expect(apresDernier(0, false, "titre")).toBeNull();
  });
});

describe("modeBoucleSuivant", () => {
  it("fait tourner le bouton : simple → file → titre → simple", () => {
    expect(modeBoucleSuivant("simple")).toBe("file");
    expect(modeBoucleSuivant("file")).toBe("titre");
    expect(modeBoucleSuivant("titre")).toBe("simple");
  });
});

describe("majGardeFin", () => {
  it("la première fin d'une source stable est consommée", () => {
    const sortie = majGardeFin({ sourceStable: true, finConsommee: false }, true);
    expect(sortie.consommer).toBe(true);
    expect(sortie.prochain).toEqual({ sourceStable: true, finConsommee: true });
  });

  it("une fin déjà consommée n'est pas rejouée", () => {
    const sortie = majGardeFin({ sourceStable: true, finConsommee: true }, true);
    expect(sortie.consommer).toBe(false);
    expect(sortie.prochain).toEqual({ sourceStable: true, finConsommee: true });
  });

  it("une fin pendant le chargement d'une source est ignorée", () => {
    const sortie = majGardeFin({ sourceStable: false, finConsommee: false }, true);
    expect(sortie.consommer).toBe(false);
    expect(sortie.prochain).toEqual({ sourceStable: false, finConsommee: false });
  });

  it("un tick normal réarme la garde pour la source suivante", () => {
    const sortie = majGardeFin({ sourceStable: false, finConsommee: false }, false);
    expect(sortie.consommer).toBe(false);
    expect(sortie.prochain).toEqual({ sourceStable: true, finConsommee: false });
  });

  it("la fin du dernier titre suit un cycle : consommée puis réarmée", () => {
    const fin = majGardeFin({ sourceStable: true, finConsommee: false }, true);
    expect(fin.consommer).toBe(true);
    const pendant = majGardeFin(fin.prochain, true);
    expect(pendant.consommer).toBe(false);
    const apresLoad = majGardeFin(pendant.prochain, false);
    expect(apresLoad.prochain).toEqual({ sourceStable: true, finConsommee: false });
  });

  it("l'état initial ne consomme rien tant qu'aucun tick stable n'est passé", () => {
    expect(majGardeFin(gardeFinInitial, true).consommer).toBe(false);
    expect(majGardeFin(gardeFinInitial, false).prochain.sourceStable).toBe(true);
  });
});

describe("planifierAvance", () => {
  it("avance dans le titre quand la marge reste positive", () => {
    expect(planifierAvance(120, 240, false)).toEqual({ type: "seek", cible: 135 });
  });

  it("dépasser la fin démarre le titre suivant", () => {
    expect(planifierAvance(230, 240, false)).toEqual({ type: "saut", valeur: 1 });
    expect(planifierAvance(239, 240, false)).toEqual({ type: "saut", valeur: 1 });
  });

  it("sur le dernier titre, vise la fin pour s'arrêter", () => {
    expect(planifierAvance(230, 240, true)).toEqual({ type: "seek", cible: 240 });
  });

  it("durée inconnue : simple seek, pas de saut à l'aveugle", () => {
    expect(planifierAvance(5, 0, false)).toEqual({ type: "seek", cible: 20 });
  });
});