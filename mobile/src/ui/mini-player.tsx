/**
 * Mini-lecteur : ce qui joue, toujours à portée, jamais au premier plan.
 *
 * Il se pose **juste au-dessus** de la capsule de navigation : les deux hauteurs
 * sont calculées ensemble dans `ui/barre.ts`, parce que la carte collait à la
 * barre et que le bouton de scan finissait caché derrière elle.
 *
 * Son entrée et sa sortie sont animées. Quand le titre courant disparaît (file
 * vidée, lecture arrêtée), la carte glisse vers le bas en emportant le titre au
 * lieu de s'évaporer : une barre qui disparaît d'un coup oblige l'œil à
 * retrouver ses repères, alors qu'une barre qui descend dit où elle est allée.
 * Pendant la sortie elle ne capte plus les touchers — une surface qui part ne
 * doit pas rester cliquable.
 */
import { useEffect, useMemo } from "react";
import {
  Animated,
  Dimensions,
  Easing,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as lecteur from "@/playback/lecteur";
import { useLecture } from "@/playback/store";
import { useApp } from "@/state/app";
import { basDuMiniLecteur, basDuMiniLecteurSeul, HAUTEUR_MINI } from "@/ui/barre";
import { IconPause, IconPlay } from "@/ui/icons";
import { Vignette } from "@/ui/vignette";
import { colors, ease, ombre, radius, space } from "@/theme/tokens";

const COURBE = Easing.bezier(ease[0], ease[1], ease[2], ease[3]);
const DUREE = 220;
/** Part de la largeur à franchir pour que le balayage emporte la carte. */
const SEUIL_SORTIE = 1 / 3;

export function MiniLecteur({
  onOuvrir,
  auDessusDeLaBarre = true,
}: {
  onOuvrir: () => void;
  /**
   * Vrai quand la capsule d'onglets est sous le mini-lecteur (les écrans à
   * onglets). Faux dans un écran sans barre, comme la vue d'une playlist : il se
   * pose alors simplement au-dessus de la zone de geste.
   */
  auDessusDeLaBarre?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const anime = useApp((etat) => etat.animations);
  const piste = useLecture((etat) => etat.file[etat.index] ?? null);
  const derniere = useLecture((etat) => etat.derniere);
  const lecture = useLecture((etat) => etat.lecture);
  const position = useLecture((etat) => etat.position);
  const duree = useLecture((etat) => etat.duree);

  // 1 : posée au-dessus de la barre. 0 : sortie, hors de l'écran. La valeur est
  // créée une fois ; c'est l'effet ci-dessous qui la fait bouger.
  const [avancement] = useMemo(() => [new Animated.Value(0)], []);
  const visible = piste !== null;
  const titre = piste ?? derniere;

  /**
   * Balayage horizontal : la carte suit le doigt, et part avec la lecture.
   *
   * Horizontal parce que l'entrée et la sortie de la carte sont verticales :
   * deux gestes opposés ne se disputent pas la même direction. Passé un tiers de
   * l'écran, la carte achève sa course du côté du geste puis s'arrête là — c'est
   * la file vidée qui la fait redescendre, par l'animation de sortie habituelle.
   */
  const [glissement, balayage] = useMemo(() => {
    const valeur = new Animated.Value(0);
    const pan = PanResponder.create({
      onMoveShouldSetPanResponder: (_evenement, geste) =>
        Math.abs(geste.dx) > 10 && Math.abs(geste.dx) > Math.abs(geste.dy),
      onPanResponderMove: (_evenement, geste) => valeur.setValue(geste.dx),
      onPanResponderRelease: (_evenement, geste) => {
        const largeur = Dimensions.get("window").width;
        if (Math.abs(geste.dx) < largeur * SEUIL_SORTIE) {
          if (!anime) {
            valeur.setValue(0);
            return;
          }
          Animated.spring(valeur, {
            toValue: 0,
            useNativeDriver: true,
            bounciness: 0,
          }).start();
          return;
        }
        if (!anime) {
          // Sans animation, la carte s'efface d'un coup : la recentrer n'a
          // aucun effet visible.
          valeur.setValue(0);
          lecteur.arreter();
          return;
        }
        Animated.timing(valeur, {
          toValue: Math.sign(geste.dx) * largeur,
          duration: 180,
          easing: COURBE,
          useNativeDriver: true,
        }).start(({ finished }) => {
          // La carte est hors de l'écran : on arrête la lecture. La remise à
          // zéro du décalage attend la fin de la sortie (voir l'effet plus
          // bas) — la faire ici ramènerait la carte au centre juste avant sa
          // descente, ce qui se voit comme une réapparition parasite.
          if (finished) lecteur.arreter();
        });
      },
    });
    return [valeur, pan];
  }, [anime]);

  useEffect(() => {
    if (!anime) {
      avancement.setValue(visible ? 1 : 0);
      glissement.setValue(0);
      return;
    }
    Animated.timing(avancement, {
      toValue: visible ? 1 : 0,
      duration: DUREE,
      easing: COURBE,
      useNativeDriver: true,
    }).start(({ finished }) => {
      // Sortie terminée : la carte est hors de l'écran (sous la barre), c'est le
      // seul moment où remettre le balayage à zéro ne se voit pas. La prochaine
      // lecture rentre ainsi du bas, centrée.
      if (finished && !visible) glissement.setValue(0);
    });
  }, [visible, avancement, glissement, anime]);

  // Rien n'a encore été joué : il n'y a pas de carte à faire sortir.
  if (!titre) return null;

  const bas = auDessusDeLaBarre
    ? basDuMiniLecteur(insets.bottom)
    : basDuMiniLecteurSeul(insets.bottom);
  const fraction = duree > 0 ? Math.min(1, position / duree) : 0;

  return (
    <Animated.View
      {...balayage.panHandlers}
      style={[
        styles.porte,
        {
          bottom: bas,
          opacity: avancement,
          transform: [
            { translateX: glissement },
            {
              translateY: avancement.interpolate({
                inputRange: [0, 1],
                outputRange: [HAUTEUR_MINI + bas, 0],
              }),
            },
          ],
        },
      ]}
      pointerEvents={visible ? "auto" : "none"}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? "auto" : "no-hide-descendants"}
    >
      <View style={styles.carte}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Ouvrir le lecteur, ${titre.titre}`}
          onPress={onOuvrir}
          style={({ pressed }) => [styles.zone, pressed && styles.zonePressee]}
        >
          <Vignette pochette={titre.pochette} titre={titre.titre} />
          <View style={styles.textes}>
            <Text style={styles.titre} numberOfLines={1}>
              {titre.titre}
            </Text>
            <Text style={styles.chaine} numberOfLines={1}>
              {titre.chaine}
            </Text>
            <View style={styles.rail} accessible={false}>
              <View style={[styles.railPart, { width: `${fraction * 100}%` }]} />
            </View>
          </View>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={lecture ? "Mettre en pause" : "Reprendre la lecture"}
          onPress={() => void lecteur.basculer()}
          style={({ pressed }) => [styles.commande, ombre.bouton, pressed && styles.commandePressee]}
        >
          {lecture ? (
            <IconPause size={17} color={colors.onPrimary} rempli />
          ) : (
            <IconPlay size={17} color={colors.onPrimary} rempli />
          )}
        </Pressable>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  porte: {
    position: "absolute",
    left: 0,
    right: 0,
    paddingHorizontal: space.md,
  },
  carte: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface2,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderFort,
    paddingVertical: 9,
    paddingHorizontal: space.md,
    gap: 11,
  },
  zone: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    borderRadius: radius.sm,
  },
  zonePressee: { opacity: 0.85 },
  textes: { flex: 1 },
  titre: { fontSize: 13, lineHeight: 17, fontWeight: "600", color: colors.ink },
  chaine: { fontSize: 11, lineHeight: 15, fontWeight: "500", color: colors.ink2 },
  rail: {
    height: 3,
    borderRadius: radius.pill,
    backgroundColor: "rgba(255,255,255,0.14)",
    marginTop: 7,
    overflow: "hidden",
  },
  railPart: { height: "100%", backgroundColor: colors.accent, borderRadius: radius.pill },
  commande: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  commandePressee: { opacity: 0.85 },
});
