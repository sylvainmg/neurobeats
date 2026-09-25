/** Petites pièces d'interface communes, taillées sur la maquette. */
import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useState, useRef, type ReactNode } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ActivityIndicator,
  Animated,
  Easing,
  EasingFunction,
  type GestureResponderEvent,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";

import { IconAlert, IconCodeQr, IconSync } from "@/ui/icons";
import { useApp } from "@/state/app";
import { colors, degrade, ease, ombre, radius, space, tabular, touch, type as typo } from "@/theme/tokens";

const COURBE = Easing.bezier(ease[0], ease[1], ease[2], ease[3]) as EasingFunction;

/**
 * En-tête d'écran : le titre et sa mesure.
 *
 * La maquette n'a pas de barre de marque — le nom du produit n'apprend rien à
 * quelqu'un qui a déjà ouvert l'app. Ce qui compte, c'est où l'on est et ce que
 * l'écran contient (« Bibliothèque · 24 titres »).
 */
export function EnTeteEcran({
  titre,
  meta,
  action,
}: {
  titre: string;
  meta?: string;
  /** Une commande à droite du titre, à la place du compteur (ex. lecture unifiée). */
  action?: ReactNode;
}) {
  return (
    <View style={styles.entete}>
      <Text style={styles.enteteTitre} numberOfLines={1}>
        {titre}
      </Text>
      {action ?? (meta ? <Text style={styles.enteteMeta}>{meta}</Text> : null)}
    </View>
  );
}

/**
 * Bouton.
 *
 * Un seul bouton plein par écran : c'est la règle de la maquette, et elle tient
 * parce que le fantôme est assez présent pour les actions secondaires.
 */
export function Bouton({
  titre,
  onPress,
  variante = "primaire",
  desactive = false,
  enCours = false,
  icone,
  style,
  taille = "normale",
}: {
  titre: string;
  onPress: () => void;
  variante?: "primaire" | "fantome" | "discret" | "danger";
  desactive?: boolean;
  enCours?: boolean;
  icone?: ReactNode;
  style?: ViewStyle;
  /** `petite` : hauteur 40, pour les commandes posées dans une carte. */
  taille?: "normale" | "petite";
}) {
  const fantome = variante === "fantome" || variante === "danger";
  const fond = {
    primaire: colors.primary,
    fantome: colors.voileClair,
    discret: "transparent",
    danger: colors.voileClair,
  }[variante];
  const encre = {
    primaire: colors.onPrimary,
    fantome: colors.ink,
    discret: colors.ink2,
    danger: colors.danger,
  }[variante];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={titre}
      accessibilityState={{ disabled: desactive }}
      disabled={desactive || enCours}
      onPress={onPress}
      style={({ pressed }) => [
        styles.bouton,
        taille === "petite" && styles.boutonPetit,
        variante === "primaire" && ombre.bouton,
        fantome && styles.boutonFantome,
        { backgroundColor: fond, opacity: desactive ? 0.45 : pressed ? 0.82 : 1 },
        style,
      ]}
    >
      {enCours ? <ActivityIndicator size="small" color={encre} /> : icone}
      <Text style={[styles.boutonTexte, { color: encre }]} numberOfLines={1}>
        {titre}
      </Text>
    </Pressable>
  );
}

/**
 * Pastille d'état d'un titre.
 *
 * Cinq tons, jamais la couleur seule : l'icône et le texte disent la même chose
 * qu'elle, pour qui ne distingue pas le vert de l'orange.
 */
