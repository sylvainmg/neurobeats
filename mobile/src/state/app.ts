/**
 * État partagé de l'application : session d'import, transferts, bibliothèque.
 *
 * Les écrans ne parlent jamais directement au réseau ni au module natif : ils
 * lisent cet état et déclenchent des actions. C'est ce qui permet de dire
 * exactement ce qui se passe quand le bureau ne répond pas.
 */
import { AccessibilityInfo } from "react-native";
import { Paths } from "expo-file-system";
import { create } from "zustand";

import * as repo from "@/db/repos";
import { db } from "@/db/db";
import { nommerFichier } from "@/fichiers/nommage";
import { supprimer, verifier } from "modules/downloader";
import { Gestionnaire, transfertPersistant } from "@/transfer/downloader";
import type { Spec, Suivi } from "@/transfer/downloader";
import { dureeDeFichier } from "@/transfer/duree";
import { telechargerPochette } from "@/transfer/covers";
import { demanderNotifications, notificationsAutorisees } from "@/transfer/notifications";
import { estimerPoids } from "@/transfer/format";
import { analyserManifeste, type Manifeste, type PisteManifeste } from "@/transfer/manifest";
import { adresseSession, lireCode, type Code } from "@/transfer/qr";

export type EtatSession =
  | { phase: "repos" }
  | { phase: "lecture" }
  | { phase: "ouverte"; code: Code; manifeste: Manifeste }
  | { phase: "erreur"; message: string };

export type BilanImport = {
  nouveaux: PisteManifeste[];
  dejaLa: PisteManifeste[];
  poidsEstime: number;
  aPreparer: number;
};

/** Un titre que l'ordinateur prépare encore, ou n'a pas pu préparer. */
export type TitreEnPreparation = {
  videoId: string;
  titre: string;
  chaine: string;
  taille: number;
  /** Quand le bureau ne prépare plus ce titre : ce qui a fait échec. */
  raison?: string;
};

type Etat = {
  session: EtatSession;
  suivis: Suivi[];
  transferts: number;
  /** Combien de téléchargements ont fini depuis le lancement de l'app. */
  transfertsTermines: number;
  /** Titres que l'ordinateur prépare encore : le transfert les attend. */
  enPreparation: TitreEnPreparation[];
  wifiUniquement: boolean;
  /** Animations réellement jouées : jamais quand l'appareil les refuse. */
  animations: boolean;
  /**
   * L'app peut-elle annoncer la progression dans une notification ?
   *
   * Sans elle, le système ne montre rien : l'écran des transferts ne doit donc
   * pas promettre une notification qui n'arrivera pas.
   */
  notificationsAccordees: boolean;
  transfertPersistantActif: boolean;
  bilan: BilanImport | null;
  ouvrirDepuisCode: (brut: string) => Promise<boolean>;
  fermerSession: () => void;
  reglerWifi: (valeur: boolean) => void;
  lancerTransfert: (choisies?: PisteManifeste[]) => Promise<void>;
  initialiser: () => Promise<void>;
  /** Repasse sur les titres « chez toi » : retire ceux dont le fichier a disparu. */
  verifierTitres: () => Promise<number>;
  /** Réessaie un titre que le bureau n'a pas pu préparer. */
  relancerPreparation: (videoId: string) => void;
  /** Arrête tout d'un coup : transferts en cours et préparations à l'attente. */
  toutAnnulerTout: () => void;
  /** Sone le fichier des titres « chez toi » sans durée connue et l'enregistre. */
  porterDureesManquantes: () => Promise<void>;
  /** Crée une playlist sur le téléphone (mini-navigateur). Rend son identifiant. */
  creerPlaylist: (nom: string) => Promise<string | null>;
  /** Renomme une playlist locale. Refuse les playlists venues de l'ordinateur. */
  renommerPlaylist: (playlist_id: string, nom: string) => Promise<boolean>;
  /** Télécharge un audio extrait de YouTube dans une playlist locale. */
  telechargerDirect: (demande: DemandeDirect) => Promise<ResultatDirect>;
  /** Relance le téléchargement des titres manquants d'une playlist locale. */
  reprendreDirecte: (playlistId: string, videoId?: string) => Promise<ResultatReprise>;
};

/** Ce que le mini-navigateur demande : un audio extrait, à poser dans une playlist locale. */
export type DemandeDirect = {
  videoId: string;
  titre: string;
  chaine: string;
  duree: number;
  format: { ext: string | undefined; url: string; taille?: number };
  pochette: string | null;
  playlistId: string;
};

