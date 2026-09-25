/**
 * Orchestration du transfert : qui télécharge quoi, et où on en est.
 *
 * Deux chemins, et ils ne promettent pas la même chose — l'écran emploie donc
 * deux vocabulaires :
 *
 * - **module natif (DownloadManager)**, le chemin fiable : il survit à la
 *   fermeture de l'application, reprend de lui-même après une coupure réseau et
 *   honore « Wi-Fi uniquement ». En revanche Android n'offre aucune mise en
 *   pause : arrêter une demande la supprime, et la relancer repart du début.
 *   D'où « Arrêter » et « Relancer », jamais « Pause ».
 * - **téléchargement JavaScript**, quand le module n'est pas compilé dans la
 *   version installée — ou quand le transfert est né du navigateur : `DownloadTask`
 *   garde ses données de reprise, donc « Mettre en pause » puis « Reprendre »
 *   continue le fichier au lieu de le recommencer, et l'avancement se voit dans
 *   l'écran. Mais fermer l'application l'interrompt.
 *
 * Un transfert direct (audio extrait d'une vidéo, lancé depuis le navigateur)
 * emprunte TOUJOURS le moteur yt-dlp embarqué : le `DownloadManager` du système
 * est capricieux sur les URL de flux (pas d'en-têtes, reprises en boucle sans
 * fin sur certains téléphones), et un `DownloadTask` dépouillé se fait refuser
 * les flux YouTube (403 googlevideo : ils exigent le contexte d'extraction —
 * PoToken, signatures, en-têtes). Le moteur rejoue donc sa propre extraction et
 * écrit le fichier, qu'on rapatrie ensuite dans DOSSIER_TRANSFERT.
 * Un téléchargement lancé les yeux sur l'écran n'a pas besoin de survivre à la
 * fermeture de l'application.
 */
import { File, DownloadTask } from "expo-file-system";
import { YtDlp, YtDlpError, type DownloadResult } from "ytdlp-react-native";

import * as module from "modules/downloader";
import type { Spec, Suivi } from "modules/downloader";

import { DOSSIER_TRANSFERT, assurerDossier, supprimerFichier, tailleDe } from "@/fichiers/dossiers";

export type { Spec, Suivi };
export type { EtatTelechargement } from "modules/downloader";

export const transfertPersistant = module.transfertPersistant;

export type Options = {
  wifiUniquement: boolean;
};

/** États qui attendent encore quelque chose : les seuls qu'on puisse arrêter. */
const EN_ATTENTE: Suivi["etat"][] = ["en_file", "en_cours", "suspendu", "echoue"];

/** Espacement des relances automatiques : on laisse respirer le réseau. */
const DELAIS_RELANCE = [5000, 15000, 30000, 60000, 120000];

/**
 * Une panne qui mérite une relance automatique : le réseau ou YouTube qui
 * souffle un instant, pas un contenu définitivement inaccessible. Le module
 * natif classe les 403 en `NETWORK_ERROR`, mais une résolution DNS capricieuse
 * sort parfois en `DOWNLOAD_FAILED` — la forme du message tranche.
 */
function estPanneTransitoire(erreur: unknown): boolean {
  if (erreur instanceof YtDlpError) {
    if (erreur.code === "NETWORK_ERROR") return true;
    if (
      erreur.code === "EXTRACTION_FAILED" ||
      erreur.code === "DOWNLOAD_FAILED"
    ) {
      const message = erreur.message.toLowerCase();
      return /http error|connection|timed? ?out|unreachable|hostname|transport|reset by peer|couldn'?t connect|503|429|403/.test(
        message,
      );
    }
    return false;
  }
  return false;
}

/**
 * En-têtes des téléchargements JavaScript vers les flux vidéo : YouTube sert
 * ses fichiers (googlevideo) selon qui les demande, et un client sans
 * User-Agent ni Referer y essuie souvent un 403. Le module yt-dlp n'expose pas
 * les en-têtes d'un format, on reprend donc le trio standard qu'il poserait.
 */
const EN_TETES_VIDEO: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UD1A.230803.041) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  Accept: "*/*",
  Referer: "https://www.youtube.com/",
};

