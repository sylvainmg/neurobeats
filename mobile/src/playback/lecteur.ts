/**
 * Le lecteur, sur le module audio officiel d'Expo.
 *
 * Pourquoi pas une bibliothèque de lecteur dédiée : `react-native-track-player`
 * ne compile plus avec React Native 0.86 (erreur Kotlin à la compilation). Le
 * module d'Expo, lui, est livré avec le SDK et se compile.
 *
 * La file et l'enchaînement sont donc tenus ici, en clair : c'est nous qui
 * décidons qu'à la fin d'un titre le suivant démarre — et ce comportement est
 * visible, testable, et pas enfoui dans une dépendance.
 *
 * En lecture aléatoire, la file est une permutation tirée une fois : le titre
 * en cours reste en tête, tout le reste est tiré sans remise. En fin de passe,
 * la file repart de sa tête — le même cycle tourne, chaque titre repasse à son
 * tour.
 *
 * Le bouton « lecture en boucle » a trois états : "simple" (la file s'arrête
 * au dernier titre), "file" (fin de file → retour en tête) et "titre" (le
 * titre en cours se répète : on colle le repeat-one d'ExoPlayer, qui reprend
 * le même morceau avant qu'une fin n'arrive — sans `didJustFinish`, donc sans
 * que la file avance toute seule).
 *
 * Les sources sont toujours des fichiers locaux : en mode avion, la lecture se
 * comporte exactement comme en ligne.
 *
 * Aucune panne ne reste muette. Un titre peut disparaître (dossier nettoyé par
 * une autre application, transfert effacé), un fichier peut être illisible :
 * dans les deux cas on le dit à l'écran et on remet la base d'accord avec le
 * disque, au lieu de laisser un lecteur qui ne joue rien sans raison apparente.
 */
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from "expo-audio";
import { File } from "expo-file-system";

import { marquerEcoute, oublierLigne, pistesParFichier } from "@/db/repos";
import {
  apresDernier,
  bornerCible,
  gardeFinInitial,
  majGardeFin,
  MARGE_FIN,
  modeBoucleSuivant,
  planifierAvance,
  planifierRecul,
  type GardeFin,
} from "@/playback/cible";
import { tirageEnTete } from "@/playback/melange";
import { useLecture, type PisteLecture } from "@/playback/store";

let lecteur: AudioPlayer | null = null;
let abonnement: { remove: () => void } | null = null;
let navigation: { remove: () => void } | null = null;
let file: PisteLecture[] = [];
let rang = 0;
let pret = false;
/**
 * L'ordre d'origine pendant la lecture aléatoire : il permet de rendre la file
 * à la playlist telle qu'on l'a choisie, sans interrompre le morceau en cours.
 */
let fileOriginale: PisteLecture[] = [];
// Garde anti double-fin : un `didJustFinish` parasite (statut de l'ancienne
// source encore en vol pendant replace(), seek près de la fin) ferait avancer
// deux fois. La règle exacte (source réellement chargée + fin pas déjà
// consommée) vit dans cible.ts, où elle est testée.
let gardeFin: GardeFin = gardeFinInitial;

export async function preparerLecteur() {
  if (pret) return;
  try {
    await setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: "doNotMix",
    });
  } catch {
    // Sans réglage de session, la lecture reste possible : on ne bloque rien.
  }
  pret = true;
  useLecture.getState().majPret(true);
}

function sourceDe(piste: PisteLecture) {
  return { uri: piste.fichier };
}

/**
 * Le fichier est-il vraiment là, et prêt à jouer ?
 *
 * Un titre « à transférer » peut traîner dans une file (fichier encore vide ou
 * absent) : il ne doit jamais passer — on ne lance pas la lecture d'un morceau
 * pas encore arrivé. Seules les adresses `file://` sont vérifiables ainsi ; une
 * adresse de contenu appartient au système, qui répondra lui-même à la lecture.
 */
function fichierPresent(piste: PisteLecture): boolean {
  if (!piste.fichier) return false;
  if (!piste.fichier.startsWith("file://")) return true;
  try {
    return new File(piste.fichier).exists;
  } catch {
    return true;
  }
}

/**
 * Suit l'état réel du lecteur et alimente le magasin.
 *
 * `didJustFinish` est le point qui compte : c'est là que le titre suivant
 * démarre, y compris écran éteint et application en arrière-plan. `error` est
 * l'autre : c'est la seule remontée d'un fichier illisible.
 */
