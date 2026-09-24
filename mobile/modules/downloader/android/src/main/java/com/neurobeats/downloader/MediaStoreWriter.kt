package com.neurobeats.downloader

import android.content.ContentValues
import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File

/**
 * Ecrit un fichier telecharge dans la bibliotheque publique du telephone
 * (Music/NeuroBeats) avec ses metadonnees, sans permission de stockage.
 *
 * Le chemin est celui recommande a partir d'Android 10 : le fichier est insere
 * dans MediaStore en mode « en attente », rempli, puis publie. Les autres lecteurs
 * du telephone le voient alors comme un morceau normal.
 */
object MediaStoreWriter {

    private const val DOSSIER = "Music/NeuroBeats"

    /** Publie `source` dans MediaStore. Retourne l'URI publique, ou null. */
    fun publier(context: Context, source: File, titre: String, artiste: String, album: String): String? {
        if (!source.exists() || source.length() == 0L) return null
        val nom = source.name
        val valeurs = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, nom)
            put(MediaStore.MediaColumns.TITLE, titre)
            put(MediaStore.Audio.Media.ARTIST, artiste)
            put(MediaStore.Audio.Media.ALBUM, album)
            put(MediaStore.Audio.Media.IS_MUSIC, 1)
            put(MediaStore.Audio.Media.DURATION, duree(source))
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                put(MediaStore.MediaColumns.RELATIVE_PATH, DOSSIER)
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
        }
        val collection = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
        val insere = try {
            context.contentResolver.insert(collection, valeurs)
        } catch (erreur: Exception) {
            null
        }
        val uri: Uri = insere ?: return null
        try {
            context.contentResolver.openOutputStream(uri)?.use { sortie ->
                source.inputStream().use { entree -> entree.copyTo(sortie) }
            }
        } catch (erreur: Exception) {
            context.contentResolver.delete(uri, null, null)
            return null
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            valeurs.clear()
            valeurs.put(MediaStore.MediaColumns.IS_PENDING, 0)
            context.contentResolver.update(uri, valeurs, null, null)
        }
        // L'original prive a rempli son role : on le retire pour ne pas payer deux fois.
        source.delete()
        return uri.toString()
    }

    /** Dossier prive ou DownloadManager ecrit (aucune permission requise). */
    fun dossierPrive(context: Context): File {
        val dossier = File(context.getExternalFilesDir(Environment.DIRECTORY_MUSIC), "transfert")
        if (!dossier.exists()) dossier.mkdirs()
        return dossier
    }

    private fun duree(fichier: File): Long {
        return try {
            val lecteur = MediaMetadataRetriever()
            lecteur.setDataSource(fichier.absolutePath)
            val valeur = lecteur.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
            lecteur.release()
            valeur?.toLongOrNull() ?: 0L
        } catch (erreur: Exception) {
            0L
        }
    }
}