export class Gestionnaire {
  private suivis = new Map<string, Suivi>();
  private specs = new Map<string, Spec>();
  /** Titres retrouvés en base pour les transferts restaurés au démarrage. */
  private titres = new Map<string, string>();
  private taches = new Map<string, DownloadTask>();
  private annulations = new Set<string>();
  /** Transferts confiés au chemin JavaScript (nés du navigateur), jamais au système. */
  private directs = new Set<string>();
  /** Identifiants des tâches de téléchargement yt-dlp en cours, par titre. */
  private tachesYtDlp = new Map<string, string>();
  /** Essais de relance automatique par titre, pour ne pas assiéger le réseau. */
  private relances = new Map<string, { essai: number; prochain: number }>();
  /** Minuteurs de relance des directs, pour les effacer si l'on veut tenter neuf. */
  private relancesDirects = new Map<string, ReturnType<typeof setTimeout>>();
  private options: Options = { wifiUniquement: true };
  /** Vrai quand le système a refusé : on télécharge alors nous-mêmes. */
  private modeSecours = false;

  constructor(
    private readonly onChange: (suivis: Suivi[], modeSecours: boolean) => void,
    /** Résout les titres des transferts natifs repris après un redémarrage. */
    private readonly resoudreTitres?: (videoIds: string[]) => Promise<Map<string, string>>,
  ) {
  }

  regler(options: Partial<Options>) {
    this.options = { ...this.options, ...options };
  }

  lister(): Suivi[] {
    return [...this.suivis.values()];
  }

  /** Titre lisible d'un transfert : le module natif ne connaît que l'identifiant. */
  titreDe(videoId: string): string {
    return this.specs.get(videoId)?.titre ?? this.titres.get(videoId) ?? videoId;
  }

  /**
   * Confie un ensemble de transferts.
   *
   * `nomLot` nomme la seule notification finale que le module natif affiche
   * pour ce lot, quand il est achevé. Les titres qui deviennent prêts après le
   * premier import partagent le nom de la même playlist : ils rejoignent le
   * lot au lieu d'ouvrir chacun leur propre notification. (Le système, lui,
   * notifie autant de fois qu'il y a de fichiers — impossible à masquer sans
   * permission signature.)
   *
   * `direct` confie au téléchargement JavaScript, quel que soit le module : le
   * `DownloadManager` du système est trop fragile sur les URL de flux pour le
   * téléchargement lancé depuis le navigateur.
   */
  enFile(specs: Spec[], nomLot = "", options: { direct?: boolean } = {}) {
    const direct = options.direct ?? false;
    for (const spec of specs) {
      this.specs.set(spec.videoId, spec);
      // Une demande nouveau jeu : ni annulation passée, ni relance à reprendre.
      this.annulations.delete(spec.videoId);
      this.relances.delete(spec.videoId);
      // La marque « direct » suit le titre tant qu'il vit dans la tâche
      // JavaScript ; un retour dans le circuit du système (import depuis
      // l'ordinateur) la lave, sinon ses boutons Relancer/Arrêter passeraient
      // à côté de la demande native.
      if (direct) this.directs.add(spec.videoId);
      else this.directs.delete(spec.videoId);
      this.suivis.set(spec.videoId, {
        videoId: spec.videoId,
        // Un direct démarre tout de suite : pas de ligne « en attente », même
        // le temps d'un rendu.
        etat: direct ? "en_cours" : "en_file",
        recus: 0,
        total: spec.taille ?? 0,
      });
    }
    this.publier();
    if (!direct && module.transfertPersistant) {
      void this.confierAuSysteme(specs, nomLot);
      return;
    }
    for (const spec of specs) void this.enJavaScript(spec);
  }

  /**
   * Confie les transferts au gestionnaire du système.
   *
   * S'il les refuse tous, c'est que le téléphone n'a pas de gestionnaire de
   * téléchargements utilisable : on bascule sur le téléchargement interne, et
   * l'écran le dit — plutôt que de laisser des lignes « en attente » qui
   * n'attendent rien. Un refus partiel, lui, se voit ligne par ligne.
   */
  private async confierAuSysteme(specs: Spec[], nomLot: string) {
    const refuses = await module.mettreEnFile(specs, this.options.wifiUniquement, nomLot);
    if (refuses.length === 0) return;
    if (refuses.length === specs.length) {
      this.modeSecours = true;
      this.publier();
      for (const spec of specs) void this.enJavaScript(spec);
      return;
    }
    for (const videoId of refuses) {
      this.maj(videoId, {
        etat: "echoue",
        raison: "Le téléphone a refusé la demande de téléchargement",
      });
    }
  }

