/** Helpers d'affichage des titres (recherche, accueil). */

import { API_URL } from "@/lib/api";

/**
 * Qualités de jaquette YouTube, de la plus fiable à la meilleure qualité.
 *
 * `hqdefault` (4/3 letterboxé, ~480 utiles) et `mqdefault` (320×180) sont
 * servis en premier : ce sont les seules que toutes les vidéos fournissent.
 * Mesures sur l'historique réel : `sddefault`, `hq720` et `maxresdefault`
 * renvoient 404 en bloc sur certaines vidéos pourtant vivantes (ex. albums de
 * MMZ/Lomepal) — les tenter d'abord saturait la console du navigateur en 404
 * `/_next/image`. Elles restent en bonus quand présentes, pour les grandes
 * pochettes (la couverture HQ du backend prend le relais via `hq`).
 */
const THUMB_QUALITIES = [
  { quality: "hqdefault", letterbox: true },
  { quality: "sddefault", letterbox: true },
  { quality: "maxresdefault", letterbox: false },
  { quality: "hq720", letterbox: false },
  { quality: "mqdefault", letterbox: false },
] as const;

/** Zoom qui fait sortir du carré les bandes noires d'un 4/3 letterboxé. */
const LETTERBOX_ZOOM = 4 / 3;

/** Jaquette YouTube d'un titre (domaine autorisé dans next.config.ts). */
function thumbnailUrl(videoId: string, quality: string) {
  return `https://i.ytimg.com/vi/${videoId}/${quality}.jpg`;
}

/**
 * Jaquettes candidates d'un titre, du meilleur rendu au repli garanti.
 *
 * Le composant les essaie dans l'ordre. `zoom` agrandit l'image pour ne garder
 * que sa partie utile : une jaquette letterboxée ne contient que 75 % de hauteur
 * d'image réelle, et ses bandes noires se verraient dans une pochette carrée.
 */
export function thumbnailCandidates(videoId: string) {
  return THUMB_QUALITIES.map(({ quality, letterbox }) => ({
    src: thumbnailUrl(videoId, quality),
    zoom: letterbox ? LETTERBOX_ZOOM : 1,
  }));
}

/**
 * Largeur à annoncer dans `sizes` pour une pochette carrée de `box` px.
 *
 * La jaquette YouTube est en 16/9 : recadrée en carré par `object-cover`, c'est
 * donc sa hauteur qui doit couvrir la boîte. Or le navigateur choisit l'image
 * d'après la largeur annoncée : déclarer la boîte elle-même fait servir une
 * source trop courte, agrandie par le navigateur (~1.5× plus molle).
 */
export function coverSizes(box: number) {
  return `${Math.ceil((box * 16) / 9 / 4) * 4}px`;
}

/**
 * Pochette HQ servie par le backend, carree et deja dimensionnee en webp.
 *
 * Le serveur la genere a la demande : tant qu'elle n'est pas prete il repond 202,
 * et l'appelant garde la vignette YouTube — d'ou l'interet de la cascade
 * ci-dessus, qui n'est jamais fausse et s'affiche immediatement.
 */
export function coverHqUrl(videoId: string) {
  return `${API_URL}/api/covers/${videoId}`;
}

/** Durée « m:ss » (chaîne vide si inconnue). */
export function formatDuration(seconds?: number | null) {
  if (!seconds) return "";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
