/**
 * Mini-navigateur : on parcourt le web, on ramène un audio.
 *
 * L'écran est un navigateur à part entière — barre d'adresse, retour, avant,
 * recharger — avec une promesse en plus : quand une vidéo YouTube joue dans la
 * page, un bouton « Télécharger l'audio » apparaît. L'auteur du bouton est un
 * traqueur injecté dans la page, qui signale la lecture réelle d'un élément
 * média : le téléchargement se propose parce que la musique joue, pas seulement
 * parce que l'URL ressemble à une vidéo.
 *
 * Si l'injection est bloquée par la page, l'URL seule retombe sur ses pieds :
 * la fonctionnalité ne doit pas dépendre d'une page qui refuserait le script.
 */
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import * as repo from "@/db/repos";
import type { Playlist } from "@/db/repos";
import { informer, videoIdDepuisUrl, type InfoDirect } from "@/library/direct";
import { PAUSE_MEDIA_JS, TRAQUEUR_JS } from "@/library/traqueur";
import { formaterDuree } from "@/transfer/format";
import { useApp, type DemandeDirect } from "@/state/app";
import { useLecture } from "@/playback/store";
import { basDuBoutonFlottant } from "@/ui/barre";
import { Bandeau, Bouton, Feuille, Separateur, Spinner, TitreSection } from "@/ui/kit";
import { useDialogue } from "@/ui/dialog";
import {
  IconChevronLeft,
  IconChevronRight,
  IconClose,
  IconCloudDown,
  IconNavigateur,
  IconPlus,
  IconPlay,
  IconSearch,
} from "@/ui/icons";
import { Vignette } from "@/ui/vignette";
import { colors, radius, space, touch, type as typo } from "@/theme/tokens";

/**
 * Le mini-navigateur s'ouvre vide : la WebView ne naît qu'à la première
 * adresse. Charger l'accueil d'un site au montage coutait cher à l'ouverture
 * de l'onglet (la page lourde se construisait à chaque premier affichage) et
 * gardait une page en fond ensuite. Le traqueur de lecture est générique : il
 * s'attache a n'importe quel element <video>/<audio>, rien ne depend du site.
 */

/**
 * Raccourci de l'écran vide : une destination tapée d'un pouce. La carte ne
 * connaît pas la navigation, elle ne fait que la déclencher — le libellé et la
 * promesse restent à l'écran.
 */
