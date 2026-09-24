/**
 * Accès aux données : toutes les requêtes sont préparées et regroupées ici.
 *
 * L'état d'un titre (`chez_toi`, `partiel`, `absent`) est la seule source de
 * vérité de l'interface : c'est lui qui décide de ce qu'on affiche et de ce
 * qu'il reste à faire.
 */
import { db } from "@/db/db";
import type { ResumePlaylist } from "@/library/playlists";

export type EtatTitre = "chez_toi" | "partiel" | "absent";

export type Piste = {
  video_id: string;
  playlist_id: string | null;
  titre: string;
  chaine: string;
  album: string;
  duree: number;
  taille: number;
  fichier: string | null;
  pochette: string | null;
  etat: EtatTitre;
  ajoute_le: number;
  ecoute_le: number | null;
};

export type Playlist = {
  playlist_id: string;
  nom: string;
  importee_le: number;
  /** Titre dont la pochette sert de couverture (le premier de la playlist). */
  couverture?: string | null;
  /** Chemin local de cette vignette, quand elle est descendue sur le téléphone. */
  pochette?: string | null;
  /** Playlist née sur le téléphone (mini-navigateur), pas venue de l'ordinateur. */
  locale?: number;
  titres?: number;
  chez_toi?: number;
  octets?: number;
};