/** Ce que `telechargerDirect` promet, pour que l'écran dise exactement ce qui s'est passé. */
export type ResultatDirect =
  | { ok: true }
  | { ok: false; raison: "deja" | "introuvable" | "echouee"; message?: string };

/** Ce que la reprise d'une playlist locale a réussi à relancer. */
export type ResultatReprise =
  | { ok: true; relances: number }
  | { ok: false; raison: "playlist" | "rien" | "echouee"; message?: string };

const gestionnaire = new Gestionnaire(
  (suivis, modeSecours) => {
    useApp.setState({
      suivis,
      transferts: suivis.filter((s) => s.etat === "en_cours" || s.etat === "en_file").length,
      // La possession, elle, est portée par le compteur monotone ci-dessous :
      // il monte quand un fichier est réellement enregistré « chez toi », bien
      // après la mise en table du suivi. Les écrans qui s'y abonnent relisent
      // alors une base déjà à jour, pas un état en cours de devenir.
      transfertPersistantActif: transfertPersistant && !modeSecours,
    });
    void enregistrerTermines(suivis);
  },
  // Un transfert natif repris après un redémarrage revient sans son titre : le
  // module ne garde que les identifiants.
  (videoIds) => repo.titresParId(videoIds),
);

/** Un transfert terminé devient un titre possédé : le fichier est chez nous. */
async function enregistrerTermines(suivis: Suivi[]) {
  for (const suivi of suivis) {
    if (suivi.etat !== "termine" || !suivi.uri) continue;
    // Sa possession est déjà écrite : la réécrire ferait revenir « chez toi » un
    // titre que l'utilisateur vient de retirer du téléphone, avec son ancienne
    // URI. Le suivi achevé reste en mémoire, mais il ne possède plus rien.
    if (gestionnaire.possessionEcrite(suivi.videoId)) continue;
    // Un même titre peut vivre dans plusieurs playlists : on ne saute la
    // possession que si **toutes** ses lignes portent déjà ce fichier. Regarder
    // une seule ligne (la première trouvée) faisait conclure « déjà servi »
    // quand une autre playlist le possédait déjà — la ligne de la playlist qu'on
    // venait de télécharger restait « absente » pour toujours.
    const lignes = await repo.pistesParVideo(suivi.videoId);
    const servies =
      lignes.length > 0 &&
      lignes.every((ligne) => ligne.etat === "chez_toi" && ligne.fichier === suivi.uri);
    if (servies) {
      gestionnaire.marquerPossessionEcrite(suivi.videoId);
      continue;
    }
    await repo.marquerPossede(
      suivi.videoId,
      suivi.uri,
      suivi.total || lignes[0]?.taille || 0,
    );
    gestionnaire.marquerPossessionEcrite(suivi.videoId);
    // Une possession fraîche fait monter le compteur public : les écrans abonnés
    // relisent leur contenu une fois la base réellement mise à jour. Sans cette
    // montée, un écran déjà affiché croirait que le titre manque encore.
    useApp.setState((courant) => ({ transfertsTermines: courant.transfertsTermines + 1 }));
    // Un manifeste ancien arrivait sans durée : le fichier est là, on la sonde
    // une fois pour de bon, au moment où l'on sait qu'il est complet.
    const arrivee = await repo.pisteParId(suivi.videoId);
    if (arrivee && arrivee.duree <= 0) {
      const duree = await dureeDeFichier(suivi.uri);
      if (duree && duree > 0) {
        const lignes = await repo.pistesParVideo(suivi.videoId);
        for (const ligne of lignes) await repo.enregistrerPiste({ ...ligne, duree });
      }
    }
  }
}

function nomDeFichier(piste: PisteManifeste): string {
  return nommerFichier(
    `${piste.titre} - ${piste.chaine}`,
    piste.format || "m4a",
    piste.video_id,
  );
}

/** Nom de fichier d'un téléchargement direct : même règle que l'import. */
function nomDeFichierDirect(
  videoId: string,
  titre: string,
  chaine: string,
  extension: string | undefined,
): string {
  return nommerFichier(`${titre} - ${chaine}`, extension || "m4a", videoId);
}

/** Ce qu'il faut demander au module de transfert pour un titre annoncé. */
function specDe(piste: PisteManifeste, manifeste: Manifeste): Spec {
  return {
    videoId: piste.video_id,
    url: piste.url,
    fichier: nomDeFichier(piste),
    titre: piste.titre,
    chaine: piste.chaine,
    album: manifeste.playlist,
    taille: piste.taille ?? estimerPoids(piste.duree, manifeste.debit_estime),
  };
}

