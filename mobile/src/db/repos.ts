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
  /** Ligne locale : l'identité est le couple (vidéo, playlist), pas la vidéo seule. */
  id: number;
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
  /**
   * La place du titre dans sa playlist, telle que le manifeste l'a donnée.
   *
   * Écrit une fois, à l'import, jamais réécrit : c'est lui qui donne l'ordre
   * affiché. `null` pour « Sans playlist », où l'ordre n'a pas de sens.
   */
  rang: number | null;
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

/** Enregistre ou met à jour un titre venu du bureau (sans écraser un fichier local).
 *
 * L'unicité est par playlist : le même `video_id` peut vivre dans plusieurs
 * playlists (une ligne par couple), mais jamais deux fois dans la même.
 * `playlist_id` NULL (« Sans playlist ») échappe à l'unicité SQL (NULL est
 * distinct en SQLite) : le doublon y est refusé ici, avant l'insertion.
 */
export async function enregistrerPiste(
  piste: Omit<Piste, "id" | "ajoute_le" | "ecoute_le" | "etat"> & { etat?: EtatTitre },
) {
  const handle = await db();
  const existante =
    piste.playlist_id === null
      ? await handle.getFirstAsync<Piste>(
          `SELECT * FROM tracks WHERE video_id = ? AND playlist_id IS NULL`,
          piste.video_id,
        )
      : await handle.getFirstAsync<Piste>(
          `SELECT * FROM tracks WHERE video_id = ? AND playlist_id = ?`,
          piste.video_id,
          piste.playlist_id,
        );
  if (existante) {
    await handle.runAsync(
      `UPDATE tracks SET
         titre    = ?,
         chaine   = ?,
         album    = ?,
         duree    = ?,
         taille   = MAX(?, taille),
         -- Le fichier suit la ligne quand on le connaît (titre déjà présent
         -- dans une autre playlist : on relie au lieu de retélécharger), et
         -- n'est jamais effacé par un import (le bureau annonce fichier
         -- à null, le téléphone garde le sien).
         fichier  = COALESCE(?, tracks.fichier),
         pochette = COALESCE(?, tracks.pochette),
         etat     = CASE WHEN COALESCE(?, tracks.fichier) IS NULL THEN ? ELSE 'chez_toi' END,
         -- Le rang suit le manifeste, même en mise à jour : un rescan peut
         -- donner un ordre différent, et c'est celui du manifeste qui fait foi.
         rang     = COALESCE(?, tracks.rang)
       WHERE id = ?`,
      piste.titre,
      piste.chaine,
      piste.album,
      piste.duree,
      piste.taille,
      piste.fichier,
      piste.pochette,
      piste.fichier,
      piste.etat ?? "absent",
      piste.rang,
      existante.id,
    );
    return;
  }
  await handle.runAsync(
    `INSERT INTO tracks (video_id, playlist_id, titre, chaine, album, duree, taille,
                         fichier, pochette, etat, rang, ajoute_le)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    piste.rang,
    Date.now(),
  );
}

/** Une occurrence précise d'un titre dans une playlist, ou null. */
export async function pisteDansPlaylist(
  video_id: string,
  playlist_id: string | null,
): Promise<Piste | null> {
  const handle = await db();
  if (playlist_id === null) {
    return handle.getFirstAsync<Piste>(
      `SELECT * FROM tracks WHERE video_id = ? AND playlist_id IS NULL`,
      video_id,
    );
  }
  return handle.getFirstAsync<Piste>(
    `SELECT * FROM tracks WHERE video_id = ? AND playlist_id = ?`,
    video_id,
    playlist_id,
  );
}

/** Toutes les occurrences d'une vidéo, toutes playlists confondues. */
export async function pistesParVideo(video_id: string): Promise<Piste[]> {
  const handle = await db();
  return handle.getAllAsync<Piste>(`SELECT * FROM tracks WHERE video_id = ?`, video_id);
}

/** Occurrences possédées d'une vidéo : celles qui partagent le même fichier. */
export async function pistesParFichier(fichier: string): Promise<Piste[]> {
  const handle = await db();
  return handle.getAllAsync<Piste>(`SELECT * FROM tracks WHERE fichier = ?`, fichier);
}

/** Pose la pochette sur toutes les occurrences d'une vidéo.
 *
 * Le même titre dans deux playlists partage la même image : ne mettre à jour
 * qu'une ligne laisserait l'autre avec une vignette vide ou distante.
 */
export async function definirPochette(video_id: string, pochette: string) {
  const handle = await db();
  await handle.runAsync(`UPDATE tracks SET pochette = ? WHERE video_id = ?`, pochette, video_id);
}

/** Marque un titre comme possédé, avec son fichier local.
 *
 * Toutes ses occurrences suivent : c'est la même vidéo, donc le même fichier,
 * dans chaque playlist qui la contient.
 */
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
 *
 * `playlist_id` restreint aux lignes d'une playlist (rescan : on ne touche pas
 * aux autres playlists qui partagent la même vidéo).
 */
export async function retirerDuLocal(video_ids: string[], playlist_id?: string | null) {
  if (video_ids.length === 0) return 0;
  const marques = video_ids.map(() => "?").join(", ");
  const handle = await db();
  if (playlist_id === undefined) {
    await handle.runAsync(
      `UPDATE tracks SET fichier = NULL, taille = 0, etat = 'absent'
       WHERE etat = 'chez_toi' AND fichier IS NOT NULL
         AND video_id IN (${marques})`,
      ...video_ids,
    );
  } else if (playlist_id === null) {
    await handle.runAsync(
      `UPDATE tracks SET fichier = NULL, taille = 0, etat = 'absent'
       WHERE etat = 'chez_toi' AND fichier IS NOT NULL
         AND playlist_id IS NULL AND video_id IN (${marques})`,
      ...video_ids,
    );
  } else {
    await handle.runAsync(
      `UPDATE tracks SET fichier = NULL, taille = 0, etat = 'absent'
       WHERE etat = 'chez_toi' AND fichier IS NOT NULL
         AND playlist_id = ? AND video_id IN (${marques})`,
      playlist_id,
      ...video_ids,
    );
  }
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
            -- La pochette de la playlist : celle du titre désigné comme
            -- couverture (la règle du PC), sinon celle de son premier titre.
            -- C'est la logique du web, où la pochette d'une playlist est celle
            -- de son premier titre — et c'est ce qui donne une image à une
            -- playlist née sur le téléphone, qui n'a pas de couverture désignée.
            --
            -- La comparaison à la couverture vit dans le WHERE, jamais dans un
            -- ORDER BY : SQLite refuse une référence à la table extérieure dans
            -- le tri d'une sous-requête (« no such column: p.couverture »).
            (SELECT t.pochette FROM tracks t
              WHERE t.playlist_id = p.playlist_id
                AND t.pochette IS NOT NULL
                AND (p.couverture IS NULL OR t.video_id = p.couverture)
              ORDER BY t.id
              LIMIT 1) AS pochette
     FROM playlists p ORDER BY p.importee_le DESC`,
  );
}

