/**
 * Importer des fichiers MP3 depuis le stockage du téléphone.
 *
 * Sélectionne des fichiers audio via `expo-document-picker`, les copie dans
 * `DOSSIER_TRANSFERT`, extrait les métadonnées (titre, artiste, durée) et
 * enregistre les pistes dans la base avec le `playlist_id` de la playlist
 * locale.
 *
 * Seule les playlists locales (locale === 1) peuvent être enrichies ainsi :
 * les playlists venues du PC sont synchronisées via QR code et ne doivent
 * pas être modifiées manuellement.
 */
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";

import { fichierTransfert, tailleDe } from "@/fichiers/dossiers";
import * as repo from "@/db/repos";

/**
 * Lit un fichier en ArrayBuffer via son readableStream.
 */
async function lireFichier(fichier: File): Promise<ArrayBuffer> {
  const stream = fichier.readableStream();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  // Fusionner les chunks
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result.buffer;
}

/**
 * Importe des fichiers MP3 depuis le stockage vers une playlist locale.
 *
 * 1. Sélectionne les fichiers via `DocumentPicker.getDocumentAsync`
 * 2. Copie dans `DOSSIER_TRANSFERT`
 * 3. Extrait métadonnées (titre, artiste, durée)
 * 4. Enregistre dans la base avec `playlist_id`
 *
 * @param playlistId ID de la playlist locale (locale === 1)
 * @returns Nombre de pistes importées
 */
export async function importerFichiers(playlistId: string): Promise<number> {
  // 1. Sélectionner les fichiers audio (multiple = true)
  const result = await DocumentPicker.getDocumentAsync({
    type: "audio/*",
    copyToCacheDirectory: true,
    multiple: true,
  });

  // Annulé ou aucun fichier
  if (result.canceled || !result.assets || result.assets.length === 0) return 0;

  let count = 0;
  for (const asset of result.assets) {
    try {
      // 2. Copier vers DOSSIER_TRANSFERT
      const source = new File(asset.uri);
      const nomFichier = asset.name;
      const dest = fichierTransfert(nomFichier);
      // Copier le fichier : lire le contenu puis l'écrire
      const content = await lireFichier(source);
      // Convertir ArrayBuffer en Uint8Array pour write()
      dest.write(new Uint8Array(content));

      // 3. Extraire métadonnées (titre, artiste, durée)
      const metadonnees = await extraireMetadonnees(dest);

      // 4. Enregistrer dans la base avec playlist_id
      await repo.enregistrerPiste({
        video_id: `local-${Date.now()}-${count}-${Math.random().toString(36).slice(2, 6)}`,
        playlist_id: playlistId,
        titre: metadonnees.titre || nomFichier.replace(/\.mp3$/i, ""),
        chaine: metadonnees.artiste || "Inconnu",
        album: metadonnees.album || "",
        duree: metadonnees.duree || 0,
        taille: tailleDe(dest),
        fichier: dest.uri,
        pochette: null,
        etat: "chez_toi",
      });

      count++;
    } catch (err) {
      console.error(`[import] erreur sur ${asset.uri}:`, err);
      // Continuer avec les autres fichiers
    }
  }

  return count;
}

/**
 * Extrait les métadonnées d'un fichier audio.
 *
 * Pour l'instant, dérive du nom de fichier : "Artiste - Titre.mp3".
 * Un vrai parser ID3 (id3-js) serait idéal, mais n'est pas encore installé.
 *
 * @returns Métadonnées basiques (titre, artiste, album, durée)
 */
async function extraireMetadonnees(fichier: File): Promise<{
  titre: string;
  artiste: string;
  album: string;
  duree: number;
}> {
  // Dériver du nom de fichier : "Artiste - Titre.mp3"
  const nom = fichier.name.replace(/\.mp3$/i, "").replace(/\.m4a$/i, "").replace(/\.ogg$/i, "");
  const parties = nom.split(" - ");
  return {
    artiste: parties[0]?.trim() || "Inconnu",
    titre: parties.slice(1).join(" - ").trim() || nom,
    album: "",
    duree: 0,
  };
}
