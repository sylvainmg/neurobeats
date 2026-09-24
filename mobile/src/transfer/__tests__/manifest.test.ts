/**
 * Contrat de transfert : le parsing tolère ce qui manque et refuse net ce qu'il
 * ne sait pas lire. Ces cas sont ceux qu'on rencontre réellement : un bureau plus
 * ancien, une session expirée, un code d'une autre génération.
 */
import { describe, expect, it } from "@jest/globals";

import { analyserManifeste, resoudreUrl } from "@/transfer/manifest";

const COMPLET = JSON.stringify({
  version: 1,
  playlist: "Rap FR",
  playlist_id: "pl-1",
  expire_dans: 300,
  debit_estime: 16000,
  pistes: [
    {
      video_id: "abcdEFGHijk",
      titre: "Titre un",
      chaine: "Artiste un",
      duree: 154,
      etat: "pret",
      taille: 4111714,
      format: "m4a",
      url: "/t/s1/a/abcdEFGHijk?k=jeton",
      pochette: "/t/s1/c/abcdEFGHijk?k=jeton",
    },
  ],
});

describe("manifeste du bureau", () => {
  it("lit un manifeste complet et absolutise les adresses", () => {
    const resultat = analyserManifeste(COMPLET, "http://192.168.1.20:8040");
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    const piste = resultat.manifeste.pistes[0];
    expect(resultat.manifeste.playlist).toBe("Rap FR");
    expect(piste.url).toBe("http://192.168.1.20:8040/t/s1/a/abcdEFGHijk?k=jeton");
    expect(piste.pochette).toBe("http://192.168.1.20:8040/t/s1/c/abcdEFGHijk?k=jeton");
    expect(piste.taille).toBe(4111714);
    expect(piste.format).toBe("m4a");
  });

  it("accepte un bureau plus ancien, sans taille ni pochette ni format", () => {
    const ancien = JSON.stringify({
      version: 1,
      playlist: "Vieux",
      playlist_id: "pl-vieux",
      pistes: [{ video_id: "abcdEFGHijk", titre: "T", chaine: "A", duree: 100, url: "/t/s/a/x" }],
    });
    const resultat = analyserManifeste(ancien, "http://10.0.0.2:8040");
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    const piste = resultat.manifeste.pistes[0];
    expect(piste.taille).toBeNull();
    expect(piste.pochette).toBeNull();
    expect(piste.format).toBe("m4a");
    expect(piste.etat).toBe("pret");
  });

  it("refuse une génération plus récente avec une phrase utile", () => {
    const resultat = analyserManifeste(JSON.stringify({ version: 9, pistes: [] }));
    expect(resultat.ok).toBe(false);
    if (resultat.ok) return;
    expect(resultat.erreur).toContain("plus récente");
  });

  it("remonte le message du bureau quand la session est expirée", () => {
    const resultat = analyserManifeste(
      JSON.stringify({ error: "Session inconnue ou expiree." }),
      "http://x",
    );
    expect(resultat.ok).toBe(false);
    if (resultat.ok) return;
    expect(resultat.erreur).toBe("Session inconnue ou expiree.");
  });

  it("refuse une playlist vide et une réponse illisible", () => {
    expect(analyserManifeste(JSON.stringify({ version: 1, pistes: [] })).ok).toBe(false);
    expect(analyserManifeste("pas du json").ok).toBe(false);
  });

  it("ignore une piste sans identifiant plutôt que de la laisser passer", () => {
    const bancal = JSON.stringify({
      version: 1,
      pistes: [{ titre: "sans identifiant" }, { video_id: "okokokokoko", titre: "bonne" }],
    });
    const resultat = analyserManifeste(bancal, "http://x");
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.manifeste.pistes).toHaveLength(1);
  });

  it("ne touche pas une adresse déjà absolue", () => {
    expect(resoudreUrl("http://a:1", "https://b:2/x")).toBe("https://b:2/x");
  });
});
