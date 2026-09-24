package com.neurobeats.downloader

import android.app.DownloadManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import androidx.core.content.FileProvider
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Transfert des titres par le systeme.
 *
 * `DownloadManager` fournit ce que la maquette promet et qu'un telechargement
 * JavaScript ne sait pas faire : reprise apres coupure reseau, « Wi-Fi
 * uniquement », et surtout la survie a la fermeture de l'application.
 *
 * Les notifications du gestionnaire, elles, ne nous conviennent pas : une par
 * fichier, impossible a masquer sans la permission signature
 * `DOWNLOAD_WITHOUT_NOTIFICATION` que seule une application systeme detient
 * (`VISIBILITY_HIDDEN` est refuse avec une SecurityException). On choisit donc
 * la visibilite la plus discreete permise sans permission : aucune notification
 * pendant le transfert, une d'un coup a la fin de chaque fichier. Nos propres
 * notifications, c'est l'inverse : rien pendant le lot, **une seule rayure
 * finale** le resume — reussi, en partie reussi, ou echoue. L'ecran de
 * l'application, lui, suit en direct ce que le tiroir ne raconte pas.
 *
 * Les echanges avec JavaScript passent par du JSON : c'est verbeux, mais aucune
 * conversion de types ne peut se perdre en route.
 */
class DownloaderModule : Module() {

    internal val suivi = mutableMapOf<Long, Spec>()
    private var receveur: BroadcastReceiver? = null

    private val gestionnaire: DownloadManager?
        get() = appContext.reactContext
            ?.getSystemService(Context.DOWNLOAD_SERVICE) as? DownloadManager

