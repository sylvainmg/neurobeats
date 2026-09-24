/**
 * État de lecture partagé.
 *
 * Un magasin à sélecteurs plutôt qu'un contexte : la position change plusieurs
 * fois par seconde, et un contexte re-rendrait chaque écran à chaque battement.
 * Ici, seuls les composants qui lisent vraiment la position se redessinent.
 */
import { create } from "zustand";

/**
 * Mode de bouclage du bouton « lecture en boucle ».
 *
 * - "simple" : aucune boucle — la file s'arrête au dernier titre.
 * - "file" : quand le dernier titre de la file se termine, on repart de la tête.
 * - "titre" : le titre en cours se répète sans fin (repeat-one côté lecteur).
 *   Le bouton cyclique passe simple → file → titre → simple.
 */
export type ModeBoucle = "simple" | "file" | "titre";

export type PisteLecture = {
  id: string;
  titre: string;
  chaine: string;
  album: string;
  fichier: string;
  pochette: string | null;
  duree: number;
};

type Etat = {
  file: PisteLecture[];
  index: number;
  lecture: boolean;
  position: number;
  duree: number;
  pret: boolean;
  /** Message d'erreur de lecture : affiché tel quel à l'utilisateur. */
  probleme: string | null;
  /**
   * Dernier titre chargé, même après l'arrêt.
   *
   * Il sert à faire sortir le mini-lecteur en le montrant encore : une barre qui
   * disparaît d'un coup oblige l'œil à retrouver ses repères, alors qu'une barre
   * qui glisse vers le bas dit où elle est allée.
   */
  derniere: PisteLecture | null;
  /**
   * Lecture aléatoire : la file est alors une permutation, re-tirée à chaque
   * passe. L'ordre d'origine vit côté lecteur (`fileOriginale`).
   */
  melanger: boolean;
  /**
   * Mode de bouclage : "simple" (rien), "file" (fin de file → tête) ou
   * "titre" (le titre se répète). En aléatoire, la passe tourne de toute façon.
   */
  boucle: ModeBoucle;
  definirFile: (file: PisteLecture[], index: number) => void;
  /**
   * Remplace la file sans toucher au reste : utilisé par le mélange, qui change
   * l'ordre sans interrompre ni repartir d'une autre position.
   */
  majFile: (file: PisteLecture[]) => void;
  majMelange: (melanger: boolean) => void;
  majBoucle: (boucle: ModeBoucle) => void;
  /**
   * Repointe la lecture sur un autre index sans repartir à 0 : ramener la file à
   * son ordre d'origine ne doit pas interrompre le morceau en cours.
   */
  majRang: (index: number) => void;
  majIndex: (index: number) => void;
  majLecture: (lecture: boolean) => void;
  majPosition: (position: number, duree: number) => void;
  majPret: (pret: boolean) => void;
  majProbleme: (probleme: string | null) => void;
  vider: () => void;
};

export const useLecture = create<Etat>((set) => ({
  file: [],
  index: 0,
  lecture: false,
  position: 0,
  duree: 0,
  pret: false,
  probleme: null,
  derniere: null,
  melanger: false,
  boucle: "simple",
  definirFile: (file, index) =>
    set({ file, index, position: 0, derniere: file[index] ?? null }),
  majFile: (file) => set({ file }),
  majMelange: (melanger) => set({ melanger }),
  majBoucle: (boucle) => set({ boucle }),
  majRang: (index) => set({ index }),
  majIndex: (index) =>
    set((etat) => ({ index, position: 0, derniere: etat.file[index] ?? etat.derniere })),
  majLecture: (lecture) => set({ lecture }),
  majPosition: (position, duree) => set({ position, duree }),
  majPret: (pret) => set({ pret }),
  majProbleme: (probleme) => set({ probleme }),
  // Le dernier titre est conservé : c'est lui que le mini-lecteur emporte en
  // sortant.
  vider: () =>
    set({
      file: [],
      index: 0,
      lecture: false,
      position: 0,
      duree: 0,
      melanger: false,
      boucle: "simple",
    }),
}));
