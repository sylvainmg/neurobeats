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
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";
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

  useEffect(() => {
    if (!anime) {
      avancement.setValue(visible ? 1 : 0);
      return;
    }
    Animated.timing(avancement, {
      toValue: visible ? 1 : 0,
      duration: DUREE,
      easing: COURBE,
      useNativeDriver: true,
    }).start();
  }, [visible, avancement, anime]);

  // Rien n'a encore été joué : il n'y a pas de carte à faire sortir.
  if (!titre) return null;

  const bas = auDessusDeLaBarre
    ? basDuMiniLecteur(insets.bottom)
    : basDuMiniLecteurSeul(insets.bottom);
  const fraction = duree > 0 ? Math.min(1, position / duree) : 0;

  return (
    <Animated.View
      style={[
        styles.porte,
        {
          bottom: bas,
          opacity: avancement,
          transform: [
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
