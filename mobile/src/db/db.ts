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
  video_id     TEXT PRIMARY KEY NOT NULL,
  playlist_id  TEXT,
  titre        TEXT NOT NULL,
  chaine       TEXT NOT NULL DEFAULT '',
  album        TEXT NOT NULL DEFAULT '',
  duree        INTEGER NOT NULL DEFAULT 0,
  taille       INTEGER NOT NULL DEFAULT 0,
  fichier      TEXT,
  pochette     TEXT,
  etat         TEXT NOT NULL DEFAULT 'absent',
  ajoute_le    INTEGER NOT NULL,
  ecoute_le    INTEGER,
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

export async function closeForTests() {
  if (ouverture) {
    const base = await ouverture;
    await base.closeAsync();
    ouverture = null;
  }
}