/**
 * Retient la pochette d'un titre : la copie locale si elle est descendue, sinon
 * l'adresse du bureau.
 *
 * Stocker l'adresse plutôt que rien laisse la vignette s'afficher tant que le
 * téléphone est en ligne, au lieu d'une ligne vide — et la copie locale, elle,
 * prend le relais dès qu'elle existe.
 */
async function retenirPochette(videoId: string, adresse: string | null): Promise<void> {
  const locale = await telechargerPochette(adresse, videoId);
  const pochette = locale ?? adresse;
  if (!pochette) return;
  await repo.definirPochette(videoId, pochette);
}

/**
 * L'ordinateur prepare ce qu'il n'a jamais lu : on garde la liste des titres qui
 * ne sont pas encore prêts et on redemande le manifeste jusqu'à ce qu'ils le
 * soient. C'est ce qui permet d'annoncer l'attente (« ton ordinateur prépare ce
 * titre ») au lieu de la subir ou d'échouer.
 *
 * Une préparation ne dure pas indéfiniment : passé un délai, ou quand le bureau
 * annonce lui-même un échec, la ligne cesse d'attendre et dit ce qui est arrivé,
 * avec un bouton pour réessayer. Sans ce bornage, une source morte figerait une
 * ligne « en préparation » pour toujours.
 */
/**
 * Budget d'attente d'une préparation, proportionnel à la durée annoncée.
 *
 * Un forfait fixe de 3 min faisait échouer un titre juste lent : YouTube bride
 * un téléchargement continu (~35 Ko/s mesuré), donc une préparation honnête
 * dépasse souvent ces 3 minutes. On accorde ~1,25 s d'attente par seconde de
 * titre, plancher 90 s, plafond 15 min : une source lente finit son travail,
 * une source morte ne fige toujours pas la ligne.
 */
function budgetPreparation(piste: PisteManifeste): number {
  const parDuree = (piste.duree ?? 0) * 1000 * 1.25;
  return Math.min(15 * 60_000, Math.max(90_000, 90_000 + parDuree));
}

/**
 * Rythme du poller : 4 s tant qu'un titre peut encore devenir prêt, 15 s quand
 * seuls des échecs restent — ceux-ci se rattrapent parfois (le bureau finit la
 * préparation après coup) et le téléphone doit les attraper sans intervention.
 */
const POLL_PREPARATION_MS = 4000;
const POLL_ECHECS_MS = 15_000;

const enAttente = new Map<string, PisteManifeste>();
/** Titres dont le bureau n'arrive plus, avec la raison de l'abandon. */
const echouees = new Map<string, PisteManifeste>();
const raisonsEchec = new Map<string, string>();
/** Départ du minutage par titre : seule la date permet de borner l'attente. */
const debuts = new Map<string, number>();
let minuteurPreparation: ReturnType<typeof setInterval> | null = null;
let manifesteEnCours: Manifeste | null = null;
/** Contexte du lot courant : permet de relancer une préparation échouée. */
let contextePreparation: { code: Code; manifeste: Manifeste; nomLot: string } | null = null;
/**
 * Fin de vie annoncée de la session : le poller ne tourne pas au-delà, sinon
 * un bureau éteint ferait une boucle de questions sans fin.
 */
let finDeVieSession: number | null = null;

/** Ce qui attend, tel que l'écran des transferts le montre ligne par ligne. */
function publierPreparation() {
  const manifeste = manifesteEnCours;
  const lignes: TitreEnPreparation[] = [];
  for (const piste of enAttente.values()) {
    lignes.push({
      videoId: piste.video_id,
      titre: piste.titre,
      chaine: piste.chaine,
      taille: piste.taille ?? estimerPoids(piste.duree, manifeste?.debit_estime ?? 0),
    });
  }
  for (const piste of echouees.values()) {
    lignes.push({
      videoId: piste.video_id,
      titre: piste.titre,
      chaine: piste.chaine,
      taille: piste.taille ?? estimerPoids(piste.duree, manifeste?.debit_estime ?? 0),
      raison: raisonsEchec.get(piste.video_id),
    });
  }
  useApp.setState({ enPreparation: lignes });
}

function stopperMinuteurPreparation() {
  if (minuteurPreparation) clearInterval(minuteurPreparation);
  minuteurPreparation = null;
}

/** Reclenche le poller au rythme demandé, en remplaçant l'éventuel précédent. */
function reclencherPoller(code: Code, manifeste: Manifeste, nomLot: string, delai: number) {
  stopperMinuteurPreparation();
  minuteurPreparation = setInterval(
    () => void pomperPreparation(code, manifeste, nomLot),
    delai,
  );
}