  /**
   * Suit une tâche JavaScript jusqu'à son terme.
   *
   * Le même code sert au démarrage et à la reprise : `DownloadTask` résout avec
   * `null` quand on lui demande de se mettre en pause, et c'est ce cas qui laisse
   * la tâche en table, données de reprise comprises.
   */
  private async suivre(spec: Spec, operation: Promise<File | null>) {
    try {
      const resultat = await operation;
      if (!resultat) {
        this.maj(spec.videoId, { etat: "suspendu" });
        return;
      }
      this.taches.delete(spec.videoId);
      if (this.annulations.has(spec.videoId)) return;
      const taille = tailleDe(resultat);
      this.maj(spec.videoId, { etat: "termine", recus: taille, total: taille, uri: resultat.uri });
    } catch (erreur) {
      this.taches.delete(spec.videoId);
      // Une annulation fait aussi échouer la promesse : ce n'est pas une panne.
      if (this.annulations.has(spec.videoId)) return;
      const message = erreur instanceof Error ? erreur.message : "Échec du téléchargement";
      console.warn(`[transfert] échec ${spec.videoId} : ${message}`);
      this.maj(spec.videoId, {
        etat: "echoue",
        raison: message,
      });
    }
  }

  private async enJavaScript(spec: Spec) {
    // Un direct (né du navigateur) repasse par le moteur yt-dlp : l'URL de flux
    // qu'il a produite ne supporte pas un second téléchargement dépouillé — un
    // `DownloadTask` sans le contexte d'extraction se fait refuser (403).
    if (this.directs.has(spec.videoId)) {
      await this.enDirect(spec);
      return;
    }
    this.maj(spec.videoId, { etat: "en_cours" });
    assurerDossier(DOSSIER_TRANSFERT);
    const cible = new File(DOSSIER_TRANSFERT, spec.fichier);
    // Une reprise continue la tâche en cours, elle ne repart pas d'un fichier
    // laissé là : ce qui traîne ici est un reliquat (application fermée en plein
    // transfert) et serait refusé comme destination déjà existante.
    supprimerFichier(cible);
    const tache = new DownloadTask(spec.url, cible, {
      headers: EN_TETES_VIDEO,
      onProgress: (progression) =>
        this.maj(spec.videoId, {
          recus: progression.bytesWritten,
          total: progression.totalBytes || spec.taille || 0,
        }),
    });
    this.taches.set(spec.videoId, tache);
    await this.suivre(spec, tache.downloadAsync());
  }

  /**
   * Télécharge un audio direct avec le moteur yt-dlp embarqué.
   *
   * Le moteur sait négocier ce que le `DownloadTask` ne pouvait pas reproduire
   * (PoToken, signatures, en-têtes) : il rejoue sa propre extraction puis écrit
   * dans son dossier de travail (stockage externe de l'application). Le fichier
   * terminé est rapatrié dans DOSSIER_TRANSFERT pour que la bibliothèque le voie
   * comme tout fichier possédé.
   */
  private async enDirect(spec: Spec) {
    this.maj(spec.videoId, { etat: "en_cours" });
    try {
      const tache = await YtDlp.download({
        url: `https://www.youtube.com/watch?v=${spec.videoId}`,
        // Même ordre que la feuille d'extraction : m4a d'abord, sinon ce que la
        // source propose.
        format: "bestaudio[ext=m4a]/bestaudio/best",
        // Depuis yt-dlp 2026.08.19 les clients par défaut (visionos /
        // web_embedded) ne renvoient plus d'URL mortes : on ne force plus aucun
        // player_client (forcer android exigerait un PoToken GVS, cf §59).
        output: {
          directory: "transfert",
          filename: "%(id)s - %(title)s.%(ext)s",
        },
      });
      this.tachesYtDlp.set(spec.videoId, tache.id);
      await this.suivreYtDlp(spec, tache);
    } catch (erreur) {
      this.echouerTransfert(spec, erreur);
    }
  }

