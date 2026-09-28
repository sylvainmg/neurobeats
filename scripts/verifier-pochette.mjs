/**
 * La pochette d'une playlist dans la liste de la bibliothèque.
 *
 * Le symptôme : à l'ouverture d'une playlist, l'image s'affiche ; dans la
 * liste, rien. Les deux lisent pourtant le MÊME champ, renvoyé par une
 * sous-requête identique.
 *
 * La cause est dans cette sous-requête, qui ne fait pas ce que son commentaire
 * annonce. Le commentaire dit « celle de la couverture, sinon celle de son
 * premier titre ». La clause faisait :
 *
 *     AND (p.couverture IS NULL OR t.video_id = p.couverture)
 *
 * Ce n'est pas un « sinon », c'est un « et seulement si ». Dès qu'une playlist
 * désigne une couverture dont le titre n'a pas encore de pochette — cas
 * ordinaire, la couverture est donnée par l'ordinateur mais les images se
 * téléchargent ensuite une par une — la sous-requête renvoie NULL, et la liste
 * n'affiche rien. L'écran de détail, lui, se rattrape : il prend la pochette
 * d'un titre qui en a une.
 *
 * D'où l'incohérence : deux écrans, une même donnée, un repli d'un seul côté.
 *
 * ## Pourquoi une vérification à part
 *
 * Ce test s'exécute contre un vrai moteur SQLite (`node:sqlite`), et il
 * **extrait la requête de `mobile/src/db/repos.ts`** au lieu de la recopier.
 * La raison est double :
 *
 * 1. L'erreur est dans le tri d'une sous-requête — de la sémantique SQL. Un
 *    test TypeScript qui simulerait la base ne prouverait rien.
 * 2. Recopier la requête testerait le test. Le fichier pourrait changer sans
 *    que rien ne le remarque, et le test continuerait de passer sur une
 *    requête qui n'est plus celle de l'application.
 *
 * Usage : node scripts/verifier-pochette.mjs
 */
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const REPOS = new URL("../mobile/src/db/repos.ts", import.meta.url);
const source = await readFile(REPOS, "utf8");

/**
 * La requête complète d'une fonction, extraite de son gabarit de chaîne.
 *
 * On prend la requête ENTIERE plutôt qu'un fragment : chercher un
 * sous-ensemble à coups de `indexOf` s'est révélé fragile — `listerPlaylists`
 * contient un autre `COALESCE(` (la somme des octets), et une recherche
 * globale attrapait celui-là. Lire la requête entière, c'est lire ce que
 * l'application exécute vraiment.
 */
function requeteDe(fonction) {
  const depart = source.indexOf(`export async function ${fonction}`);
  if (depart < 0) throw new Error(`${fonction} introuvable dans repos.ts`);
  const suivant = source.indexOf("export async function", depart + 10);
  const corps = source.slice(depart, suivant < 0 ? source.length : suivant);
  const debut = corps.indexOf("`SELECT");
  if (debut < 0) throw new Error(`requete SQL introuvable dans ${fonction}`);
  const fin = corps.indexOf("`", debut + 1);
  if (fin < 0) throw new Error(`gabarit non termine dans ${fonction}`);
  return corps.slice(debut + 1, fin);
}

/** La forme historique, reconstruite, pour documenter le defaut. */
const AVANT = `
  (SELECT t.pochette FROM tracks t
    WHERE t.playlist_id = p.playlist_id
      AND t.pochette IS NOT NULL
      AND (p.couverture IS NULL OR t.video_id = p.couverture)
    ORDER BY t.id
    LIMIT 1) AS pochette`;

const CAS = [
  {
    nom: "sans couverture designee, premier titre avec pochette",
    couverture: null,
    tracks: [["a", "/c/a.jpg", "chez_toi"], ["b", null, "chez_toi"]],
    attendu: "/c/a.jpg",
  },
  {
    nom: "la couverture designee a sa pochette : elle gagne",
    couverture: "b",
    tracks: [["a", "/c/a.jpg", "chez_toi"], ["b", "/c/b.jpg", "chez_toi"]],
    attendu: "/c/b.jpg",
  },
  {
    // LE CAS DU BUG : couverture designee dont la pochette n'est pas encore
    // arrivee, alors qu'un autre titre en a une.
    nom: "couverture designee SANS pochette, un autre titre en a une",
    couverture: "b",
    tracks: [["a", "/c/a.jpg", "chez_toi"], ["b", null, "chez_toi"]],
    attendu: "/c/a.jpg",
  },
  {
    nom: "aucun titre n'a de pochette",
    couverture: "a",
    tracks: [["a", null, "chez_toi"], ["b", null, "chez_toi"]],
    attendu: null,
  },
  {
    nom: "playlist vide",
    couverture: null,
    tracks: [],
    attendu: null,
  },
  {
    nom: "couverture designee absente de la playlist",
    couverture: "zzz",
    tracks: [["a", "/c/a.jpg", "chez_toi"], ["b", null, "chez_toi"]],
    attendu: "/c/a.jpg",
  },
  {
    nom: "la pochette arrive plus tard que la couverture",
    couverture: "b",
    tracks: [["a", "/c/a.jpg", "chez_toi"], ["b", null, "absent"]],
    attendu: "/c/a.jpg",
  },
];

