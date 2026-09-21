/** Helpers d'affichage des titres (recherche, accueil). */

import { API_URL } from "@/lib/api";

/**
 * Qualités de jaquette YouTube, de la meilleure à la plus disponible.
 *
 * `maxresdefault` et `hq720` (1280×720, 16/9 net) manquent sur une partie des
 * vidéos — y compris des vidéos HD, pour lesquelles YouTube publie alors son
 * og:image en `hqdefault`. `sddefault` (640×480) prend le relais : c'est la
 * meilleure source restante, avec deux fois plus de lignes utiles que
 * `mqdefault` (320×180), mais son image 16/9 est letterboxée dans du 4/3.
 */
const THUMB_QUALITIES = [
  { quality: "maxresdefault", letterbox: false },
  { quality: "hq720", letterbox: false },
  { quality: "sddefault", letterbox: true },
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