  /**
   * Écoute une tâche yt-dlp jusqu'à son terme : avancement en direct, puis
   * rapatriement du fichier à la fin. La promesse ne sert pas la tâche, elle
   * borne simplement l'appelant — les événements portent le résultat.
   */
  private suivreYtDlp(
    spec: Spec,
    tache: Awaited<ReturnType<typeof YtDlp.download>>,
  ): Promise<void> {
    return new Promise((resoudre) => {
      let terminee = false;
      const finir = () => {
        this.tachesYtDlp.delete(spec.videoId);
        if (!terminee) {
          terminee = true;
          resoudre();
        }
      };
      tache.addListener("progress", (progression) =>
        this.maj(spec.videoId, {
          recus: progression.downloadedBytes ?? 0,
          total: progression.totalBytes || spec.taille || 0,
        }),
      );
      tache.addListener("completed", (resultat) => {
        finir();
        if (this.annulations.has(spec.videoId)) return;
        void this.accueillirFichier(spec, resultat);
      });
      tache.addListener("error", (erreur) => {
        finir();
        if (this.annulations.has(spec.videoId)) return;
        this.echouerTransfert(spec, erreur);
      });
      // Une annulation demandée par « Annuler » n'est pas une panne : l'état
      // « annule » a déjà été posé par l'appelant, on laisse la promesse finir.
      tache.addListener("state", (etat) => {
        if (etat.status === "cancelled" && !this.annulations.has(spec.videoId)) {
          finir();
          this.echouerTransfert(spec, new Error("Téléchargement annulé à la demande du module."));
        }
      });
    });
  }

  /**
   * Rapatrie le fichier écrit par yt-dlp dans le dossier de la bibliothèque.
   *
   * Le moteur nomme `%(id)s - %(title)s.%(ext)s` : la partie fixe (l'identifiant
   * vidéo) garantit l'unicité, y compris pour deux titres identiques.
   */
  private async accueillirFichier(spec: Spec, resultat: DownloadResult) {
    try {
      // Le moteur a annoncé la fin sans écrire de fichier (reliquat sur la
      // destination, annulation au dernier moment) : un chemin vide ne fait
      // rien de propre, autant le dire aussitôt.
      const chemin = resultat.uri ?? resultat.path ?? "";
      if (!chemin) {
        throw new Error("Le fichier téléchargé est introuvable.");
      }
      assurerDossier(DOSSIER_TRANSFERT);
      const source = new File(chemin);
      if (!source.exists) throw new Error("Le fichier téléchargé est introuvable.");
      const destination = new File(DOSSIER_TRANSFERT, resultat.filename ?? spec.fichier);
      supprimerFichier(destination);
      await source.move(destination);
      const taille = tailleDe(destination) || resultat.size || 0;
      this.maj(spec.videoId, {
        etat: "termine",
        recus: taille,
        total: taille,
        uri: destination.uri,
      });
    } catch (erreur) {
      // Le binaire a terminé mais le rapatriement a échoué : c'est un échec de
      // chargement à porter comme tel, le fichier ne peut pas manquer à l'arrivée.
      this.echouerTransfert(spec, erreur);
    }
  }

  /** Pose un échec sur le suivi, après l'avoir loggé pour logcat. */
  private echouerTransfert(spec: Spec, erreur: unknown) {
    const message = erreur instanceof Error ? erreur.message : "Échec du téléchargement";
    console.warn(`[transfert] échec ${spec.videoId} : ${message}`);
    this.maj(spec.videoId, { etat: "echoue", raison: message });
    this.siSourceStale(erreur);
    // Un direct vit dans le moteur yt-dlp, hors du regard de `rafraichir()` (qui
    // ne lit que les états du système). Les 403 YouTube sont souvent transitoires
    // (le retry manuel réussit) : on se relance tout seuls à espaces croissants,
    // l'utilisateur n'a pas à re-cliquer pour une source qui souffle un instant.
    if (this.directs.has(spec.videoId)) this.relancerDirect(spec, erreur);
  }

  /**
   * Relance automatiquement un téléchargement direct qui vient d'échouer.
   *
   * N'essaie que les pannes transitoires (un 403, un réseau qui se rebranche,
   * une résolution DNS capricieuse) : un refus définitif (vidéo retirée, région
   * bloquée, âge restreint) n'y survivrait pas, et assiéger la source serait pire
   * que de laisser la main à l'utilisateur. Les délais viennent de
   * `DELAIS_RELANCE`, comme les relances du système. Le module natif ne classe
   * pas toujours ces pannes en `NETWORK_ERROR` (un DNS qui ne répond pas sort
   * parfois en `DOWNLOAD_FAILED`), on regarde donc aussi la forme du message.
   */
  private relancerDirect(spec: Spec, erreur: unknown) {
    if (!estPanneTransitoire(erreur)) return;
    const essai = this.relances.get(spec.videoId)?.essai ?? 0;
    if (essai >= DELAIS_RELANCE.length) return;
    // Le délai vient du rang d'échec, pas du temps écoulé depuis la relance
    // précédente : si la panne a fait patienter yt-dlp longtemps, le compteur
    // d'une relance dans le passé serait écrasé par une relance immédiate.
    const delai = DELAIS_RELANCE[essai];
    this.relances.set(spec.videoId, {
      essai: essai + 1,
      prochain: Date.now() + delai,
    });
    const minuteur = setTimeout(() => {
      this.relancesDirects.delete(spec.videoId);
      // L'utilisateur a pu reprendre lui-même pendant l'attente, ou annuler.
      if (this.annulations.has(spec.videoId)) return;
      const courant = this.lister().find((suivi) => suivi.videoId === spec.videoId);
      if (!courant || courant.etat !== "echoue") return;
      console.warn(`[transfert] relance auto ${spec.videoId} (essai ${essai + 1})`);
      // On relance le moteur directement : `reprendre()` effacerait le compteur,
      // et l'espacement des essais serait perdu — deux pannes de suite ne
      // doivent pas arriver dos à dos.
      const specActuelle = this.specs.get(spec.videoId);
      if (specActuelle) void this.enDirect(specActuelle);
    }, delai);
    this.relancesDirects.set(spec.videoId, minuteur);
  }