export function Etiquette({
  texte,
  ton,
  icone,
  accessibilityLabel,
}: {
  texte?: string;
  ton: "done" | "part" | "live" | "miss" | "fail";
  icone?: ReactNode;
  /** Quand la pastille est une icône seule, c'est elle qui parle. */
  accessibilityLabel?: string;
}) {
  const teinte = {
    done: { couleur: colors.ok, fond: "rgba(46,217,168,0.12)" },
    part: { couleur: colors.warn, fond: "rgba(255,176,32,0.13)" },
    live: { couleur: colors.accent, fond: "rgba(0,217,255,0.12)" },
    // La maquette écrit ce ton en `ink3` sur un fond clair : 3,1:1, sous le
    // seuil AA pour du 11 px. On garde le fond, on remonte l'encre.
    miss: { couleur: colors.ink2, fond: "rgba(255,255,255,0.07)" },
    fail: { couleur: colors.danger, fond: "rgba(255,107,107,0.13)" },
  }[ton];
  return (
    <View
      style={[styles.etiquette, { backgroundColor: teinte.fond }]}
      accessible={Boolean(accessibilityLabel)}
      accessibilityLabel={accessibilityLabel}
    >
      {icone}
      {texte ? (
        <Text style={[styles.etiquetteTexte, { color: teinte.couleur }]} numberOfLines={1}>
          {texte}
        </Text>
      ) : null}
    </View>
  );
}

/** L'icône de synchro qui tourne pendant un téléchargement, comme le Spinner. */
function SynchroTournante({ taille }: { taille: number }) {
  const [tours] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const boucle = Animated.loop(
      Animated.timing(tours, {
        toValue: 1,
        duration: 900,
        easing: Easing.linear,
        useNativeDriver: false,
      }),
    );
    boucle.start();
    return () => boucle.stop();
  }, [tours]);
  const rotation = tours.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });
  return (
    <Animated.View style={{ transform: [{ rotate: rotation }] }}>
      <IconSync size={taille} color={colors.accent} />
    </Animated.View>
  );
}

/** La marque d'état d'un titre, telle que la bibliothèque l'affiche. */
export function MarqueEtat({
  etat,
  compact = false,
  enCours = false,
}: {
  etat: "chez_toi" | "partiel" | "absent";
  compact?: boolean;
  enCours?: boolean;
}) {
  const taille = compact ? 15 : 17;
  const chezToi = etat === "chez_toi";
  // Une seule icône dit tout : verte dès que le titre est sur le téléphone,
  // grise tant qu'il n'y est pas. Pendant le téléchargement elle tourne en
  // accent (cyan) — la couleur de l'activité en cours, comme le Spinner.
  // Le détail (« téléchargement en cours », « transfert interrompu », …) vit
  // dans la sous-ligne de la ligne.
  const libelle = enCours
    ? "Téléchargement en cours"
    : chezToi
      ? "Chez toi"
      : etat === "partiel"
        ? "Transfert incomplet"
        : "À transférer";
  return (
    <View accessible accessibilityLabel={libelle} style={styles.marqueEtat}>
      {enCours ? (
        <SynchroTournante taille={taille} />
      ) : (
        <IconSync size={taille} color={chezToi ? colors.ok : colors.ink3} />
      )}
    </View>
  );
}

/** Bandeau d'information ou d'alerte, au-dessus du contenu qu'il concerne. */
export function Bandeau({
  texte,
  ton = "info",
  icone,
}: {
  texte: string;
  ton?: "info" | "attention" | "bad";
  icone?: ReactNode;
}) {
  const teinte = {
    info: { fond: "rgba(0,217,255,0.09)", bord: "rgba(0,217,255,0.24)", encre: "#cdefff" },
    attention: { fond: "rgba(255,176,32,0.10)", bord: "rgba(255,176,32,0.28)", encre: colors.ink },
    bad: { fond: "rgba(255,107,107,0.10)", bord: "rgba(255,107,107,0.28)", encre: "#ffd9d9" },
  }[ton];
  return (
    <View
      style={[styles.bandeau, { backgroundColor: teinte.fond, borderColor: teinte.bord }]}
      accessibilityRole={ton === "info" ? "none" : "alert"}
    >
      {icone ?? (ton === "info" ? null : <IconAlert size={16} color={teinte.encre} />)}
      <Text style={[styles.bandeauTexte, { color: teinte.encre }]}>{texte}</Text>
    </View>
  );
}

