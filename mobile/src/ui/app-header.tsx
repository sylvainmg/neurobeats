/**
 * En-tête : la marque, puis l'action de l'écran.
 *
 * Comme sur le web, le mark est décoratif (`accessible={false}`) et le nom est
 * porté par le texte : un lecteur d'écran annonce « NeuroBeats », pas une image.
 */
import { Image } from "expo-image";
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";

import { colors, space, type as typo } from "@/theme/tokens";

export function EnTeteMarque({ action }: { action?: ReactNode }) {
  return (
    <View style={styles.porte}>
      <View style={styles.marque}>
        <Image
          source={require("@/assets/images/logo-mark.png")}
          style={styles.mark}
          contentFit="contain"
          accessible={false}
        />
        <Text style={styles.nom}>NeuroBeats</Text>
      </View>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  porte: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.md,
    gap: space.md,
  },
  marque: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  mark: {
    width: 28,
    height: 28,
  },
  nom: {
    ...typo.label,
    color: colors.ink,
    fontWeight: "700",
  },
});
