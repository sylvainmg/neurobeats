/**
 * Égaliseur : quatre barres qui battent.
 *
 * C'est le seul ornement de l'app, et il informe : posé sur le bouton de
 * lecture, il dit « ça joue », là où une icône de pause dirait seulement
 * « appuie ici ». Réglage « Animations » coupé, ou réduction demandée par le
 * système : les barres restent dressées, immobiles.
 */
import { useEffect, useState } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";

import { useApp } from "@/state/app";
import { colors } from "@/theme/tokens";

/** Durées et retards de la maquette : quatre barres, jamais en phase. */
const BARRES = [
  { duree: 1000, retard: 0 },
  { duree: 1180, retard: 170 },
  { duree: 860, retard: 80 },
  { duree: 1080, retard: 260 },
];

export function Egaliseur({ couleur = colors.onPrimary }: { couleur?: string }) {
  const anime = useApp((etat) => etat.animations);
  // Les valeurs sont créées une fois et vivent hors du rendu : une ref ne peut
  // pas se lire ici, et un état initialisé paresseusement le fait sans dériver.
  const [valeurs] = useState(() => BARRES.map(() => new Animated.Value(0)));

  useEffect(() => {
    if (!anime) return;
    const boucles = valeurs.map((valeur, rang) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(BARRES[rang].retard),
          Animated.timing(valeur, {
            toValue: 1,
            duration: BARRES[rang].duree / 2,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(valeur, {
            toValue: 0,
            duration: BARRES[rang].duree / 2,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
        ]),
      ),
    );
    for (const boucle of boucles) boucle.start();
    return () => {
      for (const boucle of boucles) boucle.stop();
    };
  }, [anime, valeurs]);

  return (
    <View style={styles.porte} accessible={false}>
      {valeurs.map((valeur, rang) => (
        <Animated.View
          key={rang}
          style={[
            styles.barre,
            { backgroundColor: couleur },
            anime
              ? {
                  transform: [
                    {
                      scaleY: valeur.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0.34, 1],
                      }),
                    },
                  ],
                }
              : styles.barreFigee,
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  porte: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 2,
    height: 13,
  },
  barre: { width: 3, height: "100%", borderRadius: 2, transformOrigin: "bottom" },
  barreFigee: { transform: [{ scaleY: 0.7 }] },
});