/** Ancien nom du bandeau d'avertissement, conservé pour les écrans existants. */
export function Avertissement({ texte }: { texte: string }) {
  return <Bandeau texte={texte} ton="attention" />;
}

/**
 * Rail de progression seekable.
 *
 * L'appelant donne la fraction ; un point marque la position courante. Quand un
 * callback est fourni, la barre glisse avec le doigt : le remplissage et le
 * point suivent la main, et `surRelâchement` reçoit la position finale au
 * relâchement — c'est là qu'a lieu le saut, pas à chaque pixel (le lecteur
 * n'a pas à encaisser des seeks en rafale).
 */
export function BarreDeProgression({
  fraction,
  actif = true,
  hauteur = 6,
  travail = false,
  libelle,
  surDéplacement,
  surRelâchement,
}: {
  fraction: number;
  actif?: boolean;
  hauteur?: number;
  travail?: boolean;
  libelle?: string;
  /** Glissement continu : position du doigt (0–1), pour l'aperçu du temps. */
  surDéplacement?: (fraction: number) => void;
  /** Relâchement : la position à chercher (0–1). */
  surRelâchement?: (fraction: number) => void;
}) {
  const anime = useApp((etat) => etat.animations);
  const borne = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  // Fraction tenue par le doigt, puis en attente de confirmation du seek.
  // Sans elle, le curseur rebondirait sur l'ancienne position le temps que la
  // lecture rejoigne la cible. `null` = on suit la position réelle.
  const [cible, setCible] = useState<number | null>(null);
  // La lecture a rejoint la cible : on relâche la main. Ajustement d'état
  // pendant le rendu (pattern React pour dériver un état d'un autre) plutôt
  // qu'un effet : le seuil absorbe la différence entre la fraction visée et
  // celle réellement atteinte par le seek.
  if (cible != null && Math.abs(borne - cible) <= 0.01) {
    setCible(null);
  }
  const [avancement] = useState(() => new Animated.Value(0));
  const affichee = cible ?? borne;

  useEffect(() => {
    if (!travail || !anime) return;
    const boucle = Animated.loop(
      Animated.timing(avancement, {
        toValue: 1,
        duration: 1500,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    boucle.start();
    return () => boucle.stop();
  }, [travail, anime, avancement]);

  // Filet de sécurité : si le seek échoue (fichier illisible, lecture refusée),
  // la cible ne doit pas rester tenue indéfiniment.
  useEffect(() => {
    if (cible == null) return;
    const id = setTimeout(() => setCible(null), 2500);
    return () => clearTimeout(id);
  }, [cible]);

  // Mesure et callbacks en refs, jamais lus ni écrits pendant le rendu (règle
  // react-hooks/refs) : ils ne servent que depuis les gestionnaires du
  // responder ci-dessous. Le rail porte lui-même les attributs onResponder* :
  // garder un objet PanResponder reconstruit selon les props ferait perdre un
  // geste en cours — ici le responder vit aussi longtemps que la View.
  const largeurRef = useRef(1);
  const appuisRef = useRef({ surDéplacement, surRelâchement });
  // Départ du doigt (pageX) et sa position dans le rail (locationX) : le
  // glissement reste collé au doigt même si un re-rendu survient entre deux
  // événements, et l'ancrage en pageX ignore tout redimensionnement du rail.
  const departRef = useRef({ pageX: 0, origine: 0 });
  useEffect(() => {
    appuisRef.current = { surDéplacement, surRelâchement };
  });

  const fractionDepuisPageX = (pageX: number) => {
    const largeur = largeurRef.current;
    if (largeur <= 0) return 0;
    const x = pageX - departRef.current.pageX + departRef.current.origine;
    return Math.max(0, Math.min(1, x / largeur));
  };
  const poser = (deplacement: ((fraction: number) => void) | undefined, pageX: number) => {
    const nouvelleFraction = fractionDepuisPageX(pageX);
    setCible(nouvelleFraction);
    deplacement?.(nouvelleFraction);
  };
  const relacher = (pageX: number) => {
    poser(appuisRef.current.surRelâchement, pageX);
  };

  // Une barre sans destinataire est une mesure, pas une commande : la jauge de
  // téléchargement n'est pas tirable.
  const interactif = Boolean(surDéplacement || surRelâchement);
  const interactions = interactif
    ? {
        // La barre prend toute touche qui démarre chez elle et ne lâche plus
        // la main : sinon le ScrollView du lecteur la vole dès la moindre
        // dérive verticale, et le relâchement (le seek) n'arrive jamais ici.
        // Elle ne pique en revanche jamais un scroll commencé ailleurs.
        onStartShouldSetResponder: () => true,
        onMoveShouldSetResponder: () => false,
        onResponderTerminationRequest: () => false,
        onResponderGrant: (e: GestureResponderEvent) => {
          departRef.current = {
            pageX: e.nativeEvent.pageX,
            origine: e.nativeEvent.locationX,
          };
          poser(appuisRef.current.surDéplacement, e.nativeEvent.pageX);
        },
        onResponderMove: (e: GestureResponderEvent) => {
          poser(appuisRef.current.surDéplacement, e.nativeEvent.pageX);
        },
        onResponderRelease: (e: GestureResponderEvent) => relacher(e.nativeEvent.pageX),
        // Si le système force la main malgré le refus, on cherche quand même :
        // un seek recommencé vaut mieux qu'un relâchement perdu.
        onResponderTerminate: (e: GestureResponderEvent) => relacher(e.nativeEvent.pageX),
      }
    : {};

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={libelle}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(affichee * 100) }}
      style={[styles.rail, { height: hauteur }]}
      // Mesure en ref, pas en state : une re-mesure en cours de glissement ne
      // doit ni re-rendre, ni déstabiliser un geste en cours.
      onLayout={(e) => {
        largeurRef.current = Math.max(1, e.nativeEvent.layout.width);
      }}
      {...interactions}
    >
      <View style={styles.piste}>
        <View
          style={[
            styles.remplissage,
            {
              width: `${affichee * 100}%`,
              backgroundColor: travail
                ? colors.accent
                : actif
                  ? colors.accent
                  : colors.ink3,
            },
          ]}
        >
          {travail && anime ? (
            <Animated.View
              style={[
                styles.balayage,
                {
                  transform: [
                    {
                      translateX: avancement.interpolate({
                        inputRange: [0, 1],
                        outputRange: [-140, 260],
                      }),
                    },
                  ],
                },
              ]}
            />
          ) : null}
        </View>
      </View>
      <View
        style={[
          styles.pointProgression,
          {
            left: `${affichee * 100}%`,
            width: hauteur + 10,
            height: hauteur + 10,
            marginLeft: -(hauteur + 10) / 2,
            top: hauteur / 2 - (hauteur + 10) / 2,
            borderRadius: (hauteur + 10) / 2,
          },
        ]}
      />
    </View>
  );
}

