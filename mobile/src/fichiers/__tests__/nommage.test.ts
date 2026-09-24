/**
 * Noms de fichiers transférés.
 *
 * Ce qui se vérifie ici n'est pas cosmétique : un nom refusé par le système, ou
 * une URI invalide, fait échouer le transfert d'un titre — et l'échec ne dit pas
 * pourquoi. Les cas qui comptent sont donc les titres réels : crochets des vidéos
 * officielles, barres obliques, deux-points, séparateurs en surnombre.
 */
import { describe, expect, it } from "@jest/globals";

import { nommerFichier } from "@/fichiers/nommage";

const ID = "SLM6pBL7L-o";

describe("nom de fichier d'un transfert", () => {
  it("retire les crochets, qui rendent le chemin illégal", () => {
    const nom = nommerFichier(
      "Lil Uzi Vert - What You Saying - [Official Music Video] - LIL UZI VERT",
      "m4a",
      ID,
    );

    expect(nom).toBe(
      "Lil Uzi Vert - What You Saying - Official Music Video - LIL UZI VERT.m4a",
    );
    expect(nom).not.toMatch(/[[\]#%?*"<>|]/);
  });

  it("garde les apostrophes et les accents d'un titre français", () => {
    expect(nommerFichier("GAZO - CÉLINE 3x", "m4a", ID)).toBe("GAZO - CÉLINE 3x.m4a");
    expect(nommerFichier("Lomepal - Trop beau (live)", "m4a", ID)).toBe(
      "Lomepal - Trop beau (live).m4a",
    );
  });

  it("remplace les séparateurs de chemin plutôt que de les laisser traverser", () => {
    const nom = nommerFichier("AC/DC - Back: in Black", "m4a", ID);

    expect(nom).toBe("AC DC - Back in Black.m4a");
  });

  it("resserre les espaces laissés par les caractères retirés", () => {
    expect(nommerFichier("Titre   [x]   suite", "m4a", ID)).toBe("Titre x suite.m4a");
  });

  it("borne la longueur, que le système refuserait au-delà", () => {
    const nom = nommerFichier("a ".repeat(200), "m4a", ID);
    const nomSansExtension = nom.replace(/\.m4a$/, "");

    expect(nomSansExtension.length).toBeLessThanOrEqual(90);
  });

  it("se rabat sur l'identifiant quand il ne reste rien", () => {
    expect(nommerFichier("???", "m4a", ID)).toBe(`${ID}.m4a`);
    expect(nommerFichier("", "m4a", ID)).toBe(`${ID}.m4a`);
  });

  it("conserve l'extension annoncée par le bureau", () => {
    expect(nommerFichier("Titre", "webm", ID)).toBe("Titre.webm");
  });
});
