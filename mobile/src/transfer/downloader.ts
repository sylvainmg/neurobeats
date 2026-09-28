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

import {
  DOSSIER_TRANSFERT,
  assurerDossier,
  ecrireTexteDocument,
  fichierTransfert,
  lireTexteDocument,
  supprimerFichier,
  tailleDe,
} from "@/fichiers/dossiers";
import {
  FICHIER_DIRECTS_PERDUS,
  fusionnerDirectPerdu,
  retirerDirectPerdu,
  type DirectPerdu,
} from "@/transfer/directsPerdus";
import { estLivre, estReprisable } from "@/transfer/relance";

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
 * Raison affichée quand le fichier est arrivé mais que son dépôt dans la
 * bibliothèque publique échoue encore.
 *
 * Elle sert de marqueur : c'est le seul cas où un titre est `en_cours` sans
 * qu'aucun octet ne soit en route, donc le seul qui mérite une reprise
 * automatique. La constante évite de comparer une chaîne écrite ailleurs, ce
 * qui avait déjà fait passer un lot de 28 titres sans que rien ne se
 * déclenche.
 */
const RATION_PUBLICATION = "Publication dans la bibliothèque en attente…";

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
 * Veille de la file des téléchargements directs.
 *
 * Une extraction yt-dlp est parfois lente (résolution, défi EJS) : on laisse
 * deux minutes sans le moindre signe — état annoncé ou octets reçus — avant de
 * la tenir pour morte. C'est la contrepartie de la sérialisation : à un seul
 * direct à la fois, une tâche muette figerait toute la file au lieu de la
 * ralentir.
 */
const VEILLE_DIRECT_MS = 15_000;
const DELAI_DIRECT_MUET_MS = 120_000;

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

/** Les traces de directs achevés restés à l'extérieur, depuis le fichier. */
function lireDirectsPerdus(): DirectPerdu[] {
  const brut = lireTexteDocument(FICHIER_DIRECTS_PERDUS);
  if (!brut) return [];
  try {
    const parse = JSON.parse(brut);
    return Array.isArray(parse) ? (parse as DirectPerdu[]) : [];
  } catch {
    return [];
  }
}

/** Aide le prochain démarrage à retrouver un fichier achevé non rapatrié. */
function memoriserDirectPerdu(entree: DirectPerdu) {
  ecrireTexteDocument(
    FICHIER_DIRECTS_PERDUS,
    JSON.stringify(fusionnerDirectPerdu(lireDirectsPerdus(), entree)),
  );
}