/**
 * Spinner d'attente, animé côté JS.
 *
 * L'ActivityIndicator natif ne tourne pas quand le système désactive ses
 * animations (échelle d'animation à 0 — courant sur émulateurs et sur les
 * iPhones « réduire les animations ») : il reste figé en cercle statique, et un
 * cercle immobile ne dit plus « ça travaille ». On anime donc la rotation en
 * JS (`useNativeDriver: false`), ininterrompue par ce réglage : le regard doit
 * toujours voir l'effort de la préparation/du transfert.
 */
export function Spinner({
  taille = 16,
  couleur = colors.accent,
}: {
  taille?: number;
  couleur?: string;
}) {
  const [tours] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const boucle = Animated.loop(
      Animated.timing(tours, {
        toValue: 1,
        duration: 900,
        easing: Easing.linear,
        useNativeDriver: false,
      }),
    );
    boucle.start();
    return () => boucle.stop();
  }, [tours]);
  const rotation = tours.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });
  const epaisseur = Math.max(2, Math.round(taille / 6));
  return (
    <Animated.View
      accessibilityRole="progressbar"
      style={{
        width: taille,
        height: taille,
        transform: [{ rotate: rotation }],
      }}
    >
      <View
        style={{
          width: taille,
          height: taille,
          borderRadius: taille / 2,
          borderWidth: epaisseur,
          borderColor: couleur,
          borderTopColor: "transparent",
        }}
      />
    </Animated.View>
  );
}