  /**
   * Un échec 403/réseau signale souvent un yt-dlp embarqué périmé : on propose
   * en arrière-plan la dernière version PyPI. Sans effet si déjà à jour ;
   * l'échec de l'update est silencieux (le runtime embarqué reste en place).
   */
  private siSourceStale(erreur: unknown) {
    if (!(erreur instanceof YtDlpError) || erreur.code !== "NETWORK_ERROR") return;
    YtDlp.updateYtDlp()
      .then((resultat) => {
        if (resultat.action === "updated") {
          console.warn(
            `[updater] yt-dlp activé en version ${resultat.version}, la source sera réessayée`,
          );
        }
      })
      .catch(() => {
        console.warn("[updater] indisponible (réseau ou PyPI) : runtime embarqué conservé");
      });
  }

  async rafraichir() {
    if (!module.transfertPersistant) return;
    const etats = await module.lireEtats();
    if (etats.length === 0) return;
    for (const etat of etats) {
      // Une ligne arrêtée par l'utilisateur ne renaît pas du seul fait que le
      // système la revoit : ce serait annuler puis voir le titre repartir.
      if (this.annulations.has(etat.videoId)) continue;
      this.suivis.set(etat.videoId, etat);
      // Une ligne arrivée à bon port lave les compteurs de relance. Une ligne
      // annulée par l'utilisateur, elle, reste en paix (see annulations).
      if (etat.etat === "termine") this.relances.delete(etat.videoId);
    }
    await this.resoudreLesTitresManquants();
    this.publier();
    this.relancerLesEchecs(etats);
  }

  /**
   * Relance tout seul un transfert qui vient d'échouer.
   *
   * Un échec isolé (réseau qui souffle, serveur en pleine préparation de ce
   * titre) ne doit pas demander à un humain de tout relancer : on réessaie à
   * espaces croissants, puis on s'efface pour ne pas assiéger une source morte.
   * L'utilisateur garde « Relancer » pour la main quand les essais sont épuisés.
   */
  private relancerLesEchecs(etats: Suivi[]) {
    const maintenant = Date.now();
    for (const etat of etats) {
      if (etat.etat !== "echoue") continue;
      // Un arrêt demandé par l'utilisateur n'est pas une panne à masquer.
      if (this.annulations.has(etat.videoId)) continue;
      const compte = this.relances.get(etat.videoId);
      const essai = compte?.essai ?? 0;
      if (essai >= DELAIS_RELANCE.length) continue;
      const prochain = compte?.prochain ?? maintenant;
      if (maintenant < prochain) continue;
      this.relances.set(etat.videoId, {
        essai: essai + 1,
        prochain: maintenant + DELAIS_RELANCE[essai],
      });
      void this.reprendre(etat.videoId);
    }
  }

  /**
   * Un transfert natif repris après un redémarrage revient sans son titre : le
   * module ne connaît que l'identifiant, et la table des demandes ne survit pas
   * à l'application. Sans cette résolution, l'écran afficherait un `video_id`.
   */
  private async resoudreLesTitresManquants() {
    if (!this.resoudreTitres) return;
    const inconnus = this.lister()
      .map((suivi) => suivi.videoId)
      .filter((videoId) => !this.specs.has(videoId) && !this.titres.has(videoId));
    if (inconnus.length === 0) return;
    const trouves = await this.resoudreTitres(inconnus);
    for (const [videoId, titre] of trouves) this.titres.set(videoId, titre);
  }

  async pause(videoId: string) {
    const tache = this.taches.get(videoId);
    if (!tache || tache.state !== "active") return;
    this.maj(videoId, { etat: "suspendu" });
    await tache.pauseAsync();
  }

