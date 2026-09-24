/**
 * Ce que chaque playlist annonce dans la bibliothèque.
 *
 * Ce qui se vérifie ici, c'est la phrase que lit l'utilisateur : le nombre de
 * titres. Le reste de l'état est montré, pas dit — la pastille de
 * synchronisation quand tout est là, le compte manquant sinon.
 */
import { describe, expect, it } from "@jest/globals";

import { resumeDePlaylist } from "@/library/playlists";

describe("résumé d'une playlist", () => {
  it("annonce le nombre de titres", () => {
    expect(resumeDePlaylist(10)).toBe("10 titres");
  });

  it("n'affiche pas ce qui manque : la pastille le montre", () => {
    expect(resumeDePlaylist(3)).toBe("3 titres");
  });

  it("accorde le singulier", () => {
    expect(resumeDePlaylist(1)).toBe("1 titre");
  });
});