/**
 * Bande de possession : combien de musique, combien de place.
 *
 * La jauge dit la part de la bibliothèque déjà sur le téléphone — un chiffre qui
 * veut dire quelque chose, plutôt qu'une barre décorative.
 */
export function Suivi({
  valeur,
  legende,
  fraction,
  style,
}: {
  valeur: string;
  legende: string;
  fraction: number;
  style?: ViewStyle;
}) {
  const borne = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  return (
    <View style={[styles.suivi, style]}>
      <View style={styles.suiviTextes}>
        <Text style={styles.suiviValeur}>{valeur}</Text>
        <Text style={styles.suiviLegende} numberOfLines={1}>
          {legende}
        </Text>
      </View>
      <View style={styles.suiviJauge} accessible={false}>
        <View style={[styles.suiviJaugePart, { width: `${borne * 100}%` }]} />
      </View>
    </View>
  );
}

/** Écran vide : il enseigne le parcours, il ne s'excuse pas. */
export function EcranVide({
  titre,
  explication,
  etapes,
  action,
}: {
  titre: string;
  explication: string;
  etapes?: string[];
  action?: ReactNode;
}) {
  return (
    <View style={styles.vide}>
      <LinearGradient
        colors={degrade.marque}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.videMarque}
      >
        <IconCodeQr size={30} color="#04121f" />
      </LinearGradient>
      <Text style={styles.videTitre}>{titre}</Text>
      <Text style={styles.videTexte}>{explication}</Text>
      {etapes ? (
        <View style={styles.etapes}>
          {etapes.map((etape, rang) => (
            <View key={etape} style={styles.etape}>
              <View style={styles.etapeNumero}>
                <Text style={styles.etapeNumeroTexte}>{rang + 1}</Text>
              </View>
              <Text style={styles.etapeTexte}>{etape}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {action}
    </View>
  );
}

/**
 * Feuille montante.
 *
 * La poignée et les coins hauts arrondis disent d'où elle vient : on la fait
 * partir vers le bas, comme tout ce qui monte du bas de l'écran.
 */
export function Feuille({
  visible,
  onFermer,
  titre,
  sousTitre,
  action,
  children,
}: {
  visible: boolean;
  onFermer: () => void;
  titre: string;
  sousTitre?: string;
  /** Une commande d'en-tête, à droite du titre (ex. un sélecteur de mode). */
  action?: ReactNode;
  children: ReactNode;
}) {
  // La feuille est ancrée en bas : sans l'inset, son contenu passe sous la
  // barre de gestes sur les appareils en navigation gestuelle (edge-to-edge).
  // Le garde Math.max conserve un coussin minimal si l'inset est nul.
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onFermer}
      // `statusBarTranslucent` seul. Ajouter `navigationBarTranslucent` ferait
      // passer la fenêtre sous les barres système (edge-to-edge) et, du même
      // coup, le clavier ne rétrécirait plus la fenêtre du dialogue — c'est
      // pourtant ce rétrécissement qui fait remonter la feuille quand un champ
      // prend le focus. La barre sombre, elle, vient du thème natif
      // (styles.xml), qui n'a pas besoin d'edge-to-edge.
      statusBarTranslucent
    >
      {/* Clavier : la feuille doit remonter au-dessus de lui, sinon le champ
          qui a le focus passe dessous (règle RN : KeyboardAvoidingView).

          iOS  → `padding` : le clavier flotte par-dessus, on réserve sa place.
          ANDROID → RIEN (`behavior={undefined}`). La fenêtre de la modale est
          déjà en ADJUST_RESIZE (posé par React Native) : le clavier réduit
          directement la fenêtre, et la feuille, ancrée en bas, remonte toute
          seule. Un `behavior="height"` s'y SUPERPOSE, et comme il écrit la
          hauteur du layout à chaque événement clavier pendant que l'animation
          `slide` du Modal joue, les deux se marchent dessus : la feuille
          tremble, le texte saute, et l'ouverture paraît saccadée. Ne rien faire
          est ici plus rapide et plus net que de lutter contre le clavier.

          `animationType="none"` + une `Animated` maison serait l'autre option,
          mais elle coûte une valeur animée et un état de plus par feuille, pour
          un résultat que le redimensionnement natif donne déjà. */}
      <KeyboardAvoidingView
        style={styles.feuillePorte}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
      >
        <Pressable style={styles.scrim} onPress={onFermer} accessibilityLabel="Fermer" />
        <View style={[styles.feuille, { paddingBottom: Math.max(20, insets.bottom) }]}>
          <View style={styles.poignee} />
          <View style={styles.feuilleTete}>
            <View style={styles.feuilleTextes}>
              <Text style={styles.feuilleTitre}>{titre}</Text>
              {sousTitre ? <Text style={styles.feuilleSousTitre}>{sousTitre}</Text> : null}
            </View>
            {action}
          </View>
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** Une ligne « libellé / valeur » : ce qui coûte, ce qui reste. */
export function Ligne({
  gauche,
  droite,
  style,
}: {
  gauche: string;
  droite?: string;
  style?: ViewStyle;
}) {
  return (
    <View style={[styles.ligne, style]}>
      <Text style={styles.ligneGauche}>{gauche}</Text>
      {droite ? <Text style={styles.ligneDroite}>{droite}</Text> : null}
    </View>
  );
}

/** Le titre d'un groupe de réglages, en petites capitales. */
export function TitreSection({ texte, style }: { texte: string; style?: TextStyle }) {
  return <Text style={[styles.titreSection, style]}>{texte}</Text>;
}

/** Séparateur hairline, entre deux lignes d'une même liste. */
export function Separateur({ style }: { style?: ViewStyle }) {
  return <View style={[styles.separateur, style]} />;
}

/** Une valeur mesurée, mise en avant. */
export function Valeur({ texte, style }: { texte: string; style?: TextStyle }) {
  return <Text style={[styles.valeur, style]}>{texte}</Text>;
}

export { COURBE };

const styles = StyleSheet.create({
  // --- En-tête d'écran ---
  entete: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.md,
    paddingHorizontal: 18,
    paddingTop: space.md,
    paddingBottom: 14,
  },
  enteteTitre: { ...typo.ecran, color: colors.ink, flexShrink: 1 },
  enteteMeta: { ...typo.caption, color: colors.ink2, ...tabular },

  // --- Bouton ---
  bouton: {
    minHeight: touch.min,
    paddingHorizontal: 22,
    borderRadius: radius.pill,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
  },
  boutonPetit: { minHeight: 40, paddingHorizontal: space.lg },
  boutonFantome: { borderWidth: 1, borderColor: colors.borderFort },
  boutonTexte: { ...typo.body, fontWeight: "600" },

  // --- Pastille d'état ---
  etiquette: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderRadius: radius.pill,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  etiquetteTexte: { fontSize: 11, lineHeight: 15, fontWeight: "600", ...tabular },

  // --- Marque d'état d'un titre (icône seule, bicolore) ---
  marqueEtat: {
    alignItems: "center",
    justifyContent: "center",
  },

  // --- Bandeau ---
  bandeau: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingVertical: 11,
    paddingHorizontal: 13,
  },
  bandeauTexte: { fontSize: 12.5, lineHeight: 18, flex: 1 },

  // --- Rail de progression ---
  // Le rail porte la mesure (onLayout) et laisse déborder le point ; la piste
  // intérieure est seule à rogner le remplissage.
  rail: {
    position: "relative",
    width: "100%",
  },
  piste: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: "rgba(255,255,255,0.12)",
    borderRadius: radius.pill,
    overflow: "hidden",
  },
  remplissage: { height: "100%", borderRadius: radius.pill },
  balayage: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 120,
    backgroundColor: "#b8f4ff",
    opacity: 0.65,
    borderRadius: radius.pill,
  },

  // --- Bande de possession ---
  suivi: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: "rgba(0,217,255,0.22)",
    paddingVertical: 11,
    paddingHorizontal: 13,
  },
  suiviTextes: { flex: 1, gap: 1 },
  suiviValeur: { ...typo.valeur, color: colors.ink, ...tabular },
  suiviLegende: { ...typo.caption, color: colors.ink2, ...tabular },
  suiviJauge: {
    width: 54,
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: "rgba(255,255,255,0.12)",
    overflow: "hidden",
  },
  suiviJaugePart: { height: "100%", backgroundColor: colors.accent, borderRadius: radius.pill },

  // --- Écran vide ---
  vide: {
    alignItems: "center",
    gap: 18,
    paddingHorizontal: space.xl,
    paddingVertical: space.xxl,
  },
  videMarque: {
    width: 62,
    height: 62,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
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
  etapes: { gap: 9, alignSelf: "stretch", maxWidth: 320 },
  etape: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  etapeNumero: {
    width: 20,
    height: 20,
    borderRadius: radius.pill,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  etapeNumeroTexte: { fontSize: 11, lineHeight: 14, fontWeight: "700", color: colors.ink },
  etapeTexte: { fontSize: 13, lineHeight: 18, fontWeight: "500", color: colors.ink2, flex: 1 },

  // --- Feuille ---
  // Le voile assombrit ce que la feuille recouvre : sans lui, une page web
  // claire devient le fond de la modale. Le Pressable du même style reste :
  // c'est lui qui referme la feuille au tap à côté.
  scrim: { flex: 1, backgroundColor: colors.voileModale },
  feuillePorte: { flex: 1 },
  feuille: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: colors.borderModale,
    padding: space.lg,
    paddingBottom: 20,
    gap: space.md,
  },
  poignee: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.borderFort,
  },
  feuilleTitre: { ...typo.feuille, color: colors.ink },
  feuilleSousTitre: { ...typo.label, color: colors.ink2, fontWeight: "500" },
  feuilleTete: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
  },
  feuilleTextes: { gap: space.xs, alignItems: "flex-start" },

  // --- Ligne libellé/valeur ---
  ligne: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.md,
  },
  ligneGauche: { fontSize: 13.5, lineHeight: 19, fontWeight: "500", color: colors.ink2, flexShrink: 1 },
  ligneDroite: { fontSize: 13.5, lineHeight: 19, fontWeight: "600", color: colors.ink, ...tabular },

  // --- Divers ---
  titreSection: { ...typo.section, color: colors.ink2 },
  separateur: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  valeur: { ...typo.valeur, color: colors.ink, ...tabular },

  // --- Point de position sur la barre de progression ---
  pointProgression: {
    position: "absolute",
    top: 0,
    backgroundColor: colors.onPrimary,
    borderWidth: 2,
    borderColor: colors.primary,
    shadowColor: colors.onPrimary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.45,
    shadowRadius: 3,
    elevation: 3,
  },
});
