/**
 * Vignette d'un titre : la pochette si on l'a, sinon l'initiale du titre.
 *
 * La maquette ne dessine que la vignette de repli (dégradé + initiale) : elle
 * doit donc être présentable, parce qu'un titre sans pochette n'est pas une
 * erreur — et sur les 300 titres d'une bibliothèque, il y en a toujours.
 */
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { colors, degrade, radius } from "@/theme/tokens";

export function Vignette({
  pochette,
  titre,
  taille = 46,
  rayon = radius.sm,
  tailleInitiale,
}: {
  pochette: string | null;
  titre: string;
  taille?: number;
  rayon?: number;
  tailleInitiale?: number;
}) {
  const [echec, setEchec] = useState(false);
  const initiale = (titre.trim()[0] ?? "?").toUpperCase();
  const montre = Boolean(pochette) && !echec;

  return (
    <View
      style={[styles.porte, { width: taille, height: taille, borderRadius: rayon }]}
      accessible={false}
    >
      <LinearGradient
        colors={degrade.vignette}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        colors={degrade.vignetteVoile}
        locations={[0, 0.6]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {montre ? (
        <Image
          source={{ uri: pochette as string }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={120}
          accessible={false}
          onError={() => setEchec(true)}
        />
      ) : (
        <Text
          style={[styles.initiale, { fontSize: tailleInitiale ?? Math.round(taille * 0.33) }]}
          allowFontScaling={false}
        >
          {initiale}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  porte: {
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface2,
  },
  initiale: { color: colors.ink2, fontWeight: "700" },
});
