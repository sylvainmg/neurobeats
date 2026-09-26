/**
 * Combien de temps un titre preparation peut attendre avant d'être abandonné.
 *
 * ## Pourquoi la durée du titre ne suffit pas
 *
 * Le bureau ne prépare que deux titres à la fois (`NEUROBEATS_PREPARED_WORKERS`),
 * et YouTube bride un téléchargement continu à ~35 Ko/s. Un titre de trois
 * minutes occupe donc un worker pendant deux minutes : sur une playlist de
 * vingt titres, le dernier ne commence qu'une vingtaine de minutes après le
 * scan.
 *
 * Abandonner un titre au bout de `90 s + 1,25 × durée` — soit ~5,5 min pour un
 * titre de trois minutes — revenait à l'abandonner **avant même qu'un worker
 * ne le prenne**. Le téléphone marquait « la préparation traîne », ne
 * retéléchargeait rien, et l'utilisateur devait rescanner pour obtenir le
 * reste : c'est le bug que ce module corrige.
 *
 * L'attente doit donc se mesurer depuis la **position dans la file**, pas
 * depuis la seule durée du titre : un titre en tête de file est servi tout de
 * suite, un titre en fin attend son tour.
 */

import type { PisteManifeste } from "@/transfer/manifest";

/** Workers côté bureau : le même réglage que `preparation.TRAVAUX`. */
export const WORKERS_BUREAU = 2;

/**
 * Temps de préparation d'un titre, mesuré : la bande passante observée
 * (~35 Ko/s) et la taille réelle du fichier audio donnent l'ordre de grandeur.
 * On reste large — c'est un plafond d'attente, pas une prédiction.
 *
 * En **millisecondes par octet** : sans le facteur 1000, un titre de 5 Mo
 * pesait 0,14 ms au lieu de 143 ms, et tous les budgets retombaient sur le
 * plancher de 90 s — le téléphone abandonnait alors la queue de la playlist
 * avant que le bureau n'ait fini la première vague.
 */
const MS_PAR_OCTET = 1000 / 35_000;

/** Plancher : une source lente a le temps de répondre au moins une fois. */
const PLANCHER_MS = 90_000;

/** Plafond : au-delà, on ne bloque pas l'utilisateur plus de 40 minutes. */
const PLAFOND_MS = 40 * 60_000;

/** Un lot ne peut pas promettre plus que 512 Mo de cache : au-delà, éviction. */
const TAILLE_MAX_TITRE = 24 * 1024 * 1024;

/**
 * Poids d'un titre dont on ignore tout : un audio de trois minutes typique.
 * Sert uniquement à estimer le temps d'attente quand le manifeste est muet sur
 * ce titre — pas à prédire sa préparation réelle.
 */
const POIDS_TITRE_INCONNU = 180 * 128_000;

/** Poids d'un titre : sa taille si on l'a, sinon sa durée × un débit plausible. */
function poidsDe(piste: PisteManifeste): number {
  if (piste.taille && piste.taille > 0) return Math.min(piste.taille, TAILLE_MAX_TITRE);
  return Math.max(0, piste.duree ?? 0) * 128_000;
}

/** Vrai tant qu'on ignore tout du titre : ni sa taille, ni sa durée. */
function inconnu(piste: PisteManifeste): boolean {
  return !(piste.taille && piste.taille > 0) && !(piste.duree && piste.duree > 0);
}

/**
 * Budget d'attente d'un titre, selon sa place dans la file.
 *
 * Le bureau servant la file avec `WORKERS_BUREAU` workers, un titre n'est pris
 * qu'après tous ceux qui le précèdent : son budget vaut donc le temps qu'il
 * faut pour **vider la file devant lui**, plus le sien. Un titre déjà marqué
 * « pret » ne prend pas de place (le bureau l'a en mémoire).
 *
 * On additionne donc le poids de TOUS les titres devant lui — et pas seulement
 * ceux de sa vague : ne totaliser que la dernière rendait le budget non
 * monotone (le titre 10 d'une playlist de 20 obtenait le même budget que le
 * titre 2), ce qui abandonnait la queue avant même qu'elle soit servie.
 *
 * Une marge de 30 % absorbe l'écart entre la bande passante observée et celle
 * du moment : on préfère attendre un peu trop que d'abandonner un titre qui
 * allait aboutir.
 *
 * @param piste    Le titre concerné (sa durée et sa taille servent de bornes).
 * @param file     Les titres encore en attente, DANS L'ORDRE où le bureau les
 *                 prendra. L'ordre est celui du manifeste, qui reflète déjà la
 *                 file d'attente du backend.
 * @param position L'index du titre dans cette file.
 */
export function budgetPreparation(
  piste: PisteManifeste,
  file: PisteManifeste[],
  position: number,
): number {
  const devant = file
    .slice(0, Math.max(0, position))
    .filter((autre) => autre.etat !== "pret");

  // Poids de la file, ou poids moyen si le manifeste est muet : un titre sans
  // durée ni taille ne doit pas peser 0 (il serait abandonné au bout du
  // plancher de 90 s, avant qu'un worker ne le prenne).
  const poids = (autre: PisteManifeste) =>
    inconnu(autre) ? POIDS_TITRE_INCONNU : poidsDe(autre);

  const Attente =
    devant.reduce((total, autre) => total + poids(autre) * MS_PAR_OCTET, 0) +
    poids(piste) * MS_PAR_OCTET;

  return Math.min(PLAFOND_MS, Math.max(PLANCHER_MS, Attente * 1.3));
}
/**
 * Les titres qui attendent encore, dans l'ordre où le bureau les prendra.
 *
 * Le manifeste donne l'état de chaque titre, mais pas sa place dans la file
 * d'attente interne du backend. On ne la devine pas : on ne garde que l'ordre
 * d'annonce, qui est celui de la playlist — c'est déjà de quoi calculer un
 * budget honnête, et le pire cas est d'attendre plus que nécessaire.
 */
export function fileAAttendre(manifeste: PisteManifeste[]): PisteManifeste[] {
  return manifeste.filter((piste) => piste.etat !== "pret");
}