function arreterPreparation() {
  stopperMinuteurPreparation();
  enAttente.clear();
  echouees.clear();
  raisonsEchec.clear();
  debuts.clear();
  manifesteEnCours = null;
  contextePreparation = null;
  finDeVieSession = null;
  publierPreparation();
}

/** Le titre a épuisé son droit d'attendre : il devient un échec visible. */
function marquerEchecPreparation(videoId: string, raison: string) {
  const piste = enAttente.get(videoId);
  if (!piste) return;
  enAttente.delete(videoId);
  echouees.set(videoId, piste);
  raisonsEchec.set(videoId, raison);
  debuts.delete(videoId);
}

async function pomperPreparation(code: Code, manifeste: Manifeste, nomLot: string) {
  const maintenant = Date.now();
  // La session annonce sa vie restante : on ne garde pas le poller au-delà,
  // sinon un bureau éteint ferait tourner une boucle de questions sans fin.
  if (finDeVieSession != null && maintenant >= finDeVieSession) {
    stopperMinuteurPreparation();
    return;
  }
  for (const videoId of [...enAttente.keys()]) {
    const piste = enAttente.get(videoId);
    if (!piste) continue;
    const debut = debuts.get(videoId) ?? maintenant;
    if (maintenant - debut >= budgetPreparation(piste)) {
      marquerEchecPreparation(
        videoId,
        "La préparation de ce titre traîne depuis longtemps. La source est peut-être lente ou bloquée : relance-le pour réessayer.",
      );
    }
  }
  if (enAttente.size === 0 && echouees.size === 0) {
    stopperMinuteurPreparation();
    return;
  }
  manifesteEnCours = manifeste;
  try {
    const reponse = await fetch(adresseSession(code));
    if (!reponse.ok) return;
    const analyse = analyserManifeste(await reponse.text(), code.base);
    if (!analyse.ok) return;
    for (const videoId of [...enAttente.keys()]) {
      const annonce = analyse.manifeste.pistes.find((piste) => piste.video_id === videoId);
      // Le bureau a abandonné ce titre ou n'en parle plus : on le dit aussi.
      if (!annonce || annonce.etat === "erreur") {
        marquerEchecPreparation(
          videoId,
          "L'ordinateur n'a pas pu préparer ce titre. Relance-le pour réessayer.",
        );
      }
    }
    // Un titre devenu prêt part en téléchargement, qu'il ait attendu ou déjà
    // échoué : une préparation finit souvent par aboutir (source provisoirement
    // injoignable) et le téléphone ne doit pas la rater — c'est le cas SWISH.
    const devenusPrets = analyse.manifeste.pistes.filter(
      (piste) =>
        piste.etat === "pret" &&
        (enAttente.has(piste.video_id) || echouees.has(piste.video_id)),
    );
    for (const piste of devenusPrets) {
      enAttente.delete(piste.video_id);
      echouees.delete(piste.video_id);
      raisonsEchec.delete(piste.video_id);
      debuts.delete(piste.video_id);
      await retenirPochette(piste.video_id, piste.pochette);
      gestionnaire.enFile([specDe(piste, analyse.manifeste)], nomLot);
    }
    publierPreparation();
    if (enAttente.size === 0 && echouees.size === 0) {
      arreterPreparation();
      return;
    }
    // Rien n'attend plus : on ralentit la garde au lieu de l'éteindre.
    const cadence = enAttente.size > 0 ? POLL_PREPARATION_MS : POLL_ECHECS_MS;
    reclencherPoller(code, manifeste, nomLot, cadence);
  } catch {
    // Réseau capricieux : le prochain tour réessaiera.
  }
}

function lancerPreparation(code: Code, manifeste: Manifeste, pistes: PisteManifeste[]) {
  arreterPreparation();
  manifesteEnCours = manifeste;
  const maintenant = Date.now();
  // La session annonce sa vie restante au scan : elle borne toute la garde.
  finDeVieSession = maintenant + Math.max(60, (manifeste.expire_dans ?? 20 * 60)) * 1000;
  for (const piste of pistes) {
    // Un échec déjà annoncé par le bureau ne part pas poller pour rien : il
    // s'affiche aussitôt avec sa raison et son bouton « Réessayer », mais la
    // garde continue de l'observer — il peut finir par devenir prêt.
    if (piste.etat === "erreur") {
      echouees.set(piste.video_id, piste);
      raisonsEchec.set(piste.video_id, "L'ordinateur n'a pas pu préparer ce titre.");
      continue;
    }
    debuts.set(piste.video_id, maintenant);
    enAttente.set(piste.video_id, piste);
  }
  const nomLot = manifeste.playlist;
  contextePreparation = { code, manifeste, nomLot };
  publierPreparation();
  if (enAttente.size === 0 && echouees.size === 0) return;
  // Le lot natif porte le nom de la playlist : les titres qui deviennent prêts
  // rejoignent le lot du premier import, une seule notification de fin à décrire.
  reclencherPoller(code, manifeste, nomLot, POLL_PREPARATION_MS);
}

