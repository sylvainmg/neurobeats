/**
 * Base locale : le téléphone possède sa bibliothèque, hors ligne.
 *
 * Un seul magasin (SQLite, mode WAL) pour les titres, les playlists et les
 * réglages. Aucune donnée ne dépend du bureau une fois l'import terminé.
 */
import * as SQLite from "expo-sqlite";

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS playlists (
  playlist_id  TEXT PRIMARY KEY NOT NULL,
  nom          TEXT NOT NULL,
  importee_le  INTEGER NOT NULL,
  -- Le titre dont la pochette sert de couverture à la playlist : sur le web,
  -- c'est le premier titre de la playlist, et le téléphone doit montrer la même
  -- image. On garde son identifiant, la vignette locale se retrouvant ensuite
  -- dans la table des titres.
  couverture   TEXT,
  -- Une playlist née sur le téléphone (mini-navigateur) : seule elle accueille
  -- les téléchargements directs. Les playlists venues de l'ordinateur gardent 0.
  locale       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tracks (
  -- Ligne locale : un même titre peut revenir dans plusieurs playlists, donc
  -- l'identité n'est plus la vidéo seule mais le couple (vidéo, playlist).
  -- UNIQUE laisse passer les doublons quand la playlist est NULL (SQLite
  -- traite NULL comme distinct) : pour « Sans playlist », c'est la logique
  -- applicative (enregistrerPiste) qui refuse le doublon, pas la base.
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id     TEXT NOT NULL,
  playlist_id  TEXT,
  titre        TEXT NOT NULL,
  chaine       TEXT NOT NULL DEFAULT '',
  album        TEXT NOT NULL DEFAULT '',
  duree        INTEGER NOT NULL DEFAULT 0,
  taille       INTEGER NOT NULL DEFAULT 0,
  fichier      TEXT,
  pochette     TEXT,
  etat         TEXT NOT NULL DEFAULT 'absent',
  -- La place du titre DANS LA PLAYLIST, telle que le manifeste l'a donnée.
  --
  -- Sans elle, l'ordre affiché était recalculé à chaque lecture sur la colonne
  -- ecoute_le, triée en ordre décroissant : une colonne que la lecture réécrit à
  -- chaque titre joué. Écouter un titre le faisait remonter en tête de toutes les
  -- playlists qui le contiennent — l'ordre bougeait parce qu on écoutait, ce qui
  -- n a aucun sens.
  --
  -- Le rang est écrit UNE FOIS, à l import, et plus jamais. ecoute_le reste la
  -- date d écoute, pour l historique, mais plus la clé de tri d une playlist.
  -- NULL pour « Sans playlist », où l ordre n a pas de sens : le tiroir se lit
  -- par-date, comme l historique.
  rang         INTEGER,
  ajoute_le    INTEGER NOT NULL,
  ecoute_le    INTEGER,
  UNIQUE (video_id, playlist_id),
  FOREIGN KEY (playlist_id) REFERENCES playlists (playlist_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tracks_playlist ON tracks (playlist_id);
CREATE INDEX IF NOT EXISTS idx_tracks_etat ON tracks (etat);
CREATE INDEX IF NOT EXISTS idx_tracks_ecoute ON tracks (ecoute_le DESC);

CREATE TABLE IF NOT EXISTS settings (
  cle     TEXT PRIMARY KEY NOT NULL,
  valeur  TEXT NOT NULL
);
`;

/**
 * Une seule ouverture, mémorisée dès le premier appel.
 *
 * Mémoriser la base ne suffisait pas : deux appels lancés en parallèle (une
 * bibliothèque qui lit ses titres et ses playlists en même temps, par exemple)
 * voyaient tous les deux une base vide et ouvraient le même fichier deux fois.
 * Le second écrasait la référence du premier, et les requêtes préparées sur le
 * handle abandonné étaient rejetées par le natif — un `NullPointerException` sur
 * `prepareAsync`, sans rien dire de sa cause.
 *
 * C'est donc la *promesse* d'ouverture qui est mémorisée : les appels
 * concurrents attendent la même ouverture au lieu d'en déclencher une chacun.
 */
let ouverture: Promise<SQLite.SQLiteDatabase> | null = null;

export function db(): Promise<SQLite.SQLiteDatabase> {
  ouverture ??= ouvrir().catch((erreur) => {
    // Un échec n'est pas mémorisé : une nouvelle tentative doit pouvoir aboutir
    // (stockage momentanément indisponible), sinon l'application resterait
    // cassée jusqu'au prochain démarrage.
    ouverture = null;
    throw erreur;
  });
  return ouverture;
}

async function ouvrir(): Promise<SQLite.SQLiteDatabase> {
  const base = await SQLite.openDatabaseAsync("neurobeats.db");
  await base.execAsync(SCHEMA);
  await ajouterCouverture(base);
  await ajouterLocalite(base);
  await migrerTracksDoublons(base);
  await migrerRangTracks(base);
  return base;
}

/**
 * Ajoute la couverture de playlist aux bases déjà installées.
 *
 * `CREATE TABLE IF NOT EXISTS` ne touche pas une table existante : une base
 * créée avant ce champ ne l'aurait jamais. On regarde donc le schéma réel plutôt
 * que de tenter un `ALTER TABLE` à l'aveugle — un échec avalé cacherait aussi
 * les vraies erreurs.
 */
async function ajouterCouverture(base: SQLite.SQLiteDatabase) {
  const colonnes = await base.getAllAsync<{ name: string }>(`PRAGMA table_info(playlists)`);
  if (colonnes.some((colonne) => colonne.name === "couverture")) return;
  await base.execAsync(`ALTER TABLE playlists ADD COLUMN couverture TEXT`);
}

async function ajouterLocalite(base: SQLite.SQLiteDatabase) {
  const colonnes = await base.getAllAsync<{ name: string }>(`PRAGMA table_info(playlists)`);
  if (colonnes.some((colonne) => colonne.name === "locale")) return;
  await base.execAsync(`ALTER TABLE playlists ADD COLUMN locale INTEGER NOT NULL DEFAULT 0`);
}

/**
 * Fait passer les titres à l'identité par playlist.
 *
 * Les bases déjà installées ont `video_id` en clé primaire : un même titre ne
 * pouvait vivre que dans une seule playlist. On reconstruit la table avec une
 * clé `id` et une unicité sur le couple (vidéo, playlist), en gardant les
 * lignes existantes telles quelles.
 */
async function migrerTracksDoublons(base: SQLite.SQLiteDatabase) {
  const colonnes = await base.getAllAsync<{ name: string }>(`PRAGMA table_info(tracks)`);
  if (colonnes.length === 0 || colonnes.some((colonne) => colonne.name === "id")) return;
  await base.execAsync(`
    ALTER TABLE tracks RENAME TO tracks_ancien;
    CREATE TABLE tracks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id     TEXT NOT NULL,
      playlist_id  TEXT,
      titre        TEXT NOT NULL,
      chaine       TEXT NOT NULL DEFAULT '',
      album        TEXT NOT NULL DEFAULT '',
      duree        INTEGER NOT NULL DEFAULT 0,
      taille       INTEGER NOT NULL DEFAULT 0,
      fichier      TEXT,
      pochette     TEXT,
      etat         TEXT NOT NULL DEFAULT 'absent',
      rang         INTEGER,
      ajoute_le    INTEGER NOT NULL,
      ecoute_le    INTEGER,
      UNIQUE (video_id, playlist_id),
      FOREIGN KEY (playlist_id) REFERENCES playlists (playlist_id) ON DELETE SET NULL
    );
    INSERT INTO tracks (video_id, playlist_id, titre, chaine, album, duree, taille,
                        fichier, pochette, etat, ajoute_le, ecoute_le)
      SELECT video_id, playlist_id, titre, chaine, album, duree, taille,
             fichier, pochette, etat, ajoute_le, ecoute_le
      FROM tracks_ancien;
    DROP TABLE tracks_ancien;
    CREATE INDEX IF NOT EXISTS idx_tracks_playlist ON tracks (playlist_id);
    CREATE INDEX IF NOT EXISTS idx_tracks_etat ON tracks (etat);
    CREATE INDEX IF NOT EXISTS idx_tracks_ecoute ON tracks (ecoute_le DESC);
  `);
}

/**
 * Ajoute la colonne `rang` aux bases déjà installées.
 *
 * Les tables créées avant cette colonne n'ont pas de place pour le titre : leur
 * ordre se déduisait de la date d'écoute, donc la lecture déplaçait la liste.
 * On comble le trou en reprenant l'ordre d'insertion (`id`), qui est l'ordre
 * d'arrivée du manifeste — le meilleur ordre de remplacement disponible, et
 * surtout un ordre STABLE : plus rien ne le réécrira.
 *
 * Idempotent : la colonne existe déjà sur les bases neuves.
 */
async function migrerRangTracks(base: SQLite.SQLiteDatabase) {
  const colonnes = await base.getAllAsync<{ name: string }>(`PRAGMA table_info(tracks)`);
  if (colonnes.length === 0 || colonnes.some((colonne) => colonne.name === "rang")) return;
  await base.execAsync(`ALTER TABLE tracks ADD COLUMN rang INTEGER`);
  // `id` est l'ordre d'insertion : il rend le rang croissant comme l'id.
  await base.execAsync(`UPDATE tracks SET rang = id WHERE rang IS NULL`);
  await base.execAsync(
    `CREATE INDEX IF NOT EXISTS idx_tracks_rang ON tracks (playlist_id, rang)`,
  );
}

export async function closeForTests() {
  if (ouverture) {
    const base = await ouverture;
    await base.closeAsync();
    ouverture = null;
  }
}
