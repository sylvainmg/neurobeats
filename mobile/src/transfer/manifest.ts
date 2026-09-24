/**
 * Contrat de transfert : lecture tolérante de ce que le bureau annonce.
 *
 * Le manifeste du bureau est la seule source : le téléphone ne devine rien. Le
 * parsing accepte les champs optionnels (`taille`, `pochette`, `etat` absents sur
 * un bureau plus ancien) mais refuse net une version qu'il ne sait pas lire —
 * mieux vaut une phrase claire qu'un import à moitié fait.
 */
export const VERSION_SUPPORTEE = 1;

export type EtatManifeste = "pret" | "preparation" | "erreur";

export type PisteManifeste = {
  video_id: string;
  titre: string;
  chaine: string;
  duree: number;
  etat: EtatManifeste;
  taille: number | null;
  format: string;
  url: string;
  pochette: string | null;
};

export type Manifeste = {
  version: number;
  playlist: string;
  playlist_id: string;
  expire_dans: number;
  debit_estime: number;
  pistes: PisteManifeste[];
};

export type ResultatManifeste =
  | { ok: true; manifeste: Manifeste }
  | { ok: false; erreur: string };

const ETATS: EtatManifeste[] = ["pret", "preparation", "erreur"];

function entier(valeur: unknown, defaut = 0): number {
  const nombre = typeof valeur === "number" ? valeur : Number(valeur);
  return Number.isFinite(nombre) ? Math.round(nombre) : defaut;
}

function texteDe(valeur: unknown): string {
  return typeof valeur === "string" ? valeur : "";
}

/** Absolutise un chemin annoncé par le bureau (`/t/...`) sur l'adresse de session. */
export function resoudreUrl(base: string, chemin: string): string {
  if (!chemin) return "";
  if (/^https?:\/\//i.test(chemin)) return chemin;
  return `${base.replace(/\/+$/, "")}${chemin.startsWith("/") ? "" : "/"}${chemin}`;
}

export function analyserManifeste(contenu: string, base = ""): ResultatManifeste {
  let brut: unknown;
  try {
    brut = JSON.parse(contenu);
  } catch {
    return { ok: false, erreur: "Réponse illisible de l'ordinateur." };
  }
  if (!brut || typeof brut !== "object") {
    return { ok: false, erreur: "Réponse vide de l'ordinateur." };
  }
  const objet = brut as Record<string, unknown>;
  // Le bureau répond `error` quand la session est expirée ou le jeton refusé.
  if (typeof objet.error === "string" && objet.error) {
    return { ok: false, erreur: objet.error };
  }
  const version = entier(objet.version, 0);
  if (version > VERSION_SUPPORTEE) {
    return {
      ok: false,
      erreur: `Ce code vient d'une version plus récente (${version}) : mets à jour l'application.`,
    };
  }
  const brutes = Array.isArray(objet.pistes) ? objet.pistes : [];
  const pistes: PisteManifeste[] = [];
  for (const element of brutes) {
    if (!element || typeof element !== "object") continue;
    const piste = element as Record<string, unknown>;
    const video_id = texteDe(piste.video_id);
    if (!video_id) continue;
    const etat = ETATS.includes(piste.etat as EtatManifeste)
      ? (piste.etat as EtatManifeste)
      : "pret";
    pistes.push({
      video_id,
      titre: texteDe(piste.titre) || video_id,
      chaine: texteDe(piste.chaine),
      duree: entier(piste.duree),
      etat,
      taille: Number.isFinite(Number(piste.taille)) ? entier(piste.taille) : null,
      format: texteDe(piste.format) || "m4a",
      url: resoudreUrl(base, texteDe(piste.url)),
      pochette: piste.pochette ? resoudreUrl(base, texteDe(piste.pochette)) : null,
    });
  }
  if (pistes.length === 0) {
    return { ok: false, erreur: "Cette playlist ne contient aucun titre." };
  }
  return {
    ok: true,
    manifeste: {
      version,
      playlist: texteDe(objet.playlist) || "Playlist",
      playlist_id: texteDe(objet.playlist_id),
      expire_dans: entier(objet.expire_dans),
      debit_estime: entier(objet.debit_estime, 16000),
      pistes,
    },
  };
}