function bilanDe(manifeste: Manifeste, locales: Set<string>): BilanImport {
  // Le bilan porte sur la playlist scannée : un titre « chez toi » ailleurs
  // reste un nouveau ici (il faudra le relier), sauf s'il est déjà relié ici.
  const dedans = new Set(
    manifeste.pistes.map((p) => p.video_id).filter((id) => locales.has(`${manifeste.playlist_id}::${id}`)),
  );
  const nouveaux = manifeste.pistes.filter((p) => !dedans.has(p.video_id));
  const dejaLa = manifeste.pistes.filter((p) => dedans.has(p.video_id));
  const poidsEstime = nouveaux.reduce(
    (total, piste) => total + (piste.taille ?? estimerPoids(piste.duree, manifeste.debit_estime)),
    0,
  );
  return {
    nouveaux,
    dejaLa,
    poidsEstime,
    aPreparer: nouveaux.filter((piste) => piste.etat !== "pret").length,
  };
}

/**
 * Animations : décidées par l'appareil, pas par l'app.
 *
 * Les animations suivent le réglage « réduire le mouvement » du système. Un
 * réglage dans l'app serait redondant avec celui-là — on n'offre pas un second
 * interrupteur qui ne ferait que copier l'état du premier.
 */
let animationsSystemeReduites = false;

function animationsEffectives(): boolean {
  return !animationsSystemeReduites;
}