/** Enregistre ou met à jour une playlist venue du bureau, jamais locale. */
export async function creerPlaylist(nom: string): Promise<string> {
  const handle = await db();
  // Un identifiant local ne collisionne pas avec les identifiants des playlists
  // de l'ordinateur (des slugs), et un nom vide n'a aucun sens : seul l'appel
  // du mini-navigateur passe ici, avec un nom déjà nettoyé.
  const playlist_id = `loc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await handle.runAsync(
    `INSERT INTO playlists (playlist_id, nom, importee_le, locale) VALUES (?, ?, ?, 1)`,
    playlist_id,
    nom.trim(),
    Date.now(),
  );
  return playlist_id;
}

export async function renommerPlaylist(playlist_id: string, nom: string) {
  const handle = await db();
  await handle.runAsync(`UPDATE playlists SET nom = ? WHERE playlist_id = ?`, nom.trim(), playlist_id);
}

/** Enregistre une playlist, et le titre qui lui sert de couverture.
 *
 * La couverture est le **premier titre de la playlist** : c'est la règle du web,
 * et le téléphone montre donc la même image. On ne l'écrase pas avec rien quand
 * un import ne l'annonce pas (playlist vide, ou manifeste plus ancien).
 */
export async function enregistrerPlaylist(
  playlist_id: string,
  nom: string,
  couverture?: string | null,
) {
  const handle = await db();
  await handle.runAsync(
    `INSERT INTO playlists (playlist_id, nom, importee_le, couverture) VALUES (?, ?, ?, ?)
     ON CONFLICT (playlist_id) DO UPDATE SET
       nom = excluded.nom,
       couverture = COALESCE(excluded.couverture, playlists.couverture)`,
    playlist_id,
    nom,
    Date.now(),
    couverture ?? null,
  );
}

/** Enregistre ou met à jour un titre venu du bureau (sans écraser un fichier local). */
export async function enregistrerPiste(
  piste: Omit<Piste, "ajoute_le" | "ecoute_le" | "etat"> & { etat?: EtatTitre },
) {
  const handle = await db();
  await handle.runAsync(
    `INSERT INTO tracks (video_id, playlist_id, titre, chaine, album, duree, taille,
                         fichier, pochette, etat, ajoute_le)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (video_id) DO UPDATE SET
       playlist_id = excluded.playlist_id,
       titre       = excluded.titre,
       chaine      = excluded.chaine,
       album       = excluded.album,
       duree       = excluded.duree,
       taille      = MAX(excluded.taille, tracks.taille),
       pochette    = COALESCE(excluded.pochette, tracks.pochette),
       etat        = CASE WHEN tracks.fichier IS NULL THEN excluded.etat ELSE tracks.etat END`,
    piste.video_id,
    piste.playlist_id,
    piste.titre,
    piste.chaine,
    piste.album,
    piste.duree,
    piste.taille,
    piste.fichier,
    piste.pochette,
    piste.etat ?? "absent",
    Date.now(),
  );
}

/** Marque un titre comme possédé, avec son fichier local. */
export async function marquerPossede(
  video_id: string,
  fichier: string,
  taille: number,
) {
  const handle = await db();
  await handle.runAsync(
    `UPDATE tracks SET fichier = ?, taille = ?, etat = 'chez_toi' WHERE video_id = ?`,
    fichier,
    taille,
    video_id,
  );
}

/**
 * Retire du téléphone les titres dont le fichier n'existe plus.
 *
 * « Chez toi » doit vouloir dire « je peux l'écouter » : un fichier disparu
 * (nettoyage mémoire, suppression externe) ferait mentir cette promesse. On
 * remet ces titres à « absent » — ils redeviendront « à récupérer » au
 * prochain transfert, au lieu de rester des lignes mortes.
 */
export async function retirerDuLocal(video_ids: string[]) {
  if (video_ids.length === 0) return 0;
  const marques = video_ids.map(() => "?").join(", ");
  const handle = await db();
  await handle.runAsync(
    `UPDATE tracks SET fichier = NULL, taille = 0, etat = 'absent'
     WHERE etat = 'chez_toi' AND fichier IS NOT NULL
       AND video_id IN (${marques})`,
    ...video_ids,
  );
  return video_ids.length;
}

export async function listerPistes(recherche = ""): Promise<Piste[]> {
  const handle = await db();
  const terme = `%${recherche.trim()}%`;
  return handle.getAllAsync<Piste>(
    `SELECT * FROM tracks
     WHERE (? = '%%' OR titre LIKE ? OR chaine LIKE ?)
     ORDER BY etat = 'chez_toi' DESC, ecoute_le DESC NULLS LAST, titre COLLATE NOCASE`,
    terme,
    terme,
    terme,
  );
}

export async function listerPlaylists(): Promise<Playlist[]> {
  const handle = await db();
  return handle.getAllAsync<Playlist>(
    `SELECT p.*,
            (SELECT COUNT(*) FROM tracks t WHERE t.playlist_id = p.playlist_id) AS titres,
            (SELECT COUNT(*) FROM tracks t WHERE t.playlist_id = p.playlist_id
               AND t.etat = 'chez_toi') AS chez_toi,
            (SELECT COALESCE(SUM(t.taille), 0) FROM tracks t WHERE t.playlist_id = p.playlist_id
               AND t.etat = 'chez_toi') AS octets,
            -- La vignette de la couverture : celle du titre désigné, déjà
            -- descendue sur le téléphone lors d'un import.
            (SELECT t.pochette FROM tracks t WHERE t.video_id = p.couverture) AS pochette
     FROM playlists p ORDER BY p.importee_le DESC`,
  );
}

export async function playlistParId(playlist_id: string): Promise<Playlist | null> {
  const handle = await db();
  return handle.getFirstAsync<Playlist>(
    `SELECT * FROM playlists WHERE playlist_id = ?`,
    playlist_id,
  );
}

/** Titres qu'aucune playlist ne réclame, avec leurs totaux : une ligne à part entière. */
export async function resumeSansPlaylist(): Promise<ResumePlaylist> {
  const handle = await db();
  const ligne = await handle.getFirstAsync<ResumePlaylist>(
    `SELECT COUNT(*) AS titres,
            COALESCE(SUM(etat = 'chez_toi'), 0) AS chez_toi,
            COALESCE(SUM(CASE WHEN etat = 'chez_toi' THEN taille ELSE 0 END), 0) AS octets
     FROM tracks WHERE playlist_id IS NULL`,
  );
  return ligne ?? { titres: 0, chez_toi: 0, octets: 0 };
}

/** Les titres d'une playlist, ou ceux qu'aucune playlist ne réclame (`null`). */
export async function listerPistesParPlaylist(playlist_id: string | null): Promise<Piste[]> {
  const handle = await db();
  if (playlist_id === null) {
    return handle.getAllAsync<Piste>(
      `SELECT * FROM tracks WHERE playlist_id IS NULL
       ORDER BY etat = 'chez_toi' DESC, ecoute_le DESC NULLS LAST, titre COLLATE NOCASE`,
    );
  }
  return handle.getAllAsync<Piste>(
    `SELECT * FROM tracks WHERE playlist_id = ?
     ORDER BY etat = 'chez_toi' DESC, ecoute_le DESC NULLS LAST, titre COLLATE NOCASE`,
    playlist_id,
  );
}

/** Titres des transferts repris après un redémarrage : le module natif ne garde que les identifiants. */
export async function titresParId(videoIds: string[]): Promise<Map<string, string>> {
  const trouves = new Map<string, string>();
  if (videoIds.length === 0) return trouves;
  const handle = await db();
  const marques = videoIds.map(() => "?").join(", ");
  const lignes = await handle.getAllAsync<{ video_id: string; titre: string }>(
    `SELECT video_id, titre FROM tracks WHERE video_id IN (${marques})`,
    ...videoIds,
  );
  for (const ligne of lignes) trouves.set(ligne.video_id, ligne.titre);
  return trouves;
}

export async function pisteParId(video_id: string): Promise<Piste | null> {
  const handle = await db();
  return handle.getFirstAsync<Piste>(`SELECT * FROM tracks WHERE video_id = ?`, video_id);
}

export async function marquerEcoute(video_id: string) {
  const handle = await db();
  await handle.runAsync(`UPDATE tracks SET ecoute_le = ? WHERE video_id = ?`, Date.now(), video_id);
}

export async function oublierPiste(video_id: string) {
  const handle = await db();
  await handle.runAsync(
    `UPDATE tracks SET fichier = NULL, pochette = NULL, etat = 'absent' WHERE video_id = ?`,
    video_id,
  );
}

/**
 * Oublie des titres dont les fichiers ont déjà été supprimés.
 *
 * Le titre n'est pas retiré de la bibliothèque : il redevient « à transférer »,
 * ce qu'il est exactement. C'est ce qui permet de le récupérer en rescanant le
 * code de sa playlist.
 *
 * La pochette part avec le fichier : elle a été effacée du téléphone, et garder
 * son chemin ferait afficher une image cassée jusqu'au prochain import.
 */
export async function oublierPistes(video_ids: string[]) {
  if (video_ids.length === 0) return;
  const handle = await db();
  const marques = video_ids.map(() => "?").join(", ");
  await handle.runAsync(
    `UPDATE tracks SET fichier = NULL, pochette = NULL, etat = 'absent'
     WHERE video_id IN (${marques})`,
    ...video_ids,
  );
}

/**
 * Retire des titres de la bibliothèque, sans rien récupérer au prochain scan.
 *
 * Diffère d'`oublierPistes` : la ligne disparaît, elle ne redevient pas « à
 * transférer ». À n'appeler qu'après l'effacement des fichiers — on supprime
 * du téléphone le fichier, la pochette, puis la ligne, dans cet ordre (voir
 * `effacement.supprimerDefinitivement`).
 */
export async function supprimerTitres(video_ids: string[]) {
  if (video_ids.length === 0) return;
  const handle = await db();
  const marques = video_ids.map(() => "?").join(", ");
  await handle.runAsync(
    `DELETE FROM tracks WHERE video_id IN (${marques})`,
    ...video_ids,
  );
}

/** Titres dont le fichier est sur le téléphone : eux seuls occupent de la place. */
export async function pistesPossedees(): Promise<Piste[]> {
  const handle = await db();
  return handle.getAllAsync<Piste>(
    `SELECT * FROM tracks WHERE etat = 'chez_toi' AND fichier IS NOT NULL`,
  );
}

/**
 * Oublie les titres sans fichier.
 *
 * Ils ne pèsent rien et ne s'écouteront pas : les garder, c'est garder des lignes
 * qui ne peuvent rien faire d'autre que rappeler qu'elles manquent. Les fichiers,
 * eux, ne sont pas concernés — il n'y en a pas.
 */
export async function oublierSansFichier(): Promise<number> {
  const handle = await db();
  await handle.runAsync(`DELETE FROM tracks WHERE fichier IS NULL OR etat != 'chez_toi'`);
  const reste = await handle.getFirstAsync<{ total: number }>(
    `SELECT COUNT(*) AS total FROM tracks`,
  );
  return reste?.total ?? 0;
}

/** Retire une playlist et les titres qu'elle contient. */
export async function supprimerPlaylist(playlist_id: string) {
  const handle = await db();
  await handle.runAsync(`DELETE FROM tracks WHERE playlist_id = ?`, playlist_id);
  await handle.runAsync(`DELETE FROM playlists WHERE playlist_id = ?`, playlist_id);
}

export async function viderTout() {
  const handle = await db();
  await handle.execAsync(`DELETE FROM tracks; DELETE FROM playlists;`);
}

export type Bilan = { titres: number; chez_toi: number; octets: number };

export async function bilan(): Promise<Bilan> {
  const handle = await db();
  const ligne = await handle.getFirstAsync<Bilan>(
    `SELECT COUNT(*) AS titres,
            COALESCE(SUM(etat = 'chez_toi'), 0) AS chez_toi,
            COALESCE(SUM(CASE WHEN etat = 'chez_toi' THEN taille ELSE 0 END), 0) AS octets
     FROM tracks`,
  );
  return ligne ?? { titres: 0, chez_toi: 0, octets: 0 };
}

export async function lireReglage(cle: string, defaut: string): Promise<string> {
  const handle = await db();
  const ligne = await handle.getFirstAsync<{ valeur: string }>(
    `SELECT valeur FROM settings WHERE cle = ?`,
    cle,
  );
  return ligne?.valeur ?? defaut;
}

export async function ecrireReglage(cle: string, valeur: string) {
  const handle = await db();
  await handle.runAsync(
    `INSERT INTO settings (cle, valeur) VALUES (?, ?)
     ON CONFLICT (cle) DO UPDATE SET valeur = excluded.valeur`,
    cle,
    valeur,
  );
}