/** Le fichier est arrivé à bon port (ou l'on n'y croit plus) : trace effacée. */
function oublierDirectPerdu(videoId: string) {
  ecrireTexteDocument(
    FICHIER_DIRECTS_PERDUS,
    JSON.stringify(retirerDirectPerdu(lireDirectsPerdus(), videoId)),
  );
}

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
  /** Titres directs qui attendent leur tour : une extraction à la fois. */
  private fileDirecte: Spec[] = [];
  /** Le direct que le moteur traite en ce moment, s'il y en a un. */
  private directEnCours: string | null = null;
  /** Dernier signe de vie de chaque direct (état annoncé ou octets reçus). */
  private signesDirects = new Map<string, number>();
  /** Directs abandonnés par la veille : leur motif d'échec est déjà posé. */
  private muets = new Set<string>();
  /**
   * Titres dont la possession est déjà écrite en base.
   *
   * Un suivi achevé reste en mémoire (l'écran en a besoin pour son compte), mais
   * sa possession ne doit être écrite qu'une fois : sans ce garde, un titre
   * retiré du téléphone était re-marqué « chez toi » à la seconde suivante, avec
   * son ancienne URI — le retrait semblait n'avoir rien fait.
   */
  private possessionsEcrites = new Set<string>();
  /** Veille sur la file : un direct muet ne doit pas la figer pour toujours. */
  private veilleDirect: ReturnType<typeof setInterval> | null = null;
  /**
   * Titres téléchargés dont la publication dans la bibliothèque n'a pas
   * abouti.
   *
   * Ils sont dans l'état `en_cours` sans qu'aucun octet ne soit en route :
   * rien, dans l'état seul, ne les distingue d'un téléchargement normal, et
   * la passe de relance les ignorait. Sur un lot de 28 titres, ces quelques
   * lignes restaient bloquées jusqu'au rescan suivant.
   */
  private publicationsBloquees = new Set<string>();
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

  /** La possession de ce titre est-elle déjà écrite en base ? */
  possessionEcrite(videoId: string): boolean {
    return this.possessionsEcrites.has(videoId);
  }

  /**
   * Marque la possession comme écrite.
   *
   * Appelé après l'enregistrement en base : un suivi achevé ne doit plus la
   * réécrire, sinon un titre retiré du téléphone reviendrait « chez toi » tout
   * seul. Un nouveau transfert du même titre efface la marque (voir `enFile`).
   */
  marquerPossessionEcrite(videoId: string) {
    this.possessionsEcrites.add(videoId);
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
      // Un nouveau transfert devra réécrire sa possession, même si un précédent
      // l'avait déjà fait (titre retiré puis retéléchargé).
      this.possessionsEcrites.delete(spec.videoId);
      // La marque « direct » suit le titre tant qu'il vit dans la tâche
      // JavaScript ; un retour dans le circuit du système (import depuis
      // l'ordinateur) la lave, sinon ses boutons Relancer/Arrêter passeraient
      // à côté de la demande native.
      if (direct) this.directs.add(spec.videoId);
      else this.directs.delete(spec.videoId);
      this.suivis.set(spec.videoId, {
        videoId: spec.videoId,
        // Un direct attend son tour dans la file : il est « en file » tant que
        // le moteur ne l'a pas pris, et le dit honnêtement.
        etat: "en_file",
        recus: 0,
        total: spec.taille ?? 0,
      });
    }
    this.publier();
    if (!direct && module.transfertPersistant) {
      void this.confierAuSysteme(specs, nomLot);
      return;
    }
    if (direct) {
      // Un direct à la fois : le moteur, lui, n'a aucune limite — il exécute
      // chaque tâche dans son propre thread (`Executors.newCachedThreadPool`).
      // Vingt-huit extractions Python en parallèle font limiter YouTube (403,
      // 429) et échouer la moitié du lot ; mises à la queue leu leu, elles
      // passent. C'est la différence entre « reprendre trois fois » et une fois.
      for (const spec of specs) this.mettreEnFileDirecte(spec);
      return;
    }
    for (const spec of specs) void this.enJavaScript(spec);
  }

  /** Ajoute un direct à la file d'attente, s'il n'y est pas déjà. */
  private mettreEnFileDirecte(spec: Spec) {
    if (this.directEnCours === spec.videoId) return;
    if (this.fileDirecte.some((attendu) => attendu.videoId === spec.videoId)) return;
    this.fileDirecte.push(spec);
    this.demarrerDirectSuivant();
  }

  /** Lance le prochain direct de la file — un seul parle au moteur à la fois. */
  private demarrerDirectSuivant() {
    if (this.directEnCours) return;
    let spec = this.fileDirecte.shift();
    // Un titre annulé pendant son attente ne part pas.
    while (spec && this.annulations.has(spec.videoId)) spec = this.fileDirecte.shift();
    if (!spec) {
      this.arreterVeilleDirect();
      return;
    }
    this.directEnCours = spec.videoId;
    this.signeDirect(spec.videoId);
    this.demarrerVeilleDirect();
    void this.enJavaScript(spec).finally(() => {
      if (this.directEnCours === spec.videoId) this.directEnCours = null;
      this.demarrerDirectSuivant();
    });
  }

  /** Note que le direct en cours donne signe de vie (état ou octets reçus). */
  private signeDirect(videoId: string) {
    this.signesDirects.set(videoId, Date.now());
  }

  private demarrerVeilleDirect() {
    if (this.veilleDirect) return;
    this.veilleDirect = setInterval(() => this.verifierDirectVivant(), VEILLE_DIRECT_MS);
  }

  private arreterVeilleDirect() {
    if (this.veilleDirect) clearInterval(this.veilleDirect);
    this.veilleDirect = null;
  }

  /**
   * Un direct qui ne donne plus signe de vie est un direct mort.
   *
   * Sans cette veille, la file attendrait pour toujours un titre que le moteur
   * a cessé de télécharger (processus tué, thread perdu, tâche muette) : elle
   * ne rendrait jamais la main. On le déclare en échec — la ligne le dit, le
   * bouton Réessayer reste à portée — et on libère la place pour le suivant.
   * La relance automatique, elle, repasse par la file comme tout le reste.
   */
  private verifierDirectVivant() {
    const videoId = this.directEnCours;
    if (!videoId) return;
    const signe = this.signesDirects.get(videoId);
    if (signe === undefined || Date.now() - signe < DELAI_DIRECT_MUET_MS) return;
    const spec = this.specs.get(videoId);
    console.warn(`[transfert] direct muet ${videoId} : abandon et relance`);
    // Le motif posé ici est le bon : la fin de tâche qui suivra l'annulation ne
    // doit pas le remplacer par « annulé à la demande du module ».
    this.muets.add(videoId);
    const idYt = this.tachesYtDlp.get(videoId);
    if (idYt) {
      this.tachesYtDlp.delete(videoId);
      void YtDlp.cancel(idYt);
    }
    this.signesDirects.delete(videoId);
    this.maj(videoId, { etat: "echoue", raison: "Le téléchargement ne progresse plus." });
    if (spec) this.relancerDirect(spec, new Error("muet"), true);
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
    const cible = fichierTransfert(spec.fichier);
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
        //
        // Le dossier demandé n'est pas un chemin libre : le moteur le résout
        // par `File(baseDir, nom)` sous son propre stockage externe
        // (`…/files/yt-dlp/`), si bien qu'une URI absolue y deviendrait un nom
        // de dossier littéral (`file:___data_user_0_…`). On ne demande qu'un
        // nom simple. Le chemin réel du fichier arrive ensuite dans
        // `completed`, via `path` (absolu) et `filename` — voir
        // `YtDlpTask.completedPayload`.
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
        this.signesDirects.delete(spec.videoId);
        this.muets.delete(spec.videoId);
        if (!terminee) {
          terminee = true;
          resoudre();
        }
      };
      tache.addListener("progress", (progression) => {
        this.signeDirect(spec.videoId);
        this.maj(spec.videoId, {
          recus: progression.downloadedBytes ?? 0,
          total: progression.totalBytes || spec.taille || 0,
        });
      });
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
        // Toute parole du moteur est un signe de vie, y compris pendant
        // l'extraction : c'est ce qui distingue une tâche lente d'une tâche morte.
        this.signeDirect(spec.videoId);
        if (etat.status !== "cancelled") return;
        // La fin de tâche rend toujours la main : c'est elle qui libère la
        // place du suivant dans la file.
        finir();
        // Le motif, lui, ne s'écrit que si personne d'autre ne l'a déjà dit :
        // « Arrêter » (l'utilisateur) et la veille (tâche muette) ont posé le
        // leur, et c'est celui-là qui doit rester à l'écran.
        if (this.annulations.has(spec.videoId) || this.muets.has(spec.videoId)) return;
        this.echouerTransfert(spec, new Error("Téléchargement annulé à la demande du module."));
      });
    });
  }

  /**
   * Rapatrie le fichier écrit par yt-dlp dans le dossier de la bibliothèque.
   *
   * Le moteur nomme `%(id)s - %(title)s.%(ext)s` : la partie fixe (l'identifiant
   * vidéo) garantit l'unicité, y compris pour deux titres identiques.
   *
   * Si le rapatriement échoue — volume qui refuse le renommage, application
   * fermée au mauvais moment — le fichier complet n'est pas perdu pour autant :
   * on garde sa trace et on le réclame au prochain démarrage (voir
   * `recupererLesDirects`). L'utilisateur n'a pas à tout retélécharger.
   */
  private async accueillirFichier(spec: Spec, resultat: DownloadResult) {
    const nom = resultat.filename ?? spec.fichier;
    try {
      assurerDossier(DOSSIER_TRANSFERT);
      const source = this.trouverSourceDirecte(
        resultat.path,
        resultat.uri,
        resultat.path ? `${resultat.path}/${nom}` : undefined,
        fichierTransfert(nom).uri,
      );
      if (!source) {
        throw new Error("Le fichier téléchargé est introuvable.");
      }
      const destination = fichierTransfert(nom);
      await this.rapatrier(source, destination);
      this.acheverDirect(spec.videoId, destination, resultat.size);
      oublierDirectPerdu(spec.videoId);
    } catch (erreur) {
      // Un fichier achevé resté dehors est récupérable : on mémorise son
      // chemin pour le rapatrier à la reprise plutôt que de le retélécharger.
      // On note le dossier réel du moteur (celui qu'il a rendu), complété du
      // nom du fichier : c'est là que l'audio se trouve. Sans ce dossier,
      // il n'y a rien à retrouver et l'on ne mémorise rien.
      const source = resultat.uri ?? (resultat.path ? `${resultat.path}/${nom}` : undefined);
      if (source) {
        memoriserDirectPerdu({
          videoId: spec.videoId,
          source,
          rechange: resultat.path && resultat.path !== resultat.uri ? resultat.path : undefined,
          fichier: nom,
          taille: resultat.size,
        });
      }
      this.echouerTransfert(spec, erreur);
    }
  }

  /**
   * Le premier des chemins donnés qui pointe vraiment sur un fichier non vide.
   *
   * Un chemin invalide (URL mal formée, fichier jamais écrit) n'est pas une
   * source : on passe au suivant sans casser le rapatriement.
   */
  private trouverSourceDirecte(...chemins: (string | undefined)[]): File | null {
    for (const chemin of chemins) {
      if (!chemin) continue;
      // Le moteur rend un chemin ABSOLU (`…/files/yt-dlp/transfert/x.m4a`),
      // alors que le constructeur de `File` attend une URI
      // (`File(URI.create(uri))` dans expo-file-system) : un chemin nu est
      // rejeté. Pire, un titre YouTube contient couramment des caractères
      // interdits dans une URI — `🔞`, `@`, espaces multiples — et l'échec
      // se lisait ensuite comme un fichier absent, l'exception étant avalée.
      // D'où la seconde tentative en `file://`, qui passe.
      for (const essai of [chemin, `file://${chemin}`]) {
        try {
          const candidat = new File(essai);
          if (candidat.exists && tailleDe(candidat) > 0) return candidat;
        } catch {
          // un chemin illisible n'est simplement pas une source
        }
      }
    }
    return null;
  }

  /**
   * Déplace un fichier dans la bibliothèque sans dépendre d'un renommage entre
   * volumes (le dossier de travail de yt-dlp est externe, la bibliothèque
   * interne) : si le déplacement échoue, on copie puis on efface la source.
   */
  private async rapatrier(source: File, destination: File) {
    supprimerFichier(destination);
    try {
      await source.move(destination);
    } catch {
      await source.copy(destination);
      supprimerFichier(source);
    }
    if (!destination.exists || tailleDe(destination) <= 0) {
      throw new Error("Le fichier n'a pas pu être rangé dans la bibliothèque.");
    }
  }

  /** Déclare livré un direct rapatrié, en créant sa ligne si elle manque. */
  private acheverDirect(videoId: string, destination: File, tailleConnue?: number) {
    const taille = tailleDe(destination) || tailleConnue || 0;
    if (this.suivis.has(videoId)) {
      this.maj(videoId, { etat: "termine", recus: taille, total: taille, uri: destination.uri });
      return;
    }
    this.suivis.set(videoId, {
      videoId,
      etat: "termine",
      recus: taille,
      total: taille,
      uri: destination.uri,
    });
    this.publier();
  }

  /**
   * Rapatrie au démarrage les directs achevés restés dans le dossier de yt-dlp.
   *
   * Le binaire a pu finir le fichier alors que notre rapatriement n'a pas eu
   * lieu (application fermée entre les deux, ou volume refusant le renommage) :
   * la trace mémorisée par `accueillirFichier` permet de le retrouver tel quel
   * et de le ranger, sans retélécharger. Une trace sans fichier (binaire jamais
   * arrivé au bout) attend simplement son tour.
   */
  async recupererLesDirects() {
    for (const entree of lireDirectsPerdus()) {
      if (this.annulations.has(entree.videoId)) continue;
      try {
        assurerDossier(DOSSIER_TRANSFERT);
        const destination = fichierTransfert(entree.fichier);
        // Déjà à bon port par un essai précédent (trace restée après coup) :
        // on dit seulement la fin, et l'on efface une éventuelle doublure.
        if (tailleDe(destination) > 0) {
          const doublure = this.trouverSourceDirecte(entree.source, entree.rechange);
          if (doublure) supprimerFichier(doublure);
          this.acheverDirect(entree.videoId, destination, entree.taille);
          oublierDirectPerdu(entree.videoId);
          continue;
        }
        const source = this.trouverSourceDirecte(entree.source, entree.rechange);
        if (!source) continue; // pas encore de fichier complet : on garde la trace
        await this.rapatrier(source, destination);
        this.acheverDirect(entree.videoId, destination, entree.taille);
        oublierDirectPerdu(entree.videoId);
        console.warn(`[transfert] récupéré ${entree.videoId} depuis le dossier yt-dlp`);
      } catch (erreur) {
        const message = erreur instanceof Error ? erreur.message : "Échec du téléchargement";
        console.warn(`[transfert] récupération impossible ${entree.videoId} : ${message}`);
      }
    }
    // Une ligne re-crée au démarrage n'a pas de spec : la même résolution que
    // les transferts natifs retrouve son titre en base.
    await this.resoudreLesTitresManquants();
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
  private relancerDirect(spec: Spec, erreur: unknown, force = false) {
    if (!force && !estPanneTransitoire(erreur)) return;
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
      // La relance repasse par la file : dix titres qui échouent ensemble ne
      // doivent pas repartir ensemble, c'est justement ce qui les fait échouer.
      const specActuelle = this.specs.get(spec.videoId);
      if (!specActuelle) return;
      this.maj(spec.videoId, { etat: "en_file", recus: 0, raison: undefined });
      this.mettreEnFileDirecte(specActuelle);
    }, delai);
    this.relancesDirects.set(spec.videoId, minuteur);
  }

  /**
   * Un echec 403/reseau signalait autrefois un yt-dlp embarque perime, et on
   * proposait la derniere version PyPI en arriere-plan.
   *
   * Ce chemin est retire, et il ne doit pas etre reintroduit en lisant
   * AGENTS.md §59 — qui decrit une mise a jour en place qui n'a jamais existe
   * dans le code. Trois raisons, verifiees :
   *
   * 1. `YtDlp.updateYtDlp()` n'existe pas. Ni dans la facade JavaScript, ni
   *    dans ses types, ni parmi les `AsyncFunction` du module Kotlin. L'appel
   *    levait donc un `TypeError` **synchrone**, que le `.catch()` de la
   *    promesse ne peut pas attraper : il remonte dans `echouerTransfert` et
   *    empeche la ligne suivante, `relancerDirect`, de s'executer. Autrement
   *    dit, ce code ne mettait pas a jour yt-dlp, il desactivait la relance
   *    automatique des pannes transitoires — exactement le cas qu'il visait.
   * 2. Meme cable, il n'aurait rien fait. Le binaire embarque expose
   *    `updateYtDlp(context, callback)`, et son implementation appelle
   *    immediatement `onError("In-app yt-dlp update not supported")` : la mise
   *    a jour a chaud n'est pas supportee par le runtime.
   * 3. Le runtime est donc epingle, et c'est le seul comportement honnete :
   *    yt-dlp evolue avec l'application, dont la version est verifiee contre
   *    le manifeste publie. Le cout est qu'un YouTube qui change peut
   *    momentanement casser les telechargements directs — d'ou la relance
   *    automatique, qui est le vrai remede et qui fonctionne desormais.
   *
   * La relance automatique n'a pas bouge : `relancerDirect` decide seul, via
   * `estPanneTransitoire`.
   */
  private siSourceStale(_erreur: unknown) {
    // Volontairement vide : voir le commentaire ci-dessus. La methode est
    // conservee pour que l'appel dans `echouerTransfert` reste lisible et que
    // la raison du silence soit documentee a cote.
  }

  async rafraichir() {
    if (!module.transfertPersistant) return;
    const etats = await module.lireEtats();
    if (etats.length === 0) return;
    // Les états vus par la passe de relance, pas ceux bruts du module : un
    // titre téléchargé mais pas encore publié revient en `termine` sans URI
    // `content://`, et la boucle ci-dessous le bascule en `en_cours` pour
    // l'écran. En passant les bruts, la relance ne voyait qu'un `termine`,
    // qu'elle ignore : le titre restait bloqué sur « publication en attente »
    // jusqu'au prochain import. D'où le besoin de rescaner.
    const vus: Suivi[] = [];
    for (const etat of etats) {
      // Une ligne arrêtée par l'utilisateur ne renaît pas du seul fait que le
      // système la revoit : ce serait annuler puis voir le titre repartir.
      if (this.annulations.has(etat.videoId)) continue;
      // Livrée = téléchargée ET publiée dans la bibliothèque publique. Une
      // ligne que le système dit terminée sans URI `content://` (publication
      // MediaStore en attente, ou reliquat de l'ancien repli file://) n'est
      // pas un titre jouable partout : on la montre « en cours », jamais reçu.
      const livree = estLivre(etat);
      let lu: Suivi;
      let publicationEnAttente = false;
      if (livree) {
        lu = etat;
      } else {
        // Le fichier est là, seul son dépôt dans la bibliothèque manque. On
        // conserve la raison du module (elle explique le refus) en la
        // complétant du marqueur, et on note la ligne pour la passe de
        // relance : c'est ce cas, invisible dans l'état, qui laissait un lot
        // entier bloqué sur « publication en attente ».
        const raison = etat.raison;
        publicationEnAttente = etat.etat === "termine";
        lu = {
          ...etat,
          etat: "en_cours",
          raison: raison
            ? `${RATION_PUBLICATION} (${raison})`
            : RATION_PUBLICATION,
        };
      }
      this.suivis.set(etat.videoId, lu);
      vus.push(lu);
      if (publicationEnAttente) this.publicationsBloquees.add(etat.videoId);
      else this.publicationsBloquees.delete(etat.videoId);
      // Une ligne arrivée à bon port lave les compteurs de relance. Une ligne
      // annulée par l'utilisateur, elle, reste en paix (see annulations).
      if (lu.etat === "termine") this.relances.delete(etat.videoId);
    }
    await this.resoudreLesTitresManquants();
    this.publier();
    this.relancerLesEchecs(vus);
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
      if (!estReprisable(etat, this.publicationsBloquees.has(etat.videoId))) continue;
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
    // Un direct repasse par la file — trois « Réessayer » d'affilée ne doivent
    // pas relancer trois extractions en parallèle, c'est ce qui les fait
    // échouer toutes les trois.
    if (this.directs.has(videoId)) {
      this.maj(videoId, { etat: "en_file", recus: 0, raison: undefined });
      this.mettreEnFileDirecte(spec);
      return;
    }
    await this.enJavaScript(spec);
  }

  async annuler(videoId: string) {
    this.annulations.add(videoId);
    this.relances.delete(videoId);
    // Un direct qui attend encore son tour ne partira pas.
    this.fileDirecte = this.fileDirecte.filter((spec) => spec.videoId !== videoId);
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
    // Un direct achevé avant la fermeture de l'application attend peut-être
    // encore dans le dossier de yt-dlp : on le réclame dès la reprise, avant
    // même le premier tour de la boucle.
    void this.recupererLesDirects();
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
    supprimerFichier(fichierTransfert(spec.fichier));
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
