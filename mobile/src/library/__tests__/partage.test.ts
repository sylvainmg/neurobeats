/**
 * Le partage ne promet que des fichiers présents.
 *
 * La fonction reçoit les URIs que le module natif a confirmés : c'est elle qui
 * décide ce qui part et ce qui est refusé. Les lignes sans fichier (jamais
 * transférées) et celles dont le fichier a disparu sont des indisponibles.
 */
import { describe, expect, it } from "@jest/globals";

import type { Piste } from "@/db/repos";
import { separerPartageables } from "@/library/partage";

let compteur = 0;
function piste(partiel: Partial<Piste> = {}): Piste {
  compteur += 1;
  return {
    id: compteur,
    video_id: "vid-1",
    playlist_id: null,
    titre: "Titre",
    chaine: "Artiste",
    album: "Album",
    duree: 120,
    taille: 0,
    fichier: null,
    pochette: null,
    etat: "absent",
    rang: null,
    ajoute_le: 0,
    ecoute_le: null,
    ...partiel,
  };
}

describe("séparer les partageables", () => {
  it("partage les titres dont le fichier est présent", () => {
    const a = piste({ video_id: "a", fichier: "file:///a", etat: "chez_toi" });
    const b = piste({ video_id: "b", fichier: "file:///b", etat: "chez_toi" });
    const { partageables, indisponibles } = separerPartageables(
      [a, b],
      new Set(["file:///a", "file:///b"]),
    );
    expect(partageables).toEqual([a, b]);
    expect(indisponibles).toEqual([]);
  });

  it("refuse un titre jamais transféré, faute de fichier", () => {
    const manquant = piste({ video_id: "m", fichier: null, etat: "absent" });
    const { partageables, indisponibles } = separerPartageables(
      [manquant],
      new Set(),
    );
    expect(partageables).toEqual([]);
    expect(indisponibles).toEqual([manquant]);
  });

  it("refuse un fichier disparu : « chez toi » sans présence réelle", () => {
    const fantome = piste({ video_id: "f", fichier: "file:///perdu", etat: "chez_toi" });
    const { partageables, indisponibles } = separerPartageables(
      [fantome],
      new Set(), // le module natif n'a rien trouvé sur le disque
    );
    expect(partageables).toEqual([]);
    expect(indisponibles).toEqual([fantome]);
  });

  it("ne partage que les présents quand la sélection est mêlée", () => {
    const la = piste({ video_id: "la", fichier: "file:///la", etat: "chez_toi" });
    const manque = piste({ video_id: "manque", fichier: null, etat: "absent" });
    const { partageables, indisponibles } = separerPartageables(
      [la, manque],
      new Set(["file:///la"]),
    );
    expect(partageables).toEqual([la]);
    expect(indisponibles).toEqual([manque]);
  });
});