function CarteDestination({
  libelle,
  sousTitre,
  icone,
  surAppui,
}: {
  libelle: string;
  sousTitre: string;
  icone: ReactNode;
  surAppui: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Aller sur ${libelle}`}
      onPress={surAppui}
      style={({ pressed }) => [styles.destination, pressed && styles.pressions]}
    >
      <View style={styles.destinationMarque}>{icone}</View>
      <View style={styles.destinationTextes}>
        <Text style={styles.destinationTitre}>{libelle}</Text>
        <Text style={styles.destinationSousTitre}>{sousTitre}</Text>
      </View>
      <IconChevronRight size={18} color={colors.ink2} />
    </Pressable>
  );
}

export default function Navigateur() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const webview = useRef<WebView>(null);
  const animations = useApp((etat) => etat.animations);
  const telechargerDirect = useApp((etat) => etat.telechargerDirect);
  const creerPlaylist = useApp((etat) => etat.creerPlaylist);
  /** Transferts en cours : la barre d'adresse tourne tant que le son arrive. */
  const transfertsActifs = useApp((etat) => etat.transferts);
  const mini = useLecture((etat) => etat.file.length > 0);
  const { ouvrir: ouvrirDialogue, element: dialogue } = useDialogue();

  const [saisie, setSaisie] = useState("");
  const [chargee, setChargee] = useState("");
  const [enChargement, setEnChargement] = useState(false);
  const [peutAllerArriere, setPeutAllerArriere] = useState(false);
  const [peutAllerAvant, setPeutAllerAvant] = useState(false);
  /** Le traqueur a-t-il déjà parlé ? Tant que non, l'URL suffit (repli). */
  const [traqueurVivant, setTraqueurVivant] = useState(false);
  /** Une vidéo joue-t-elle vraiment dans la page ? */
  const [lectureDetectee, setLectureDetectee] = useState(false);
  const [feuilleOuverte, setFeuilleOuverte] = useState(false);
  /** L'audio de la vidéo en cours est en préparation : la barre d'adresse tourne. */
  const [enPreparation, setEnPreparation] = useState(false);

  const videoId = videoIdDepuisUrl(chargee);
  const proposeLeBouton = Boolean(videoId) && (lectureDetectee || !traqueurVivant);

  // Cycle de vie de l'écran : au retour, on réveille le traqueur (la page est
  // toujours là) ; en partant, on met le média en pause — l'onglet quitté ne
  // doit pas continuer de sonner en arrière-plan, et le bouton de téléchargement
  // ne doit pas pointer vers une lecture qu'on ne voit plus. deps vides : la
  // pause ne doit pas se rejouer à chaque changement de page.
  useFocusEffect(
    useCallback(() => {
      webview.current?.injectJavaScript(TRAQUEUR_JS);
      return () => {
        webview.current?.injectJavaScript(PAUSE_MEDIA_JS);
        setLectureDetectee(false);
        setTraqueurVivant(false);
      };
    }, []),
  );

  const aller = (brut: string) => {
    const nettoye = brut.trim();
    if (!nettoye) return;
    const avecProtocole = /^https?:\/\//i.test(nettoye) ? nettoye : `https://${nettoye}`;
    setSaisie(nettoye);
    setTraqueurVivant(false);
    setLectureDetectee(false);
    if (avecProtocole === chargee) {
      webview.current?.reload();
      return;
    }
    setChargee(avecProtocole);
  };

  const surMessage = (evenement: WebViewMessageEvent) => {
    try {
      const message = JSON.parse(evenement.nativeEvent.data) as {
        type: string;
        enLecture?: boolean;
      };
      if (message.type !== "media") return;
      setTraqueurVivant(true);
      setLectureDetectee(Boolean(message.enLecture));
    } catch {
      // Un message que le traqueur n'a pas écrit : on l'ignore.
    }
  };

  return (
    <View style={styles.porte}>
      <View style={styles.barreAdresse}>
        <Commande
          libelle="Revenir en arrière"
          desactive={!peutAllerArriere}
          onPress={() => webview.current?.goBack()}
        >
          <IconChevronLeft size={20} color={colors.ink} />
        </Commande>
        <Commande
          libelle="Aller en avant"
          desactive={!peutAllerAvant}
          onPress={() => webview.current?.goForward()}
        >
          <IconChevronRight size={20} color={colors.ink} />
        </Commande>
        <TextInput
          value={saisie}
          onChangeText={setSaisie}
          onSubmitEditing={() => aller(saisie)}
          placeholder="Une adresse, ou une recherche"
          placeholderTextColor={colors.ink3}
          returnKeyType="go"
          keyboardType="url"
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Adresse du navigateur"
          style={styles.champ}
        />
        {chargee ? (
          enChargement || enPreparation || transfertsActifs > 0 ? (
            <View style={styles.spin}>
              <Spinner taille={18} couleur={colors.ink2} />
            </View>
          ) : (
            <Commande libelle="Recharger la page" onPress={() => webview.current?.reload()}>
              <IconNavigateur size={18} color={colors.ink2} />
            </Commande>
          )
        ) : null}
      </View>

      {chargee ? (
        <WebView
          ref={webview}
          source={{ uri: chargee }}
          style={styles.page}
          javaScriptEnabled
          domStorageEnabled
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          startInLoadingState
          injectedJavaScriptBeforeContentLoaded={TRAQUEUR_JS}
          onMessage={surMessage}
          onLoadStart={(avant) => {
            setEnChargement(true);
            // Une nouvelle page est une nouvelle histoire : la lecture détectée
            // sur la précédente ne s'applique plus.
            const nouvelId = videoIdDepuisUrl(avant.nativeEvent.url);
            if (nouvelId !== videoId) {
              setLectureDetectee(false);
              setTraqueurVivant(false);
            }
          }}
          onNavigationStateChange={(etat) => {
            setEnChargement(etat.loading);
            setPeutAllerArriere(etat.canGoBack ?? false);
            setPeutAllerAvant(etat.canGoForward ?? false);
            if (etat.url) setChargee(etat.url);
            // Le player YouTube se monte après le chargement : on réinjecte le
            // traqueur sur la page courante, au cas où l'injection initiale n'a
            // rien attrapé. Le garde interne rend l'opération idempotente.
            webview.current?.injectJavaScript(TRAQUEUR_JS);
          }}
        />
      ) : (
        <View style={styles.vide}>
          <View style={styles.videMarque}>
            <IconNavigateur size={30} color={colors.ink2} />
          </View>
          <Text style={styles.videTitre}>Aucune page ouverte</Text>
          <Text style={styles.videTexte}>
            Tape une adresse ou colle un lien : dès que la page joue une vidéo, le bouton «
            Télécharger l’audio » apparaît.
          </Text>
          <View style={styles.destinations}>
            <CarteDestination
              libelle="YouTube"
              sousTitre="Regarder, écouter, télécharger"
              icone={<IconPlay size={22} color={colors.ink} />}
              surAppui={() => aller("https://www.youtube.com")}
            />
          </View>
        </View>
      )}

      {proposeLeBouton && videoId ? (
        <BoutonAudio
          animations={animations}
          onPress={() => setFeuilleOuverte(true)}
          bottom={basDuBoutonFlottant(insets.bottom, mini)}
        />
      ) : null}

      <FeuilleTelechargement
        visible={feuilleOuverte}
        videoId={videoId}
        onFermer={() => setFeuilleOuverte(false)}
        onLancement={(demande) => void lancer(demande)}
        creerPlaylist={creerPlaylist}
        onPreparationChange={setEnPreparation}
      />

      {dialogue}
    </View>
  );

  /** Un téléchargement confirmé : on le confie, puis on raconte l'issue. */
  async function lancer(demande: DemandeDirect) {
    const resultat = await telechargerDirect(demande);
    setFeuilleOuverte(false);
    if (resultat.ok) {
      ouvrirDialogue({
        titre: "C'est parti",
        message: `« ${demande.titre} » arrive dans ta playlist. Tu le retrouveras dans Téléchargements.`,
        icone: <IconCloudDown size={26} color="#04121f" />,
        confirmer: "Voir les téléchargements",
        surConfirmer: () => router.push("/downloads"),
      });
      return;
    }
    if (resultat.raison === "deja") {
      ouvrirDialogue({
        titre: "Déjà dans ta bibliothèque",
        message: "Cet audio est déjà sur ton téléphone.",
        icone: <IconCloudDown size={26} color="#04121f" />,
      });
      return;
    }
    ouvrirDialogue({
      ton: "danger",
      titre: "Téléchargement impossible",
      message:
        resultat.raison === "introuvable"
          ? "Cette playlist n'existe plus sur le téléphone. Choisis-en une autre."
          : resultat.message ?? "L'audio n'a pas pu être téléchargé. Réessaie dans un instant.",
      icone: <IconClose size={26} color={colors.danger} />,
    });
  }
}