function brancher() {
  abonnement?.remove();
  if (!lecteur) return;
  abonnement = lecteur.addListener("playbackStatusUpdate", (etat) => {
    const magasin = useLecture.getState();
    magasin.majPosition(etat.currentTime ?? 0, etat.duration ?? 0);
    magasin.majLecture(Boolean(etat.playing));
    if (etat.error) {
      magasin.majProbleme("Ce titre n'a pas pu être lu. Le fichier est peut-être incomplet.");
      magasin.majLecture(false);
      return;
    }
    const { consommer, prochain } = majGardeFin(gardeFin, Boolean(etat.didJustFinish));
    gardeFin = prochain;
    if (consommer) void suivant();
  });
}

/**
 * Écoute les contrôles venus du système — notification de lecture, écran
 * verrouillé. Le module ne connaît pas notre file, il n'y a donc pas de
 * « précédent/suivant » natif : il nous renvoie la direction, et c'est ici
 * qu'elle devient un mouvement dans la file, comme un appui sur l'écran.
 */
function brancherNavigation() {
  navigation?.remove();
  if (!lecteur) return;
  navigation = lecteur.addListener("sessionNavigation", (evenement) => {
    if (evenement.direction === "next") void suivant();
    else if (evenement.direction === "previous") void precedent();
  });
}

/**
 * Charge un titre de la file.
 *
 * Retourne faux quand rien n'a pu être chargé — le titre n'est plus sur le
 * téléphone, ou le lecteur l'a refusé. L'appelant s'arrête alors sur place,
 * plutôt que d'enchaîner les échecs sans rien dire.
 */
/**
 * Colle le mode « titre en boucle » au lecteur natif (repeat-one d'ExoPlayer).
 *
 * C'est lui qui répète le morceau avant qu'une fin n'arrive : en positionnant
 * `loop`, ExoPlayer reprend le même item sans jamais passer par l'état de fin
 * — `didJustFinish` ne se déclenche donc pas, et la file n'avance pas toute
 * seule. Les autres modes le désactivent : le lecteur redevient le maître de
 * l'enchaînement (didJustFinish → `suivant()`).
 */
function appliquerBoucleTitre() {
  try {
    if (lecteur) lecteur.loop = useLecture.getState().boucle === "titre";
  } catch {
    // Sans propriété loop, le mode « titre » reste inactif mais ne casse rien.
  }
}

async function charger(rangVoulu: number, jouerApres = true): Promise<boolean> {
  const piste = file[rangVoulu];
  if (!piste) return false;
  const magasin = useLecture.getState();

  if (!fichierPresent(piste)) {
    // Le fichier manque : toutes les occurrences qui le partageaient (le même
    // titre dans d'autres playlists) retombent à « à transférer » avec lui.
    for (const ligne of await pistesParFichier(piste.fichier)) {
      await oublierLigne(ligne.id);
    }
    magasin.majProbleme(
      `« ${piste.titre} » n'est pas sur le téléphone. Transfère sa playlist depuis l'ordinateur pour l'écouter.`,
    );
    magasin.majLecture(false);
    return false;
  }

  rang = rangVoulu;
  magasin.majIndex(rangVoulu);
  magasin.majProbleme(null);
  // Armement de la garde : tant que le nouveau flux n'a pas émis un tick
  // normal, un didJustFinish appartient encore à l'ancienne source (replace()
  // est non-bloquant) et doit être ignoré — sans quoi la boucle « passe au
  // titre suivant » au lieu de revenir en tête.
  gardeFin = { sourceStable: false, finConsommee: false };
  try {
    // On garde toujours le même lecteur, même à la boucle : recréer un
    // AudioPlayer détruit/rebondit sa session Media3 (l'ancien player terminé
    // reste lié au service) et le nouveau ne se remet jamais à jouer. Le
    // replace() sur le lecteur terminé, lui, fonctionne — c'est le même chemin
    // que l'enchaînement d'un titre au suivant.
    if (!lecteur) {
      lecteur = createAudioPlayer(sourceDe(piste));
      brancher();
      brancherNavigation();
      // repeatMode est un état du joueur : posé à la création seulement, puis
      // conservé par replace() — le mode « titre » suit donc chaque nouveau
      // titre tant qu'il est actif.
      appliquerBoucleTitre();
    } else {
      lecteur.replace(sourceDe(piste));
    }
    majTelecommande(piste);
    if (jouerApres) lecteur.play();
  } catch {
    magasin.majProbleme("Ce titre n'a pas pu être lu.");
    magasin.majLecture(false);
    return false;
  }
  void marquerEcoute(piste.id);
  return true;
}