    override fun definition() = ModuleDefinition {
        Name("NeuroBeatsDownloader")

        OnCreate {
            val contexte = appContext.reactContext ?: return@OnCreate
            garantirCanal(contexte)
            restaurer(contexte)
            val nouveau = object : BroadcastReceiver() {
                override fun onReceive(ctx: Context?, intent: Intent?) {
                    val id = intent?.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L) ?: -1L
                    if (id > 0) terminer(ctx ?: contexte, id)
                }
            }
            val filtre = IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                contexte.registerReceiver(nouveau, filtre, Context.RECEIVER_EXPORTED)
            } else {
                contexte.registerReceiver(nouveau, filtre)
            }
            receveur = nouveau
        }

        OnDestroy {
            receveur?.let { actif ->
                try {
                    appContext.reactContext?.unregisterReceiver(actif)
                } catch (erreur: Exception) {
                    // deja desenregistre : rien a faire
                }
            }
            receveur = null
        }

        /**
         * Pose les demandes aupres du gestionnaire du systeme.
         *
         * Rend la liste des identifiants refuses, et non un simple compte : le
         * gestionnaire peut manquer entierement (image Android sans fournisseur
         * de telechargements), et dans ce cas JavaScript doit pouvoir basculer
         * sur son propre telechargement au lieu de laisser des lignes « en
         * attente » qui ne bougeront jamais.
         *
         * `nomLot` groupe les demandes posees ensemble : elles partageront une
         * seule notification, nommee par la playlist quand l'application la
         * connait.
         */
        AsyncFunction("enqueue") { specsJson: String, wifiUniquement: Boolean, nomLot: String ->
            val specs = JSONArray(specsJson)
            val refuses = JSONArray()
            val contexte = appContext.reactContext
            val dm = gestionnaire
            // Sans contexte ni gestionnaire du systeme, rien ne peut etre pose :
            // on refuse tout, pour que JavaScript prenne le relais au lieu de
            // laisser des transferts en attente de rien.
            if (contexte == null || dm == null) {
                for (index in 0 until specs.length()) {
                    refuses.put(specs.getJSONObject(index).getString("videoId"))
                }
                return@AsyncFunction refuses.toString()
            }
            for (index in 0 until specs.length()) {
                val spec = Spec.depuis(specs.getJSONObject(index)).copy(lot = nomLot)
                if (suivi.containsValue(spec)) continue
                val destination = File(MediaStoreWriter.dossierPrive(contexte), spec.fichier)
                val requete = DownloadManager.Request(Uri.parse(spec.url)).apply {
                    setTitle(spec.titre)
                    setDescription(spec.chaine)
                    setNotificationVisibility(VISIBILITE_RETENUE)
                    setAllowedOverMetered(!wifiUniquement)
                    setAllowedOverRoaming(false)
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        setDestinationUri(Uri.fromFile(destination))
                    } else {
                        @Suppress("DEPRECATION")
                        setDestinationInExternalFilesDir(
                            contexte, Environment.DIRECTORY_MUSIC, spec.fichier
                        )
                    }
                }
                val id = try {
                    dm.enqueue(requete)
                } catch (erreur: Exception) {
                    Log.w(TAG, "demande refusee pour ${spec.videoId}", erreur)
                    refuses.put(spec.videoId)
                    continue
                }
                suivi[id] = spec
            }
            sauver(contexte)
            publierNotifications(contexte)
            refuses.toString()
        }

        AsyncFunction("etat") {
            val contexte = appContext.reactContext ?: return@AsyncFunction "[]"
            val dm = gestionnaire ?: return@AsyncFunction "[]"
            val sortie = JSONArray()
            val termines = mutableListOf<Long>()
            for ((id, spec) in suivi) {
                val mesure = mesurer(dm, id, spec)
                val ligne = JSONObject()
                ligne.put("videoId", spec.videoId)
                ligne.put("total", mesure.total)
                ligne.put("etat", mesure.etat)
                ligne.put("recus", mesure.recus)
                if (mesure.raison.isNotEmpty()) ligne.put("raison", mesure.raison)
                if (mesure.etat == "termine") {
                    ligne.put("uri", spec.uri ?: "")
                    if (spec.uri == null) termines.add(id)
                }
                sortie.put(ligne)
            }
            for (id in termines) terminer(contexte, id)
            publierNotifications(contexte)
            sortie.toString()
        }

        /**
         * Relance un transfert interrompu.
         *
         * Android n'a pas de mise en pause : la demande a ete retiree, on en
         * repose donc une, depuis le debut — l'ecran dit « Relancer », pas
         * « Reprendre ». `wifiUniquement` est repasse ici parce qu'une relance
         * doit obeir au meme reglage que le premier depart ; sans lui, elle
         * consommerait des donnees mobiles, ce que le reglage promet d'eviter.
         * La relance rejoint le lot d'origine : pas de nouvelle notification.
         */
        AsyncFunction("reprendre") { videoId: String, wifiUniquement: Boolean ->
            val contexte = appContext.reactContext ?: return@AsyncFunction
            val spec = suivi.values.firstOrNull { it.videoId == videoId } ?: return@AsyncFunction
            suivi.entries.removeAll { it.value == spec }
            val dm = gestionnaire ?: return@AsyncFunction
            val destination = File(MediaStoreWriter.dossierPrive(contexte), spec.fichier)
            val requete = DownloadManager.Request(Uri.parse(spec.url)).apply {
                setTitle(spec.titre)
                setDescription(spec.chaine)
                setNotificationVisibility(VISIBILITE_RETENUE)
                setAllowedOverMetered(!wifiUniquement)
                setAllowedOverRoaming(false)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    setDestinationUri(Uri.fromFile(destination))
                } else {
                    @Suppress("DEPRECATION")
                    setDestinationInExternalFilesDir(
                        contexte, Environment.DIRECTORY_MUSIC, spec.fichier
                    )
                }
            }
            suivi[dm.enqueue(requete)] = spec.copy(uri = null)
            sauver(contexte)
            publierNotifications(contexte)
        }

        AsyncFunction("annuler") { videoId: String ->
            val contexte = appContext.reactContext
            val spec = suivi.values.firstOrNull { it.videoId == videoId }
            gestionnaire?.let { dm ->
                for ((id, valeur) in suivi) if (valeur.videoId == videoId) dm.remove(id)
            }
            suivi.entries.removeAll { it.value.videoId == videoId }
            // Un fichier a demi recu n'est pas un titre : il ne doit pas rester
            // occuper la place apres un arret.
            if (contexte != null) {
                if (spec != null) {
                    File(MediaStoreWriter.dossierPrive(contexte), spec.fichier).delete()
                }
                sauver(contexte)
                publierNotifications(contexte)
            }
        }

        /**
         * Retire un titre du telephone : le transfert en cours, puis le fichier.
         *
         * La copie d'un titre arrive est publiee dans la bibliotheque du
         * telephone ; un simple `File.delete()` la retirerait du disque sans
         * retirer son entree MediaStore, laissant un morceau fantome dans les
         * autres lecteurs. On passe donc par le ContentResolver.
         */
        AsyncFunction("supprimer") { videoId: String, uri: String ->
            val contexte = appContext.reactContext ?: return@AsyncFunction
            val spec = suivi.values.firstOrNull { it.videoId == videoId }
            if (spec != null) {
                gestionnaire?.let { dm ->
                    for ((id, valeur) in suivi) if (valeur.videoId == videoId) dm.remove(id)
                }
                suivi.entries.removeAll { it.value.videoId == videoId }
                File(MediaStoreWriter.dossierPrive(contexte), spec.fichier).delete()
                sauver(contexte)
            }
            supprimerUri(contexte, uri)
            publierNotifications(contexte)
        }

        AsyncFunction("verifier") { urisJson: String ->
            val contexte = appContext.reactContext ?: return@AsyncFunction "[]"
            val presents = JSONArray()
            try {
                val demandees = JSONArray(urisJson)
                for (index in 0 until demandees.length()) {
                    val uri = demandees.getString(index)
                    if (uri.isEmpty() || !fichierPresent(contexte, uri)) continue
                    presents.put(uri)
                }
            } catch (erreur: Exception) {
                // entree abimee : rien de present, la verification rejouera plus tard
            }
            presents.toString()
        }

        /**
         * Partage un lot de titres avec une autre application.
         *
         * Les titres publies dans la bibliotheque sont deja des `content://`,
         * partageables tels quels. Les autres — sortis sans publication, ou
         * transferts JavaScript — vivent dans le dossier prive en `file://`, que
         * personne ne peut lire depuis Android 7 : on les expose donc par
         * FileProvider, sous une autorite dediee, le temps du partage. `audio`
         * suffit au receveur : il connait le format du fichier de toute facon.
         */
        AsyncFunction("partager") { urisJson: String ->
            val contexte = appContext.reactContext ?: return@AsyncFunction
            val demandees = try {
                JSONArray(urisJson)
            } catch (erreur: Exception) {
                return@AsyncFunction
            }
            val partagables = mutableListOf<Uri>()
            for (index in 0 until demandees.length()) {
                val ruche = demandees.getString(index).takeIf { it.isNotEmpty() } ?: continue
                val uri = uriPartageable(contexte, ruche) ?: continue
                partagables.add(uri)
            }
            if (partagables.isEmpty()) return@AsyncFunction
            val intention = if (partagables.size == 1) {
                Intent(Intent.ACTION_SEND).apply { putExtra(Intent.EXTRA_STREAM, partagables[0]) }
            } else {
                Intent(Intent.ACTION_SEND_MULTIPLE).apply {
                    putExtra(Intent.EXTRA_STREAM, ArrayList(partagables))
                    clipData = ClipData.newUri(contexte.contentResolver, "titres", partagables[0])
                }
            }
            val choeur = Intent.createChooser(
                intention.apply {
                    type = "audio/*"
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                },
                "Partager les titres"
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            // Un contexte d'application ne tient pas de fenetre : le createChooser
            // doit partir sur sa propre tache, sinon rien ne s'affiche.
            contexte.startActivity(choeur)
        }
    }

    /** L'URI lisible par le receveur : `content://` tel quel, `file://` via FileProvider. */
    private fun uriPartageable(contexte: Context, brut: String): Uri? {
        val adresse = try {
            Uri.parse(brut)
        } catch (erreur: Exception) {
            return null
        }
        if (adresse.scheme == "content") return adresse
        if (adresse.scheme == "file") {
            val chemin = adresse.path ?: return null
            if (!File(chemin).exists()) return null
            return FileProvider.getUriForFile(
                contexte,
                "${contexte.packageName}.fileprovider",
                File(chemin)
            )
        }
        return null
    }

    /** Le fichier d'un titre existe-t-il vraiment (`content://` publie ou `file://` prive) ?
     *
     * La reponse sert a dire « chez toi » sans mentir : une URI dont le fichier
     * a disparu (nettoyage systeme, suppression externe) doit retomber a
     * « absent », sinon le titre s'affiche partout comme recu alors que rien ne
     * se lit.
     */
    private fun fichierPresent(contexte: Context, uri: String): Boolean {
        return try {
            val adresse = Uri.parse(uri)
            when (adresse.scheme) {
                "content" -> contexte.contentResolver.query(
                    adresse, arrayOf(MediaStore.MediaColumns.SIZE), null, null, null
                )?.use { curseur ->
                    if (!curseur.moveToFirst()) return false
                    curseur.getLong(0) > 0L
                } ?: false
                "file" -> {
                    val fichier = File(adresse.path ?: return false)
                    fichier.exists() && fichier.length() > 0L
                }
                else -> false
            }
        } catch (erreur: Exception) {
            false
        }
    }

    /** Efface la copie d'un titre, publiee (`content://`) ou privee (`file://`). */
    private fun supprimerUri(contexte: Context, uri: String) {
        if (uri.isEmpty()) return
        try {
            val adresse = Uri.parse(uri)
            when (adresse.scheme) {
                "content" -> contexte.contentResolver.delete(adresse, null, null)
                "file" -> File(adresse.path ?: return).delete()
            }
        } catch (erreur: Exception) {
            // deja efface, ou efface entre-temps : rien a faire
        }
    }

    /** Le transfert est fini : on publie le fichier et on retient son URI. */
    private fun terminer(contexte: Context, id: Long) {
        val spec = suivi[id] ?: return
        val fichier = File(MediaStoreWriter.dossierPrive(contexte), spec.fichier)
        val uri = MediaStoreWriter.publier(
            contexte, fichier, spec.titre, spec.chaine, spec.album
        )
        if (uri != null) {
            suivi[id] = spec.copy(uri = uri)
        } else if (fichier.exists() && fichier.length() > 0L) {
            // Publication impossible mais le fichier est bien la : l'URI privee
            // suffit a la lecture. Faux et signale, ce n'est plus l'application
            // qui decide — le fichier reel fait foi.
            suivi[id] = spec.copy(uri = Uri.fromFile(fichier).toString())
        } else {
            // Ni publie ni present : pretendre posseder ce titre serait un
            // mensonge — l'ecran le dirait recu alors que rien ne se lit. Le
            // titre reste donc « a transferer » pour une prochaine tentative.
            suivi[id] = spec.copy(uri = null)
        }
        sauver(contexte)
        publierNotifications(contexte)
    }

    /** L'etat d'une demande tel que le gestionnaire du systeme le rapporte. */
    private data class EtatLu(
        val etat: String,
        val recus: Long,
        val total: Long,
        val raison: String
    )

    private fun mesurer(dm: DownloadManager, id: Long, spec: Spec): EtatLu {
        var etat = "en_cours"
        var recus = 0L
        var total = spec.taille
        var raison = ""
        try {
            val curseur: Cursor? = try {
                dm.query(DownloadManager.Query().setFilterById(id))
            } catch (erreur: Exception) {
                null
            }
            curseur?.use { c ->
                if (c.moveToFirst()) {
                    val statut = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                    recus = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
                    val complet = c.getLong(
                        c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)
                    )
                    if (complet > 0) total = complet
                    etat = when (statut) {
                        DownloadManager.STATUS_SUCCESSFUL -> "termine"
                        DownloadManager.STATUS_FAILED -> "echoue"
                        DownloadManager.STATUS_PAUSED -> "suspendu"
                        DownloadManager.STATUS_PENDING -> "en_file"
                        else -> "en_cours"
                    }
                    val code = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))
                    if (statut == DownloadManager.STATUS_FAILED) {
                        raison = raisonHumaine(code)
                    } else if (statut == DownloadManager.STATUS_PAUSED ||
                        statut == DownloadManager.STATUS_PENDING
                    ) {
                        // Une demande qui attend a une raison, et le systeme la
                        // connait : sans elle, l'ecran affiche « en attente » et
                        // l'utilisateur croit que rien ne se passe.
                        raison = attenteHumaine(code)
                    }
                } else {
                    // La ligne du systeme a disparu sans nous le dire (purge,
                    // demande retiree ailleurs). Un « termine » fantome sans
                    // fichier mentirait : on le dit.
                    etat = if (spec.uri != null) "termine" else "echoue"
                    if (spec.uri == null) {
                        raison = "Transfert introuvable sur le téléphone"
                    }
                }
            } ?: run {
                // Une journee de gestionnaire indisponible ne doit pas figer
                // la ligne en « en cours » eternel : on le dit aussi.
                etat = "echoue"
                raison = "Le téléphone ne suit plus ce transfert"
            }
        } catch (erreur: Exception) {
            etat = "echoue"
            raison = "Suivi du transfert interrompu"
        }
        return EtatLu(etat, recus, total, raison)
    }

    // ------------------------------------------------------------------
    // Une notification par lot — la finale seule.
    //
    // Le lot est le nom passe a `enqueue` (la playlist, le plus souvent). Le
    // systeme de son cote rassure un fichier a la fois (une notification a la
    // fin de chacun) ; nous, un seul rayon resume le lot quand il s'acheve tout
    // entier : reussi, en partie reussi, ou echoue. Tant que des demandes
    // vivent encore, on publie rien — le suivi en direct est l'affaire de
    // l'ecran de l'application. On ne republie enfin que ce qui a change
    // (empreinte) : a 700 ms de balayage, c'est ce qui evite de rappeler une
    // notification deja connue.
    // ------------------------------------------------------------------

    private fun garantirCanal(contexte: Context) {
        val gestion = contexte.getSystemService(NotificationManager::class.java) ?: return
        if (gestion.getNotificationChannel(CANAL_NOTIF) != null) return
        val canal = NotificationChannel(
            CANAL_NOTIF,
            "Transferts",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Résultats des titres récupérés sur le téléphone"
            setShowBadge(false)
            enableVibration(false)
            setSound(null, null)
        }
        gestion.createNotificationChannel(canal)
    }

    private fun publierNotifications(contexte: Context) {
        val dm = gestionnaire ?: return
        val gestion = contexte.getSystemService(NotificationManager::class.java) ?: return
        garantirCanal(contexte)
        val groupements = suivi.entries.groupBy { groupeDe(it.value) }
        val visibles = visiblesActuels()
        for ((lot, entrees) in groupements) {
            val mesures = entrees.map { (id, spec) -> mesurer(dm, id, spec) }
            val enCourse = mesures.filter { it.etat != "termine" && it.etat != "echoue" }
            if (enCourse.isNotEmpty()) continue
            val empreinte = empreinteDe(entrees, mesures)
            if (visibles[lot] == empreinte) continue
            val reussis = mesures.count { it.etat == "termine" }
            val echoues = mesures.count { it.etat == "echoue" }
            gestion.notify(idFinal(lot), rayonFinal(contexte, lot, reussis, echoues, mesures).build())
            visibles[lot] = empreinte
        }
        // Un lot vide n'a rien a montrer : ce sont des demandes annulees.
        for (lot in visibles.keys.toList()) {
            if (lot !in groupements) {
                gestion.cancel(idFinal(lot))
                visibles.remove(lot)
            }
        }
        if (visibles != visiblesActuels()) sauverVisibles(contexte, visibles)
    }

    private fun rayonFinal(
        contexte: Context,
        lot: String,
        reussis: Int,
        echoues: Int,
        mesures: List<EtatLu>
    ): Notification.Builder {
        val poidsReçu = mesures.filter { it.etat == "termine" }.sumOf { it.total }
        val titre = when {
            reussis > 0 && echoues == 0 -> "Transfert terminé"
            reussis > 0 -> "Transfert en partie terminé"
            else -> "Transfert échoué"
        }
        val texte = when {
            echoues > 0 ->
                "$reussis reçu${if (reussis > 1) "s" else ""} · " +
                    "$echoues échec${if (echoues > 1) "s" else ""} · ${mo(poidsReçu)} Mo"
            else ->
                "$reussis titre${if (reussis > 1) "s" else ""} reçu${if (reussis > 1) "s" else ""} · " +
                    "${mo(poidsReçu)} Mo"
        }
        return baseBuilder(contexte, lot).apply {
            setAutoCancel(true)
            setContentTitle(titre)
            setContentText(texte)
            setCategory(Notification.CATEGORY_STATUS)
            setProgress(0, 0, false)
        }
    }

    private fun baseBuilder(contexte: Context, lot: String): Notification.Builder {
        val intent = contexte.packageManager.getLaunchIntentForPackage(contexte.packageName)
        return Notification.Builder(contexte, CANAL_NOTIF).apply {
            setSmallIcon(contexte.applicationInfo.icon)
            setShowWhen(false)
            setOnlyAlertOnce(true)
            if (intent != null) {
                setContentIntent(PendingIntent.getActivity(
                    contexte, lot.hashCode() and 0x3FFF, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                ))
            }
        }
    }

    private fun empreinteDe(
        entrees: List<Map.Entry<Long, Spec>>,
        mesures: List<EtatLu>
    ): String {
        val paires = entrees.sortedBy { it.value.videoId }.zip(mesures)
        return paires.joinToString("|") { (paire, etat) ->
            "${paire.value.videoId}:${etat.etat}:${etat.recus}:${etat.total}:${etat.raison}"
        }
    }

    private fun groupeDe(spec: Spec): String = spec.lot.ifBlank { LOT_DEFAUT }

    private fun mo(octets: Long): Long = octets / (1024L * 1024L)

    private fun idFinal(lot: String): Int = BASE_FINAL + (lot.hashCode() and 0x3FFF)

    // ------------------------------------------------------------------
    // Persistance
    // ------------------------------------------------------------------

    /** Les transferts suivis survivent au redemarrage de l'application. */
    private fun sauver(contexte: Context) {
        val sortie = JSONArray()
        for ((id, spec) in suivi) {
            val ligne = spec.versJson()
            ligne.put("managerId", id)
            sortie.put(ligne)
        }
        contexte.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString(CLE, sortie.toString()).apply()
    }

    private fun restaurer(contexte: Context) {
        val brut = contexte.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(CLE, null) ?: return
        try {
            val tableau = JSONArray(brut)
            for (index in 0 until tableau.length()) {
                val ligne = tableau.getJSONObject(index)
                val id = ligne.optLong("managerId", -1L)
                if (id > 0) suivi[id] = Spec.depuis(ligne)
            }
        } catch (erreur: Exception) {
            // entree abimee : on repart d'un suivi vide plutot que de planter
        }
    }

    /** Les lots vus par leur derniere notification : survive au redemarrage. */
    private fun visiblesActuels(): MutableMap<String, String> {
        val res = mutableMapOf<String, String>()
        try {
            val brut = appContext.reactContext
                ?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                ?.getString(CLE_VISIBLES, null) ?: return res
            val objet = JSONObject(brut)
            val cles = objet.keys()
            while (cles.hasNext()) {
                val cle = cles.next()
                res[cle] = objet.getString(cle)
            }
        } catch (erreur: Exception) {
            // entree abimee : on republie, sans plus
        }
        return res
    }

    private fun sauverVisibles(contexte: Context, visibles: Map<String, String>) {
        val objet = JSONObject()
        for ((lot, empreinte) in visibles) objet.put(lot, empreinte)
        contexte.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString(CLE_VISIBLES, objet.toString()).apply()
    }

    /** Pourquoi une demande attend encore : le systeme le dit, on le repete. */
    private fun attenteHumaine(code: Int): String = when (code) {
        DownloadManager.PAUSED_QUEUED_FOR_WIFI -> "en attente du Wi-Fi"
        DownloadManager.PAUSED_WAITING_FOR_NETWORK -> "en attente du reseau"
        DownloadManager.PAUSED_WAITING_TO_RETRY -> "nouvelle tentative en cours"
        else -> ""
    }

    private fun raisonHumaine(code: Int): String = when (code) {
        DownloadManager.ERROR_INSUFFICIENT_SPACE -> "Espace insuffisant sur le téléphone"
        DownloadManager.ERROR_DEVICE_NOT_FOUND -> "Stockage du téléphone indisponible"
        DownloadManager.ERROR_FILE_ERROR -> "Fichier illisible côté téléphone"
        DownloadManager.ERROR_HTTP_DATA_ERROR,
        DownloadManager.ERROR_UNHANDLED_HTTP_CODE -> "Le transfert s'est interrompu"
        DownloadManager.ERROR_TOO_MANY_REDIRECTS,
        DownloadManager.ERROR_UNKNOWN -> "Le bureau ne répond plus"
        DownloadManager.ERROR_CANNOT_RESUME -> "Reprise impossible, relance le transfert"
        else -> "Échec du transfert"
    }

    companion object {
        private const val PREFS = "neurobeats-downloader"
        private const val CLE = "suivi"
        private const val CLE_VISIBLES = "visibles"
        private const val CANAL_NOTIF = "neurobeats-transfert"
        private const val LOT_DEFAUT = "Transfert"
        private const val BASE_FINAL = 130000
        /**
         * La plus discrète visible sans permission signature : aucune
         * notification pendant le fichier, une seule à sa fin.
         * `VISIBILITY_HIDDEN` (2) exige `DOWNLOAD_WITHOUT_NOTIFICATION` et est
         * refusé avec une SecurityException.
         */
        private const val VISIBILITE_RETENUE =
            DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_ONLY_COMPLETION
        /** Journal des refus du gestionnaire du systeme : visibles dans logcat. */
        private const val TAG = "NeuroBeats"
    }
}

/** Une demande de transfert, telle que l'application la decrit. */
data class Spec(
    val videoId: String,
    val url: String,
    val fichier: String,
    val titre: String,
    val chaine: String,
    val album: String,
    val taille: Long = 0L,
    val uri: String? = null,
    val lot: String = ""
) {
    fun versJson(): JSONObject = JSONObject().apply {
        put("videoId", videoId)
        put("url", url)
        put("fichier", fichier)
        put("titre", titre)
        put("chaine", chaine)
        put("album", album)
        put("taille", taille)
        put("uri", uri ?: JSONObject.NULL)
        put("lot", lot)
    }

    companion object {
        fun depuis(objet: JSONObject): Spec = Spec(
            videoId = objet.getString("videoId"),
            url = objet.getString("url"),
            fichier = objet.getString("fichier"),
            titre = objet.optString("titre"),
            chaine = objet.optString("chaine"),
            album = objet.optString("album"),
            taille = objet.optLong("taille", 0L),
            uri = if (objet.isNull("uri")) null else objet.optString("uri"),
            lot = objet.optString("lot")
        )
    }
}