/** Une commande de la barre d'adresse : 48 dp, jamais moins. */
function Commande({
  libelle,
  onPress,
  children,
  desactive = false,
}: {
  libelle: string;
  onPress: () => void;
  children: React.ReactNode;
  desactive?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={libelle}
      accessibilityState={{ disabled: desactive }}
      disabled={desactive}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [styles.commande, desactive && styles.commandeInactive, pressed && styles.pressions]}
    >
      {children}
    </Pressable>
  );
}

/**
 * Bouton « Télécharger l'audio ».
 *
 * Il pulse doucement pour se faire remarquer — jamais quand l'appareil refuse
 * les animations. Le halo d'accent dit ce que le bouton va faire, en plus du
 * libellé : un geste gratuit sinon.
 */
function BoutonAudio({
  animations,
  onPress,
  bottom,
}: {
  animations: boolean;
  onPress: () => void;
  bottom: number;
}) {
  const [pulsation] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (!animations) return;
    const boucle = Animated.loop(
      Animated.sequence([
        Animated.timing(pulsation, { toValue: 1, duration: 1400, useNativeDriver: true }),
        Animated.timing(pulsation, { toValue: 0, duration: 1400, useNativeDriver: true }),
      ]),
    );
    boucle.start();
    return () => boucle.stop();
  }, [animations, pulsation]);

  return (
    <Animated.View
      style={[
        styles.boutonAnimation,
        {
          bottom,
          transform: [
            {
              scale: pulsation.interpolate({
                inputRange: [0, 1],
                outputRange: [1, 0.965],
              }),
            },
          ],
          opacity: pulsation.interpolate({ inputRange: [0, 1], outputRange: [1, 0.93] }),
        },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Télécharger l'audio"
        onPress={onPress}
        style={({ pressed }) => [styles.boutonAudio, pressed && styles.pressions]}
      >
        <IconCloudDown size={20} color="#04121f" />
        <Text style={styles.boutonAudioTexte}>Télécharger l’audio</Text>
      </Pressable>
    </Animated.View>
  );
}

/**
 * La feuille de téléchargement : ce qu'on a trouvé, où ça va tomber.
 *
 * La liste est réservée aux playlists nées sur le téléphone : une playlist
 * venue de l'ordinateur est la copie d'une source, elle ne se remplit pas ici.
 * On peut en créer une sur le moment, sans quitter l'écran.
 */
function FeuilleTelechargement({
  visible,
  videoId,
  onFermer,
  onLancement,
  creerPlaylist,
  onPreparationChange,
}: {
  visible: boolean;
  videoId: string | null;
  onFermer: () => void;
  onLancement: (demande: DemandeDirect) => void;
  creerPlaylist: (nom: string) => Promise<string | null>;
  /** L'extraction est en cours : l'écran peut l'animer dans la barre d'adresse. */
  onPreparationChange: (enCours: boolean) => void;
}) {
  const [info, setInfo] = useState<InfoDirect | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [enExtraction, setEnExtraction] = useState(false);
  const [locales, setLocales] = useState<Playlist[]>([]);
  const [choisie, setChoisie] = useState<string | null>(null);
  /** Filtre de la liste des playlists : une longue liste se cherche. */
  const [filtre, setFiltre] = useState("");
  const [nouveauNom, setNouveauNom] = useState(false);
  const [nouvelle, setNouvelle] = useState("");

  // Le contenu décrit la vidéo COURANTE : à chaque changement de (visible,
  // videoId) on repart d'une feuille neuve. Ajustement d'état pendant le
  // rendu (Recommandation React) plutôt qu'un effet — sinon rendus en
  // cascade et un reset qui reboucle.
  const [cle, setCle] = useState(`${visible}:${videoId ?? "aucune"}`);
  if (cle !== `${visible}:${videoId ?? "aucune"}`) {
    setCle(`${visible}:${videoId ?? "aucune"}`);
    setInfo(null);
    setErreur(null);
    setEnExtraction(true);
    setChoisie(null);
    setFiltre("");
    setNouveauNom(false);
    setNouvelle("");
  }

  // Extraction au premier rendu visible. Tous les changements d'état suivent
  // un await : l'effet ne fait que lancer le flux, il ne modifie pas l'état
  // de façon synchrone.
  useEffect(() => {
    if (!visible || !videoId) return;
    let actif = true;
    onPreparationChange(true);
    const fil = (async () => {
      const liste = await repo.listerPlaylists();
      if (!actif) return;
      const locales = liste.filter((playlist) => playlist.locale === 1);
      setLocales(locales);
      setChoisie(locales[0]?.playlist_id ?? null);
      setInfo(await informer(videoId));
    })().catch((raise) => {
      if (actif) setErreur(raise instanceof Error ? raise.message : "Extraction impossible.");
    });
    void fil.finally(() => {
      if (actif) setEnExtraction(false);
      // L'extraction est terminée même en cas d'échec : plus rien à animer.
      if (actif) onPreparationChange(false);
    });
    return () => {
      actif = false;
      onPreparationChange(false);
    };
  // Dépendance stable : le parent passe le régleur d'état, dont l'identité ne
  // change jamais. Appeler onPreparationChange(false) dans le nettoyage laisse
  // la barre d'adresse s'arrêter même si l'extraction répond après le départ.
  }, [visible, videoId, onPreparationChange]);

  const terme = filtre.trim().toLowerCase();
  const visibles = terme
    ? locales.filter((playlist) => playlist.nom.toLowerCase().includes(terme))
    : locales;

  const pret = Boolean(info && (choisie || (nouveauNom && nouvelle.trim())));

  /**
   * Le filtre et la sélection avancent ensemble.
   *
   * Laisser la sélection sur une playlist que le filtre vient de cacher ferait
   * partir le téléchargement vers une cible invisible : la sélection retombe
   * donc sur la première ligne encore visible.
   */
  const filtrer = (texte: string) => {
    setFiltre(texte);
    if (nouveauNom) return;
    const cherche = texte.trim().toLowerCase();
    const restants = cherche
      ? locales.filter((playlist) => playlist.nom.toLowerCase().includes(cherche))
      : locales;
    if (!restants.some((playlist) => playlist.playlist_id === choisie)) {
      setChoisie(restants[0]?.playlist_id ?? null);
    }
  };

  const confirmer = () => {
    if (!info || !videoId || !pret) return;
    const depart = async () => {
      if (nouveauNom && nouvelle.trim()) {
        const id = await creerPlaylist(nouvelle);
        if (!id) return;
        onLancement({
          videoId,
          titre: info.titre,
          chaine: info.chaine,
          duree: info.duree,
          format: { ext: info.format.ext, url: info.format.url ?? "" },
          pochette: info.pochette,
          playlistId: id,
        });
        return;
      }
      if (!choisie) return;
      onLancement({
        videoId,
        titre: info.titre,
        chaine: info.chaine,
        duree: info.duree,
        format: { ext: info.format.ext, url: info.format.url ?? "" },
        pochette: info.pochette,
        playlistId: choisie,
      });
    };
    void depart();
  };

  return (
    <Feuille
      visible={visible && Boolean(videoId)}
      onFermer={onFermer}
      titre="Télécharger l’audio"
      sousTitre={
        info ? `${info.chaine || "YouTube"} · ${formaterDuree(info.duree)}` : "Préparation…"
      }
    >
      <ScrollView
        style={styles.feuilleContenu}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {enExtraction ? (
          <View style={styles.extraction}>
            <Spinner taille={36} couleur={colors.accent} />
          </View>
        ) : erreur ? (
          <Bandeau ton="bad" texte={erreur} />
        ) : info ? (
          <>
            <View style={styles.avant}>
              <Vignette pochette={info.pochette} titre={info.titre} />
              <View style={styles.avantCentre}>
                <Text style={styles.avantTitre} numberOfLines={2}>
                  {info.titre}
                </Text>
                <Text style={styles.avantDetail} numberOfLines={1}>
                  {info.chaine || "YouTube"} · {formaterDuree(info.duree)}
                </Text>
              </View>
            </View>
            <Separateur />
          </>
        ) : null}

        <TitreSection texte="Télécharger dans" style={styles.libelle} />
        {/* Le filtre n'apparaît que sur une longue liste : sous trois
            playlists, il prendrait plus de place qu'il n'en ferait gagner. */}
        {locales.length > 3 ? (
          <View style={styles.recherche}>
            <IconSearch size={16} color={colors.ink2} />
            <TextInput
              value={filtre}
              onChangeText={filtrer}
              placeholder="Rechercher une playlist"
              placeholderTextColor={colors.ink3}
              style={styles.rechercheChamp}
              accessibilityLabel="Rechercher une playlist"
              returnKeyType="search"
            />
            {filtre ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Effacer la recherche"
                onPress={() => filtrer("")}
                hitSlop={6}
                style={({ pressed }) => [pressed && styles.pressions]}
              >
                <IconClose size={16} color={colors.ink2} />
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {visibles.map((playlist) => {
          const active = !nouveauNom && choisie === playlist.playlist_id;
          return (
            <Pressable
              key={playlist.playlist_id}
              accessibilityRole="radio"
              accessibilityState={{ checked: active }}
              accessibilityLabel={playlist.nom}
              onPress={() => {
                setNouveauNom(false);
                setChoisie(playlist.playlist_id);
              }}
              style={({ pressed }) => [styles.choix, active && styles.choixActif, pressed && styles.pressions]}
            >
              <Text style={[styles.choixTexte, active && styles.choixTexteActif]} numberOfLines={1}>
                {playlist.nom}
              </Text>
              <Text style={styles.choixCompte} numberOfLines={1}>
                {(playlist.titres ?? 0) > 1
                  ? `${playlist.titres} titres`
                  : `${playlist.titres ?? 0} titre`}
              </Text>
            </Pressable>
          );
        })}

        <Pressable
          accessibilityRole="radio"
          accessibilityState={{ checked: nouveauNom }}
          accessibilityLabel="Nouvelle playlist"
          onPress={() => setNouveauNom(true)}
          style={({ pressed }) => [
            styles.choix,
            nouveauNom && styles.choixActif,
            pressed && styles.pressions,
          ]}
        >
          <IconPlus size={17} color={nouveauNom ? colors.accent : colors.ink2} />
          <Text style={[styles.choixTexte, nouveauNom && styles.choixTexteActif]}>
            Nouvelle playlist…
          </Text>
        </Pressable>
        {nouveauNom ? (
          <TextInput
            value={nouvelle}
            onChangeText={setNouvelle}
            placeholder="Nom de la playlist"
            placeholderTextColor={colors.ink3}
            style={styles.champNouveau}
            accessibilityLabel="Nom de la nouvelle playlist"
            autoFocus
            returnKeyType="done"
          />
        ) : null}
        {locales.length === 0 && !nouveauNom ? (
          <Text style={styles.aucune}>
            Aucune playlist créée sur le téléphone pour l’instant. Crées-en une juste dessus.
          </Text>
        ) : null}
        {locales.length > 0 && visibles.length === 0 && !nouveauNom ? (
          <Text style={styles.aucune}>Aucune playlist ne correspond à cette recherche.</Text>
        ) : null}

        {enExtraction || erreur ? null : (
          <Bouton
            titre={nouveauNom ? "Créer et télécharger" : "Télécharger"}
            onPress={confirmer}
            desactive={!pret}
            icone={<IconCloudDown size={18} color={colors.onPrimary} />}
            style={styles.boutonBas}
          />
        )}
      </ScrollView>
    </Feuille>
  );
}

const styles = StyleSheet.create({
  porte: { flex: 1, backgroundColor: colors.canvas },
  barreAdresse: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    paddingTop: space.sm,
    paddingHorizontal: space.sm,
    paddingBottom: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  commande: {
    width: touch.min,
    height: touch.min,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  commandeInactive: { opacity: 0.35 },
  champ: {
    flex: 1,
    minHeight: 42,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.ink,
    fontSize: 14,
    paddingVertical: 0,
  },
  spin: { width: touch.min, height: touch.min, alignItems: "center", justifyContent: "center" },
  page: { flex: 1, backgroundColor: colors.canvas },

  // --- Aucune page ouverte ---
  vide: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    paddingHorizontal: space.xl,
    paddingVertical: space.xxl,
  },
  videMarque: {
    width: 62,
    height: 62,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 6,
  },
  videTitre: { ...typo.vide, color: colors.ink, textAlign: "center" },
  videTexte: {
    fontSize: 13.5,
    lineHeight: 19,
    fontWeight: "500",
    color: colors.ink2,
    textAlign: "center",
    maxWidth: 300,
  },
  destinations: {
    width: "100%",
    maxWidth: 320,
    gap: 10,
    marginTop: 6,
  },
  destination: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  destinationMarque: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.border,
  },
  destinationTextes: { flex: 1, gap: 1 },
  destinationTitre: { ...typo.valeur, color: colors.ink },
  destinationSousTitre: { ...typo.caption, color: colors.ink2 },
  pressions: { opacity: 0.72 },

  // --- Bouton flottant ---
  boutonAnimation: { position: "absolute", right: 18 },
  boutonAudio: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    minHeight: 52,
    paddingHorizontal: 19,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    shadowColor: colors.accent,
    shadowOpacity: 0.4,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  boutonAudioTexte: { ...typo.body, fontWeight: "800", color: "#04121f" },

  // --- Feuille ---
  feuilleContenu: { marginHorizontal: -space.md },
  extraction: {
    alignItems: "center",
    paddingVertical: 48,
  },
  avant: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
  },
  avantCentre: { flex: 1, gap: 2 },
  avantTitre: { ...typo.ligne, fontWeight: "700", color: colors.ink },
  avantDetail: { ...typo.caption, color: colors.ink2 },
  libelle: { marginBottom: space.sm },
  recherche: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: space.sm,
  },
  rechercheChamp: { flex: 1, color: colors.ink, fontSize: 14, padding: 0 },
  choix: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: touch.min,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: space.xs,
  },
  choixActif: { borderColor: "rgba(0,217,255,0.55)", backgroundColor: "rgba(0,217,255,0.08)" },
  choixTexte: { flex: 1, ...typo.ligne, color: colors.ink },
  choixTexteActif: { color: colors.accent },
  choixCompte: { ...typo.caption, color: colors.ink2 },
  champNouveau: {
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.borderFort,
    color: colors.ink,
    fontSize: 14,
    marginBottom: space.sm,
  },
  aucune: { ...typo.note, color: colors.ink2, paddingHorizontal: space.md },
  boutonBas: { marginTop: space.sm },
});