// L'activation de l'écran verrouillé n'a lieu qu'une fois. La rappeler à
// chaque titre fait détruire puis recréer la MediaSession côté Android : à la
// fin naturelle d'un morceau, ce rebuild tape dans le teardown que le système
// est encore en train de faire de l'ancienne session → il envoie un stop à la
// session neuve et le titre suivant meurt silencieusement (NONE à ~340 ms).
// Un simple updateLockScreenMetadata, lui, ne touche pas la session.
let telecommandeActivee = false;

/**
 * Garde la session média en vie, sans jamais recréer celle qui tient.
 *
 * ## Le symptôme
 *
 * La notification disparaissait au bout d'un moment : plus de notification,
 * donc plus de barre de progression, alors que le son jouait toujours. Le
 * drapeau `telecommandeActivee` en est la cause : une fois la session créée,
 * plus rien ne la surveillait. Or Android la détruit quand il veut (pression
 * mémoire, Doze, swipe de l'app). Le drapeau restait nevertheless `true`, et
 * chaque titre suivant se contentait d'appeler `updateLockScreenMetadata` — sur
 * une session morte, sans effet.
 *
 * ## Pourquoi on ne « teste » pas la session
 *
 * Deux raisons, et la seconde est celle qui compte :
 *
 * 1. `updateLockScreenMetadata` renvoie `void` et ne lève jamais : un test ne
 *    dirait rien sur l'état réel de la session.
 * 2. Rappeler `setActiveForLockScreen` pour « vérifier » tuerait la lecture.
 *    C'est ce que dit le commentaire plus haut : à la fin naturelle d'un
 *    morceau, la reconstruction tombe dans le teardown que le système est
 *    encore en train de faire de l'ancienne session, et lui renvoie un `stop` —
 *    le titre suivant meurt en silence (NONE à ~340 ms).
 *
 * ## Ce qu'on fait à la place
 *
 * Le module natif publie déjà l'état de lecture au fil de l'eau (c'est lui qui
 * fait avancer la progress bar). Il n'a donc rien à lui souffler à chaque
 * titre : la session se maintient toute seule tant qu'elle existe.
 *
 * Reste le cas vrai : la session a été détruite pendant que le drapeau mentait.
 * On le traite sans le deviner — `arreter()` remet le drapeau à zéro, et le
 * prochain titre réactive proprement. Une activation qui échoue laisse le
 * drapeau à `false` : elle sera retérée au titre suivant plutôt que de figer
 * un état faux.
 */
async function assurerTelecommande(piste: PisteLecture): Promise<void> {
  const metadonnees = {
    title: piste.titre,
    artist: piste.chaine,
    artworkUrl: piste.pochette ?? undefined,
  };
  try {
    // La durée, d'abord. Le media item natif est bâti par `MediaItem.fromUri`,
    // sans durée : la notification montrait alors une barre de position SANS
    // curseur, et l'utilisateur ne savait pas où il en était ni où glisser.
    // On la transmet donc explicitement — c'est le seul endroit où elle existe.
    lecteur?.setPlayerDuration(piste.duree);
    if (telecommandeActivee) {
      // Simple changement de texte : ne touche pas à la session, donc sans
      // risque pour la lecture en cours.
      lecteur?.updateLockScreenMetadata(metadonnees);
      return;
    }
    await lecteur?.setActiveForLockScreen(true, metadonnees, {
      // « Précédent/suivant » : le mode natif n'a pas de concept de file
      // (elle est tenue en JavaScript), ces boutons remontent donc en
      // événement, et brancherNavigation() les traduit en mouvement.
      showSkipPrevious: true,
      showSkipNext: true,
    });
    telecommandeActivee = true;
    // La durée est renvoyée après l'activation : la session vient de naître, et
    // le wrapper qui la reçoit n'existe qu'à partir de là.
    lecteur?.setPlayerDuration(piste.duree);
  } catch {
    // Le module ne propose pas les commandes, ou l'activation a échoué : on ne
    // prétend pas que la session est active, et on réessaiera au titre suivant.
    telecommandeActivee = false;
  }
}