export const useApp = create<Etat>((set, get) => ({
  session: { phase: "repos" },
  suivis: [],
  transferts: 0,
  transfertsTermines: 0,
  enPreparation: [],
  wifiUniquement: true,
  animations: true,
  notificationsAccordees: true,
  transfertPersistantActif: transfertPersistant,
  bilan: null,

  initialiser: async () => {
    await db();
    const wifi = (await repo.lireReglage("wifi_uniquement", "1")) === "1";
    animationsSystemeReduites = await AccessibilityInfo.isReduceMotionEnabled().catch(
      () => false,
    );
    AccessibilityInfo.addEventListener("reduceMotionChanged", (reduit) => {
      animationsSystemeReduites = reduit;
      useApp.setState({ animations: animationsEffectives() });
    });
    const notifs = await notificationsAutorisees();
    gestionnaire.regler({ wifiUniquement: wifi });
    set({
      wifiUniquement: wifi,
      animations: animationsEffectives(),
      notificationsAccordees: notifs,
    });
    await gestionnaire.rafraichir();
    // Un titre annoncé « chez toi » dont le fichier a disparu mentirait : on
    // repasse la possession avant de laisser la bibliothèque l'afficher.
    void useApp.getState().verifierTitres();
  },

  reglerWifi: async (valeur: boolean) => {
    gestionnaire.regler({ wifiUniquement: valeur });
    set({ wifiUniquement: valeur });
    await repo.ecrireReglage("wifi_uniquement", valeur ? "1" : "0");
  },

  ouvrirDepuisCode: async (brut: string) => {
    const lu = lireCode(brut);
    if (!lu.ok) {
      set({ session: { phase: "erreur", message: lu.erreur }, bilan: null });
      return false;
    }
    set({ session: { phase: "lecture" }, bilan: null });
    const adresse = adresseSession(lu.code);
    // Le réseau peut rester silencieux sans erreur ni refus (hôte éteint, IP
    // périmée après un DHCP, Wi-Fi isolé) : on borne la tentative pour ne pas
    // rester sur « Lecture du code… » indéfiniment. Promise.race (et non
    // AbortController : RN 0.86 ignore l'option signal de fetch) garantit que
    // la borne s'applique quelle que soit la version de React Native.
    const TIMEOUT_LECTURE_CODE_MS = 8000;
    const reponse = await Promise.race([
      fetch(adresse, { headers: { Accept: "application/json" } }).catch(
        () => null,
      ),
      new Promise<null>((resoudre) =>
        setTimeout(() => resoudre(null), TIMEOUT_LECTURE_CODE_MS),
      ),
    ]);
    // Le réseau est le seul cas où l'on peut affirmer que l'ordinateur est en
    // cause. Un échec plus loin (base illisible) ne doit pas l'accuser à tort :
    // l'import reste possible, seuls les titres déjà présents seront comptés
    // deux fois.
    if (!reponse) {
      set({
        session: {
          phase: "erreur",
          message:
            "Ordinateur injoignable. Vérifie qu'il est allumé, que le transfert est lancé, et que les deux appareils sont sur le même Wi-Fi.",
        },
      });
      return false;
    }
    if (!reponse.ok) {
      set({
        session: {
          phase: "erreur",
          // Le bureau répond 404 sur une session inconnue ou expirée, et 403
          // quand le jeton ne correspond plus : les deux veulent dire la même
          // chose pour quelqu'un qui tient un code à la main.
          message:
            reponse.status === 403 || reponse.status === 404
              ? "Le code n'est plus valable. Affiche-en un nouveau sur l'ordinateur."
              : "L'ordinateur a refusé la demande.",
        },
      });
      return false;
    }
    const texte = await reponse.text().catch(() => "");
    const analyse = analyserManifeste(texte, lu.code.base);
    if (!analyse.ok) {
      set({ session: { phase: "erreur", message: analyse.erreur } });
      return false;
    }
    let locales = new Set<string>();
    try {
      const possedees = (await repo.listerPistes()).filter((p) => p.etat === "chez_toi");
      // Clé par couple : la même vidéo peut être « chez toi » dans une autre
      // playlist sans être reliée à celle qu'on scanne.
      locales = new Set(possedees.map((p) => `${p.playlist_id ?? ""}::${p.video_id}`));
      // Un rescan doit dire la vérité : un titre « chez toi » ne compte comme
      // déjà là que si son fichier est présent ET publié dans la bibliothèque
      // publique (content://). Ce sont les anciens titres gagnés par le repli
      // privé file:// (invisibles dans le lecteur Musique du téléphone) ou des
      // fichiers disparus en cours de route : on les rend au téléchargement,
      // table comme registre natif, pour que la livraison se refasse proprement.
      const idsDuManifeste = new Set(analyse.manifeste.pistes.map((p) => p.video_id));
      const declares = possedees.filter(
        (p) =>
          p.fichier &&
          p.playlist_id === analyse.manifeste.playlist_id &&
          idsDuManifeste.has(p.video_id),
      );
      let aRendre = declares.filter((p) => !p.fichier!.startsWith("content://"));
      const aVerifier = declares
        .filter((p) => p.fichier!.startsWith("content://"))
        .map((p) => p.fichier!);
      if (aVerifier.length > 0) {
        const presents = new Set(await verifier(aVerifier));
        aRendre = [
          ...aRendre,
          ...declares.filter(
            (p) => p.fichier!.startsWith("content://") && !presents.has(p.fichier!),
          ),
        ];
      }
      if (aRendre.length > 0) {
        const ids = new Set(aRendre.map((p) => p.video_id));
        await repo.retirerDuLocal([...ids], analyse.manifeste.playlist_id);
        for (const p of aRendre) {
          locales.delete(`${p.playlist_id ?? ""}::${p.video_id}`);
          // Une vieille ligne du registre natif ressusciterait au balayage
          // suivant : on l'efface avec son fichier. Un échec ici ne bloque pas
          // l'import — le titre sera relivré de toute façon.
          try {
            await supprimer(p.video_id, p.fichier!);
          } catch {
            // registre déjà propre ou module absent : rien d'important.
          }
        }
      }
    } catch {
      // Base illisible : on propose tout, plutôt que d'empêcher le transfert.
    }
    set({
      session: { phase: "ouverte", code: lu.code, manifeste: analyse.manifeste },
      bilan: bilanDe(analyse.manifeste, locales),
    });
    return true;
  },

  fermerSession: () => {
    arreterPreparation();
    set({ session: { phase: "repos" }, bilan: null });
  },

  lancerTransfert: async (choisies) => {
    const etat = get();
    if (etat.session.phase !== "ouverte") return;
    const { manifeste, code } = etat.session;
    const aPrendre = choisies ?? etat.bilan?.nouveaux ?? [];
    if (aPrendre.length === 0) return;

    await repo.enregistrerPlaylist(
      manifeste.playlist_id,
      manifeste.playlist,
      manifeste.pistes[0]?.video_id ?? null,
    );
    // Un titre déjà « chez toi » dans une autre playlist ne se retélécharge
    // pas : la nouvelle ligne est reliée au même fichier.
    const connus = new Map<string, { fichier: string | null; taille: number }>();
    for (const ligne of await repo.listerPistes()) {
      if (ligne.etat === "chez_toi" && ligne.fichier && !connus.has(ligne.video_id)) {
        connus.set(ligne.video_id, { fichier: ligne.fichier, taille: ligne.taille });
      }
    }
    for (const piste of manifeste.pistes) {
      const connu = connus.get(piste.video_id);
      await repo.enregistrerPiste({
        video_id: piste.video_id,
        playlist_id: manifeste.playlist_id,
        titre: piste.titre,
        chaine: piste.chaine,
        album: manifeste.playlist,
        duree: piste.duree,
        taille: piste.taille ?? estimerPoids(piste.duree, manifeste.debit_estime),
        fichier: connu?.fichier ?? null,
        pochette: null,
        etat: connu ? "chez_toi" : "absent",
      });
    }
    // Les pochettes se rapatrient d'abord : un titre sans vignette une fois hors
    // ligne resterait sans vignette.
    const specs: Spec[] = [];
    for (const piste of aPrendre.filter((annonce) => annonce.etat === "pret")) {
      // Déjà relié à un fichier venu d'une autre playlist : rien à télécharger.
      const reliee = await repo.pisteDansPlaylist(piste.video_id, manifeste.playlist_id);
      if (reliee?.etat === "chez_toi" && reliee.fichier) continue;
      await retenirPochette(piste.video_id, piste.pochette);
      specs.push(specDe(piste, manifeste));
    }
    // Le système ne peut pas annoncer la progression sans cette permission :
    // on la demande ici, au moment où l'utilisateur lance le transfert.
    if (specs.length > 0) {
      const accordees = await demanderNotifications();
      set({ notificationsAccordees: accordees });
      gestionnaire.enFile(specs, manifeste.playlist);
    }
    // Ce que l'ordinateur n'a pas encore lu attend son tour : il partira dès que
    // le manifeste le dira prêt.
    lancerPreparation(code, manifeste, aPrendre.filter((piste) => piste.etat !== "pret"));
    set({ session: { phase: "repos" }, bilan: null });
  },

  verifierTitres: async () => {
    // Sans module natif, rien ne peut vérifier : on ne retire aucun titre.
    if (!transfertPersistant) return 0;
    try {
      const possedees = await repo.pistesPossedees();
      if (possedees.length === 0) return 0;
      const uris = possedees.map((piste) => piste.fichier ?? "").filter(Boolean);
      if (uris.length === 0) return 0;
      const presents = new Set(await verifier(uris));
      const disparus = possedees
        .filter((piste) => piste.fichier && !presents.has(piste.fichier))
        .map((piste) => piste.video_id);
      if (disparus.length === 0) return 0;
      await repo.retirerDuLocal(disparus);
      return disparus.length;
    } catch {
      // Une base illisible ne doit pas bloquer le démarrage.
      return 0;
    }
  },

  relancerPreparation: (videoId: string) => {
    const piste = echouees.get(videoId);
    if (!piste || !contextePreparation) return;
    echouees.delete(videoId);
    raisonsEchec.delete(videoId);
    debuts.set(videoId, Date.now());
    enAttente.set(videoId, piste);
    publierPreparation();
    if (!minuteurPreparation) {
      const { code, manifeste, nomLot } = contextePreparation;
      reclencherPoller(code, manifeste, nomLot, POLL_PREPARATION_MS);
    }
  },

  toutAnnulerTout: () => {
    void gestionnaire.toutAnnuler();
    arreterPreparation();
  },

  porterDureesManquantes: async () => {
    try {
      const sansDuree = (await repo.pistesPossedees()).filter((piste) => piste.duree <= 0);
      for (const piste of sansDuree) {
        if (!piste.fichier) continue;
        const duree = await dureeDeFichier(piste.fichier);
        if (duree && duree > 0) await repo.enregistrerPiste({ ...piste, duree });
      }
    } catch {
      // Un sondage qui échoue laisse juste une durée vide : rien ne casse.
    }
  },

  creerPlaylist: async (nom) => {
    const propre = nom.trim();
    if (!propre) return null;
    try {
      return await repo.creerPlaylist(propre);
    } catch {
      return null;
    }
  },

  renommerPlaylist: async (playlist_id, nom) => {
    const propre = nom.trim();
    if (!propre) return false;
    try {
      // Seule une playlist née sur le téléphone se renomme : celles de
      // l'ordinateur gardent leur nom, la source les redonnerait tels quels.
      const playlist = await repo.playlistParId(playlist_id);
      if (!playlist || playlist.locale !== 1) return false;
      await repo.renommerPlaylist(playlist_id, propre);
      return true;
    } catch {
      return false;
    }
  },

  telechargerDirect: async ({ videoId, titre, chaine, duree, format, pochette, playlistId }) => {
    try {
      // L'unicité est par playlist : un même titre peut vivre dans plusieurs
      // playlists, chacune avec sa ligne. Seul un doublon dans CETTE playlist
      // est refusé — et seulement s'il est réellement possédé. Une ligne
      // « absente » (transfert raté) se réutilise et relance son téléchargement.
      const dansCelleCi = await repo.pisteDansPlaylist(videoId, playlistId);
      if (dansCelleCi && dansCelleCi.etat === "chez_toi") {
        return { ok: false, raison: "deja" as const };
      }
      // Un téléchargement de ce titre déjà en cours (que la piste soit en base
      // ou non) est à laisser tranquille : le relancer empilerait les extractions.
      const dejaEnCours = useApp.getState().suivis.some(
        (s) => s.videoId === videoId && (s.etat === "en_cours" || s.etat === "en_file"),
      );
      if (dejaEnCours) {
        return {
          ok: false,
          raison: "echouee" as const,
          message: "Ce titre est déjà en cours de téléchargement.",
        };
      }
      const playlist = await repo.playlistParId(playlistId);
      if (!playlist || playlist.locale !== 1) return { ok: false, raison: "introuvable" as const };
      await repo.enregistrerPiste({
        video_id: videoId,
        playlist_id: playlistId,
        titre,
        chaine,
        album: playlist.nom,
        duree,
        taille: 0,
        fichier: null,
        pochette: null,
        etat: "absent",
      });
      await retenirPochette(videoId, pochette);
      const accordees = await demanderNotifications();
      set({ notificationsAccordees: accordees });
      gestionnaire.enFile(
        [
          {
            videoId,
            url: format.url,
            fichier: nomDeFichierDirect(videoId, titre, chaine, format.ext),
            titre,
            chaine,
            album: playlist.nom,
            taille: format.taille,
          },
        ],
        playlist.nom,
        // Direct = navigation en cours, app au premier plan : le chemin
        // JavaScript (DownloadTask) est plus fiable ici que le DownloadManager
        // du système, capricieux sur les URL de flux.
        { direct: true },
      );
      return { ok: true };
    } catch (erreur) {
      return {
        ok: false,
        raison: "echouee",
        message: erreur instanceof Error ? erreur.message : "Échec du téléchargement",
      };
    }
  },

  reprendreDirecte: async (playlistId, videoId) => {
    try {
      const playlist = await repo.playlistParId(playlistId);
      if (!playlist || playlist.locale !== 1) return { ok: false, raison: "playlist" };
      const manquants = (await repo.listerPistesParPlaylist(playlistId)).filter(
        (piste) => piste.etat !== "chez_toi" && (!videoId || piste.video_id === videoId),
      );
      // Un titre déjà en train d'arriver ne repart pas : on ne déclenche pas
      // deux tâches yt-dlp qui écriraient le même fichier.
      const actifs = new Set(
        get()
          .suivis.filter(
            (s) => s.etat === "en_cours" || s.etat === "en_file" || s.etat === "suspendu",
          )
          .map((s) => s.videoId),
      );
      const aReprendre = manquants.filter((piste) => !actifs.has(piste.video_id));
      if (aReprendre.length === 0) return { ok: false, raison: "rien" };
      const accordees = await demanderNotifications();
      set({ notificationsAccordees: accordees });
      // La reprise part du `video_id`, jamais d'une URL de flux éphémère :
      // yt-dlp rejoue son extraction au moment du téléchargement (cf. `enDirect`).
      gestionnaire.enFile(
        aReprendre.map((piste) => ({
          videoId: piste.video_id,
          url: `https://www.youtube.com/watch?v=${piste.video_id}`,
          fichier: nomDeFichierDirect(piste.video_id, piste.titre, piste.chaine, "m4a"),
          titre: piste.titre,
          chaine: piste.chaine,
          album: playlist.nom,
          taille: piste.taille,
        })),
        playlist.nom,
        { direct: true },
      );
      return { ok: true, relances: aReprendre.length };
    } catch (erreur) {
      return {
        ok: false,
        raison: "echouee",
        message: erreur instanceof Error ? erreur.message : "Échec de la reprise",
      };
    }
  },
}));

/** Espace libre sur le téléphone : ce que le prochain transfert peut occuper. */
export function espaceLibre(): number {
  return Paths.availableDiskSpace;
}

export { gestionnaire };
