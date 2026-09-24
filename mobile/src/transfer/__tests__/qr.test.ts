/**
 * Décodage du code affiché par le bureau.
 *
 * Les cas qui comptent sont ceux qui ratent en vrai : un code d'un autre produit,
 * un code tronqué, une adresse sans jeton, une photo de code scannée deux fois.
 */
import { describe, expect, it } from "@jest/globals";

import { adresseAudio, adresseSession, lireCode } from "@/transfer/qr";

const VALIDE = "http://192.168.1.20:8040/t/a1b2c3?k=jeton-secret";

describe("code de transfert", () => {
  it("lit l'adresse affichée par le bureau", () => {
    const resultat = lireCode(VALIDE);
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.code.base).toBe("http://192.168.1.20:8040");
    expect(resultat.code.session).toBe("a1b2c3");
    expect(resultat.code.token).toBe("jeton-secret");
  });

  it("reconstruit les adresses de session et d'audio", () => {
    const resultat = lireCode(VALIDE);
    if (!resultat.ok) throw new Error("code refusé");
    expect(adresseSession(resultat.code)).toBe(VALIDE);
    expect(adresseAudio(resultat.code, "abcdEFGHijk")).toBe(
      "http://192.168.1.20:8040/t/a1b2c3/a/abcdEFGHijk?k=jeton-secret",
    );
  });

  it("tolère les guillemets et les espaces d'un copier-coller", () => {
    expect(lireCode(`  "${VALIDE}"  `).ok).toBe(true);
  });

  it("refuse un jeton manquant plutôt que de demander en vain", () => {
    const resultat = lireCode("http://192.168.1.20:8040/t/a1b2c3");
    expect(resultat.ok).toBe(false);
    if (resultat.ok) return;
    expect(resultat.erreur).toContain("incomplet");
  });

  it("refuse une adresse qui n'est pas un transfert NeuroBeats", () => {
    expect(lireCode("http://192.168.1.20:8040/playlist/3?k=x").ok).toBe(false);
    expect(lireCode("https://example.com").ok).toBe(false);
  });

  it("refuse un texte vide ou un protocole non http", () => {
    expect(lireCode("").ok).toBe(false);
    expect(lireCode("ftp://192.168.1.20/t/a?k=b").ok).toBe(false);
  });
});