/** Ce que la notification et l'écran verrouillé annoncent. */
function majTelecommande(piste: PisteLecture) {
  void assurerTelecommande(piste);
}

/** Charge une file et démarre au titre demandé. */
export async function jouer(nouvelleFile: PisteLecture[], index: number) {
  await preparerLecteur();
  if (useLecture.getState().melanger && nouvelleFile.length > 1) {
    // La lecture aléatoire reste active d'une playlist à l'autre : le titre
    // choisi démarre, le reste est tiré sans remise.
    const choisi = nouvelleFile[index];
    if (choisi) {
      fileOriginale = [...nouvelleFile];
      file = tirageEnTete(nouvelleFile, choisi);
      useLecture.getState().definirFile(file, 0);
      await charger(0);
      return;
    }
  }
  file = nouvelleFile;
  useLecture.getState().definirFile(nouvelleFile, index);
  await charger(index);
}

/**
 * Passe en lecture aléatoire : le titre en cours passe en tête — il continue de
 * jouer, on ne le recharge pas — et tout le reste est tiré sans remise. La file
 * à venir est donc toujours complète, quel que soit l'endroit où l'on bascule.
 */
export function activerAleatoire() {
  const magasin = useLecture.getState();
  if (magasin.melanger) return;
  const enCours = magasin.file[magasin.index] ?? null;
  if (!enCours) return;
  fileOriginale = [...magasin.file];
  const ordre = tirageEnTete(magasin.file, enCours);
  file = ordre;
  rang = 0;
  magasin.majMelange(true);
  magasin.majFile(ordre);
  magasin.majRang(0);
}

/** Rend son ordre d'origine à la file, sans interrompre le morceau en cours. */
export function desactiverAleatoire() {
  const magasin = useLecture.getState();
  if (!magasin.melanger) return;
  magasin.majMelange(false);
  if (fileOriginale.length === 0) return;
  const enCours = magasin.file[magasin.index] ?? null;
  file = fileOriginale;
  magasin.majFile(fileOriginale);
  if (enCours) {
    const rangOriginal = fileOriginale.findIndex((piste) => piste.id === enCours.id);
    if (rangOriginal >= 0) {
      rang = rangOriginal;
      magasin.majRang(rangOriginal);
    }
  }
}

export function basculerAleatoire() {
  if (useLecture.getState().melanger) desactiverAleatoire();
  else activerAleatoire();
}

/**
 * Démarre la lecture d'une file en ordre aléatoire.
 *
 * Le titre choisi garde sa place et joue d'abord ; le reste est tiré sans
 * remise, comme le fait le bouton du lecteur. La file passée n'est jamais
 * réordonnée : l'origine est conservée dans `fileOriginale` (rendue telle
 * quelle quand on coupe l'aléatoire), et l'affichage de la bibliothèque garde
 * son indexation et son ordre. `melanger` ne touche pas à la table donnée.
 */
export async function jouerAleatoirement(nouvelleFile: PisteLecture[], index = 0) {
  await preparerLecteur();
  const magasin = useLecture.getState();
  if (nouvelleFile.length === 0) return;
  fileOriginale = [...nouvelleFile];
  const choisi = nouvelleFile[index] ?? nouvelleFile[0];
  file = nouvelleFile.length > 1 ? tirageEnTete(nouvelleFile, choisi) : [choisi];
  magasin.majMelange(true);
  magasin.definirFile(file, 0);
  await charger(0);
}

/**
 * Fait tourner le bouton « lecture en boucle » sur ses trois états : simple →
 * file → titre → simple.
 *
 * Le repeat-one est appliqué au lecteur dès le passage en mode « titre » ;
 * sinon il n'y a que le mode « file » (et l'aléatoire) qui décide du retour en
 * tête — la fin reste naturelle sinon.
 */
export function basculerBoucle() {
  const magasin = useLecture.getState();
  magasin.majBoucle(modeBoucleSuivant(magasin.boucle));
  appliquerBoucleTitre();
}

