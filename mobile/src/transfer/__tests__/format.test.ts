/**
 * Formatage des mesures : c'est ce que l'utilisateur lit pour décider.
 * Une unité fausse et la promesse chiffrée ne vaut plus rien.
 */
import { describe, expect, it } from "@jest/globals";

import {
  estimerPoids,
  formaterDuree,
  formaterPourcent,
  pluraliser,
} from "@/transfer/format";

describe("estimation", () => {
  it("estime un poids à partir de la durée et du débit annoncé", () => {
    // 154 s à 16 kbit/s ≈ 308 ko
    expect(estimerPoids(154, 16000)).toBe(308000);
    expect(estimerPoids(0, 16000)).toBe(0);
  });
});

describe("durées", () => {
  it("écrit minutes et heures", () => {
    expect(formaterDuree(154)).toBe("2:34");
    expect(formaterDuree(3725)).toBe("1:02:05");
  });

  it("écrit un tiret sur une durée absente", () => {
    expect(formaterDuree(0)).toBe("—");
    expect(formaterDuree(null)).toBe("—");
  });
});

describe("progression et pluriel", () => {
  it("borne la progression entre 0 et 100 %", () => {
    expect(formaterPourcent(0.42)).toBe("42 %");
    expect(formaterPourcent(1.7)).toBe("100 %");
    expect(formaterPourcent(-1)).toBe("0 %");
  });

  it("accorde le pluriel, y compris les exceptions", () => {
    expect(pluraliser(0, "titre")).toBe("0 titre");
    expect(pluraliser(1, "titre")).toBe("1 titre");
    expect(pluraliser(3, "titre")).toBe("3 titres");
    expect(pluraliser(2, "transfert")).toBe("2 transferts");
  });
});