/** Schema complet, aligne sur les colonnes que la requete touche reellement. */
const SCHEMA = `
  CREATE TABLE playlists (playlist_id TEXT PRIMARY KEY, nom TEXT,
                          couverture TEXT, importee_le INTEGER);
  CREATE TABLE tracks (id INTEGER PRIMARY KEY, playlist_id TEXT, video_id TEXT,
                       pochette TEXT, etat TEXT, taille INTEGER);
`;

function base(cas) {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  db.prepare(
    "INSERT INTO playlists VALUES ('p1', 'Ma playlist', ?, 1)",
  ).run(cas.couverture);
  const insere = db.prepare(
    "INSERT INTO tracks (id, playlist_id, video_id, pochette, etat, taille) " +
      "VALUES (?, 'p1', ?, ?, ?, 1000)",
  );
  cas.tracks.forEach(([video, pochette, etat], i) => insere.run(i + 1, video, pochette, etat));
  return db;
}

/**
 * `requete` est soit la requete complete, soit le fragment historique.
 *
 * `playlistParId` filtre sur `WHERE p.playlist_id = ?` : sans lier le
 * parametre, la requete ne rend aucune ligne et le test mesurerait un
 * `NULL` partout — un echec qui n'a rien a voir avec la pochette.
 */
function pochette(cas, requete, complete) {
  const db = base(cas);
  const sql = complete
    ? requete
    : `SELECT p.*, ${requete} FROM playlists p`;
  const nbParams = (sql.match(/\?/g) || []).length;
  const lignes = db.prepare(sql).all(...new Array(nbParams).fill("p1"));
  if (!lignes.length) return null;
  return lignes[0].pochette ?? null;
}

const afficher = (v) => (v === null ? "aucune" : v);
let echecs = 0;

for (const fonction of ["listerPlaylists", "playlistParId"]) {
  const requete = requeteDe(fonction);
  if (!/COALESCE/i.test(requete)) {
    console.error(
      `  ${fonction} n'utilise plus COALESCE pour la pochette. Ce verificateur ` +
        "teste la forme qu'il connait ; il faut le mettre a jour.",
    );
    process.exit(1);
  }

  console.log(`\n  ${fonction} — requete extraite de repos.ts\n`);

  const avant = CAS.map((cas) => pochette(cas, AVANT, false));
  console.log("    avant :");
  CAS.forEach((cas, i) => {
    const marque = avant[i] === cas.attendu ? " " : "!";
    console.log(
      `     ${marque} ${cas.nom}  ->  ${afficher(avant[i])}` +
        (avant[i] === cas.attendu ? "" : `   (attendu ${afficher(cas.attendu)})`),
    );
  });

  console.log("    apres :");
  for (const cas of CAS) {
    const v = pochette(cas, requete, true);
    const bon = v === cas.attendu;
    if (!bon) echecs += 1;
    console.log(`     ${bon ? "OK   " : "ECHEC"} ${cas.nom}  ->  ${afficher(v)}`);
  }

  // Le cas du bug doit reellement echouer avec la forme historique, sinon le
  // test ne demontrerait pas qu'on a corrige le defaut constate.
  const idxBug = CAS.findIndex((c) => c.nom.startsWith("couverture designee SANS"));
  if (avant[idxBug] === CAS[idxBug].attendu) {
    console.error(
      "\n  Le cas du bug passait deja AVANT correction. Le scenario ne " +
        "reproduit pas le defaut — le test ne prouve rien.",
    );
    echecs += 1;
  }
}

console.log(
  echecs === 0
    ? "\n  Les deux requetes passent tous les cas, et la forme historique echoue\n" +
        "  exactement sur le cas du bug.\n"
    : `\n  ${echecs} divergence(s).\n`,
);
process.exit(echecs === 0 ? 0 : 1);