/**
 * Libère le service de lecture quand il n'a plus rien à faire.
 *
 * Android maintient le process vivant tant qu'un service de premier plan de type
 * `mediaPlayback` est déclaré actif. C'est voulu — c'est ce qui fait tourner la
 * musique quand on quitte l'app — mais quand AUCUN titre ne joue, ce service ne
 * sert plus à rien : il garde pourtant le process en mémoire pour rien, et sa
 * notification fantôme finit par disparaître (bug que le patch `onIsPlayingChanged`
 * de `scripts/patch-expo-audio.sh` traite).
 *
 * On rend donc la session au système dès que l'application passe en arrière-plan
 * et qu'aucun son ne joue. Le musicien n'y perd rien : sans titre chargé, il n'y
 * a rien à reprendre ni à contrôler.
 *
 * Le téléchargement, lui, a son propre service et n'est pas touché : vider la
 * file libère la lecture, pas un transfert en cours.
 */
export function libererSiInactif(): void {
  try {
    if (useLecture.getState().file.length > 0) return;
    if (!telecommandeActivee) return;
    lecteur?.setActiveForLockScreen(false);
    telecommandeActivee = false;
  } catch {
    // Un service déjà détaché n'empêche rien : c'est l'état qu'on voulait.
  }
}

/**
 * Arrête la lecture et referme le mini-lecteur.
 *
 * C'est le geste du balayage : la carte s'en va, la musique avec elle. On coupe
 * le son avant de vider la file — une file vidée pendant que le lecteur joue
 * laisserait le titre continuer sans que rien ne le commande — et l'on rend la
 * session à la notification, sinon la prochaine lecture n'y apparaîtrait plus.
 */
export function arreter() {
  try {
    lecteur?.pause();
    if (telecommandeActivee) {
      lecteur?.setActiveForLockScreen(false);
      telecommandeActivee = false;
    }
  } catch {
    // Un lecteur déjà éteint n'empêche pas de vider la file.
  }
  file = [];
  fileOriginale = [];
  rang = 0;
  pret = false;
  useLecture.getState().vider();
}

export async function basculer() {
  if (!lecteur) return;
  const magasin = useLecture.getState();
  try {
    if (magasin.lecture) {
      lecteur.pause();
      magasin.majLecture(false);
      return;
    }
    // Une source achevée ne redémarre pas avec un simple play() : on reprend
    // depuis le début, sans quoi le bouton resterait muet jusqu'au prochain
    // titre chargé.
    if (magasin.duree > 0 && magasin.position >= magasin.duree - MARGE_FIN) {
      await lecteur.seekTo(0);
    }
    lecteur.play();
    magasin.majLecture(true);
  } catch {
    magasin.majProbleme("La lecture n'a pas pu reprendre.");
    magasin.majLecture(false);
  }
}

export async function suivant() {
  if (rang + 1 >= file.length) {
    // Fin de la passe : retour à la tête en aléatoire (le cycle EST l'ordre)
    // ou en boucle ; sinon on s'arrête là, sans boucler sans le dire.
    const etat = useLecture.getState();
    if (apresDernier(file.length, etat.melanger, etat.boucle) === 0) {
      await charger(0);
      return;
    }
    lecteur?.pause();
    useLecture.getState().majLecture(false);
    return;
  }
  await charger(rang + 1);
}

export async function precedent() {
  const { position } = useLecture.getState();
  if (position > 3) {
    await chercher(0);
    return;
  }
  if (rang === 0) {
    await chercher(0);
    return;
  }
  await charger(rang - 1);
}

export async function sauterA(index: number) {
  await charger(index);
}

/** Avance de 15 s ; dépasser la fin fait démarrer le titre suivant. */
export async function avancer() {
  const magasin = useLecture.getState();
  if (!magasin.file[magasin.index]) return;
  const deplacement = planifierAvance(
    magasin.position,
    magasin.duree,
    magasin.index + 1 >= magasin.file.length,
  );
  if (deplacement.type === "saut") await charger(magasin.index + 1);
  else await chercher(deplacement.cible);
}

/** Recule de 15 s, borné au début du morceau — jamais au titre précédent. */
export async function reculer() {
  const magasin = useLecture.getState();
  if (!magasin.file[magasin.index]) return;
  await chercher(planifierRecul(magasin.position).cible);
}

export async function chercher(position: number) {
  if (!lecteur) return;
  const { duree } = useLecture.getState();
  try {
    await lecteur.seekTo(bornerCible(position, duree));
  } catch {
    useLecture.getState().majProbleme("Impossible de se déplacer dans ce titre.");
  }
}