export async function playlistParId(playlist_id: string): Promise<Playlist | null> {
  const handle = await db();
  return handle.getFirstAsync<Playlist>(
    `SELECT p.*,
            -- La grande pochette du détail : exactement la même image que
            -- l'icône — celle de la couverture, sinon celle du premier titre.
            (SELECT t.pochette FROM tracks t
              WHERE t.playlist_id = p.playlist_id
                AND t.pochette IS NOT NULL
                AND (p.couverture IS NULL OR t.video_id = p.couverture)
              ORDER BY t.id
              LIMIT 1) AS pochette
     FROM playlists p WHERE p.playlist_id = ?`,
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
    // « Sans playlist » n'a pas d'ordre : le tiroir des titres sans dossier se lit
    // par date d'écoute, du plus récemment écouté au plus ancien.
    return handle.getAllAsync<Piste>(
      `SELECT * FROM tracks WHERE playlist_id IS NULL
       ORDER BY etat = 'chez_toi' DESC, ecoute_le DESC NULLS LAST, titre COLLATE NOCASE`,
    );
  }
  // L'ordre vient du RANG — la place donnée par le manifeste — et non de la
  // date d'écoute. Écouter un titre ne le fait donc plus remonter en tête : la
  // playlist garde l'ordre dans lequel tu l'as choisie, quoi qu'on écoute.
  // `etat` d'abord reste utile : un titre absent reste lisible mais signalé,
  // pas enterré sous les titres présents.
  return handle.getAllAsync<Piste>(
    `SELECT * FROM tracks WHERE playlist_id = ?
     ORDER BY rang IS NULL, rang, etat = 'chez_toi' DESC, titre COLLATE NOCASE`,
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
  return handle.getFirstAsync<Piste>(
    `SELECT * FROM tracks WHERE video_id = ? ORDER BY etat = 'chez_toi' DESC, id LIMIT 1`,
    video_id,
  );
}

/**
 * Note qu'un titre a été écouté, dans TOUTES les playlists qui le contiennent.
 *
 * C'est voulu : la même chanson peut figurer dans trois playlists, et l'utilisateur
 * l'a écoutée une fois, pas trois. La date est une donnée d'écoute, pas une
 * donnée de position.
 *
 * Ne surtout pas s'en servir pour ordonner une playlist — c'était le bug d'origine.
 * L'ordre vient de `rang` (voir `listerPistesParPlaylist`) ; `ecoute_le` ne sert
 * plus qu'à l'historique et au tiroir « Sans playlist ».
 */
export async function marquerEcoute(video_id: string) {
  const handle = await db();
  await handle.runAsync(`UPDATE tracks SET ecoute_le = ? WHERE video_id = ?`, Date.now(), video_id);
}

/**
 * Oublie une occurrence précise, identifiée par sa ligne.
 *
 * Le fichier part, la couverture reste : le titre demeure dans sa playlist, et
 * sa vignette en fait partie. C'est `effacement` qui décide de l'image, au
 * moment d'une suppression définitive.
 */
export async function oublierLigne(id: number) {
  const handle = await db();
  await handle.runAsync(
    `UPDATE tracks SET fichier = NULL, etat = 'absent' WHERE id = ?`,
    id,
  );
}

/**
 * Supprime des titres définitivement : fichiers, puis lignes.
 *
 * La différence avec `retirerDuTelephone` est la fin : la ligne disparaît de
 * la bibliothèque au lieu de redevenir « à transférer ». Même ordre imposé —
 * fichier d'abord, base ensuite — pour qu'une interruption ne laisse jamais
 * une base qui promet un fichier absent.
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

/** Retire des occurrences précises, identifiées par leurs lignes. */
export async function supprimerLignes(ids: number[]) {
  if (ids.length === 0) return;
  const handle = await db();
  const marques = ids.map(() => "?").join(", ");
  await handle.runAsync(`DELETE FROM tracks WHERE id IN (${marques})`, ...ids);
}

/**
 * Oublie des occurrences précises, identifiées par leurs lignes.
 *
 * Le fichier part, la couverture reste (voir `oublierLigne`).
 */
export async function oublierLignes(ids: number[]) {
  if (ids.length === 0) return;
  const handle = await db();
  const marques = ids.map(() => "?").join(", ");
  await handle.runAsync(
    `UPDATE tracks SET fichier = NULL, etat = 'absent' WHERE id IN (${marques})`,
    ...ids,
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