  async reprendre(videoId: string) {
    // Une relance (manuelle ou automatique) repart d'un compteur neuf.
    this.relances.delete(videoId);
    // Chemin natif : c'est le module qui détient la demande (URL, nom de
    // fichier), y compris après un redémarrage de l'application — la table
    // JavaScript, elle, ne survit pas. Exiger une spec ici rendait « Relancer »
    // inopérant sur un transfert repris au démarrage. Un transfert né du
    // navigateur, lui, ne va jamais voir le système : c'est la tâche JavaScript
    // qui reprend.
    if (module.transfertPersistant && !this.directs.has(videoId)) {
      this.annulations.delete(videoId);
      this.maj(videoId, { etat: "en_file", recus: 0, raison: undefined, uri: undefined });
      return module.reprendre(videoId, this.options.wifiUniquement);
    }
    const spec = this.specs.get(videoId);
    if (!spec) return;
    const tache = this.taches.get(videoId);
    this.annulations.delete(videoId);
    if (tache?.state === "paused") {
      this.maj(videoId, { etat: "en_cours" });
      await this.suivre(spec, tache.resumeAsync());
      return;
    }
    // Plus rien à reprendre (tâche perdue, échec) : on refait le transfert.
    await this.enJavaScript(spec);
  }

  async annuler(videoId: string) {
    this.annulations.add(videoId);
    this.relances.delete(videoId);
    // Un transfert direct vit dans le moteur yt-dlp ou la tâche JavaScript : le
    // système n'a jamais entendu parler de lui, l'y chercher serait sans effet.
    if (module.transfertPersistant && !this.directs.has(videoId)) {
      await module.annuler(videoId);
      this.maj(videoId, { etat: "annule" });
      return;
    }
    // Une tâche yt-dlp s'annule par le module : le binaire efface lui-même le
    // fichier partiel. Une tâche `DownloadTask`, elle, garde un fichier à demi
    // reçu qu'il faut effacer.
    const idYt = this.tachesYtDlp.get(videoId);
    if (idYt) {
      this.tachesYtDlp.delete(videoId);
      void YtDlp.cancel(idYt);
    } else {
      const tache = this.taches.get(videoId);
      this.taches.delete(videoId);
      tache?.cancel();
      this.supprimerPartiel(videoId);
    }
    this.maj(videoId, { etat: "annule" });
  }

  /**
   * Arrête ce qui n'est pas terminé.
   *
   * Les transferts terminés ne sont pas touchés : les marquer « arrêtés »
   * effacerait de la liste ce qui vient justement d'arriver.
   */
  async toutAnnuler() {
    const arreter = this.lister().filter((suivi) => EN_ATTENTE.includes(suivi.etat));
    for (const suivi of arreter) await this.annuler(suivi.videoId);
  }

  /** Reprend le suivi quand l'application revient au premier plan. */
  demarrerLeSuivi(): () => void {
    let actif = true;
    // Une interrogation lente (DownloadManager sous charge) ne doit jamais
    // s'empiler : `setInterval` relançait `rafraichir` même quand le tour
    // précédent n'était pas fini, et chaque appel natif passe par la file
    // unique d'expo-modules-core — la même que la caméra. Saturée, elle
    // retardait d'autant la demande de permission. On attend donc la fin du
    // tour avant d'en programmer le prochain.
    const boucle = async () => {
      if (!actif) return;
      try {
        await this.rafraichir();
      } catch {
        // Une lecture d'état en échec ne tue pas le suivi : le prochain tour
        // réessaie, comme chaque tick de l'ancien `setInterval` le faisait.
      }
      if (actif) minuteur = setTimeout(boucle, 700);
    };
    let minuteur = setTimeout(boucle, 700);
    return () => {
      actif = false;
      clearTimeout(minuteur);
    };
  }

  /** Un fichier à demi reçu n'est pas un titre : il ne doit pas occuper la place. */
  private supprimerPartiel(videoId: string) {
    const spec = this.specs.get(videoId);
    if (!spec) return;
    supprimerFichier(new File(DOSSIER_TRANSFERT, spec.fichier));
  }

  private maj(videoId: string, partiel: Partial<Suivi>) {
    const courant = this.suivis.get(videoId);
    if (!courant) return;
    this.suivis.set(videoId, { ...courant, ...partiel });
    this.publier();
  }

  private publier() {
    this.onChange(this.lister(), this.modeSecours);
  }
}
