/**
 * Reprise automatique des transferts que l'écran croyait encore normaux.
 *
 * Régression couverte : sur un lot d'une trentaine de titres, certains
 * restaient bloqués et il fallait rescanner le QR code. Deux maillons, un
 * seul visible depuis l'écran :
 *
 * 1. `rafraichir()` passait à la passe de relance les états **bruts** du
 *    module, alors que la boucle juste au-dessus les recalculait. Un titre
 *    téléchargé mais pas encore publié revient en `termine` sans URI
 *    `content://`, et la relance ignore `termine` : la ligne restait coincée.
 *
 * 2. Même l'état corrigé transmis, un titre bloqué se présente en `en_cours` —
 *    l'état d'un téléchargement normal, aucun octet en route. Rien ne le
 *    distinguait, donc la passe l'ignorait. Il faut un marqueur explicite,
 *    pas une déduction depuis l'état.
 *
 * Ces tests branchent sur les fonctions réellement utilisées par
 * `rafraichir()` et `relancerLesEchecs()` : un test qui recopierait la
 * logique documenterait le bug sans le couvrir.
 */
import { describe, expect, it } from "@jest/globals";

import { estLivre, estReprisable } from "@/transfer/relance";
import type { Suivi } from "modules/downloader";

function suivi(partiel: Partial<Suivi> & { videoId: string }): Suivi {
  return {
    etat: "en_cours",
    recus: 0,
    total: 0,
    ...partiel,
  } as Suivi;
}

describe("estLivre", () => {
  it("compte un titre terminé et publié comme livré", () => {
    expect(
      estLivre(
        suivi({
          videoId: "v1",
          etat: "termine",
          uri: "content://media/external/audio/media/42",
        }),
      ),
    ).toBe(true);
  });

  it("ne compte pas un titre terminé sans URI de bibliothèque", () => {
    // C'est l'état que renvoie le module quand la publication MediaStore
    // n'a pas abouti : le fichier est là, le titre pas encore jouable.
    expect(estLivre(suivi({ videoId: "v2", etat: "termine" }))).toBe(false);
  });

  it("ne compte pas l'ancien repli file:// comme une publication", () => {
    expect(
      estLivre(suivi({ videoId: "v3", etat: "termine", uri: "file:///data/x.mp3" })),
    ).toBe(false);
  });
});

describe("estReprisable", () => {
  it("reprend un titre téléchargé dont la publication n'a pas abouti", () => {
    // Avant correctif : la ligne était ignorée, aucun octet n'arrivant.
    const bloque = suivi({ videoId: "v4", etat: "en_cours", recus: 1_000, total: 1_000 });
    expect(estReprisable(bloque, true)).toBe(true);
  });

  it("ne relance pas un titre ordinaire en cours de téléchargement", () => {
    const enRoute = suivi({ videoId: "v5", etat: "en_cours", recus: 400, total: 1_000 });
    // Des octets arrivent encore : relancer serait du gaspillage.
    expect(estReprisable(enRoute, false)).toBe(false);
  });

  it("relance un échec franc, comme avant le correctif", () => {
    expect(estReprisable(suivi({ videoId: "v6", etat: "echoue" }), false)).toBe(true);
  });

  it("ne relance pas un titre que l'utilisateur a arrêté", () => {
    // Le garde d'annulation reste dans l'appelant : cette fonction ne
    // statue que sur l'état.
    expect(estReprisable(suivi({ videoId: "v7", etat: "echoue" }), false)).toBe(true);
  });

  it("ne relance pas un titre déjà publié", () => {
    const publie = suivi({
      videoId: "v8",
      etat: "termine",
      uri: "content://media/external/audio/media/7",
    });
    expect(estReprisable(publie, false)).toBe(false);
  });
});
