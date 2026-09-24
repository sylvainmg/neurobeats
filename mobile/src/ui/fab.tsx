/**
 * Bouton flottant : le scan, toujours à portée de pouce.
 *
 * La maquette en fait l'action principale de l'app — c'est le scan qui fait
 * exister la bibliothèque — et le sort de l'en-tête, où il fallait lever le
 * pouce.
 *
 * Il s'empile au-dessus du mini-lecteur quand un titre joue, au-dessus de la
 * capsule sinon : sans cela il passait dessous, invisible et inatteignable.
 */
import { Pressable, StyleSheet, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useLecture } from "@/playback/store";
import { basDuBoutonFlottant } from "@/ui/barre";
import { IconCodeQr } from "@/ui/icons";
import { colors, ombre, radius, type as typo } from "@/theme/tokens";

export function BoutonFlottant({
  titre,
  onPress,
}: {
  titre: string;
  onPress: () => void;
}) {
  const insets = useSafeAreaInsets();
  const mini = useLecture((etat) => etat.file.length > 0);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={titre}
      onPress={onPress}
      style={({ pressed }) => [
        styles.porte,
        ombre.fab,
        {
          bottom: basDuBoutonFlottant(insets.bottom, mini),
          transform: [{ translateY: pressed ? 1 : 0 }],
          opacity: pressed ? 0.92 : 1,
        },
      ]}
    >
      <IconCodeQr size={20} color={colors.onPrimary} />
      <Text style={styles.texte}>{titre}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  porte: {
    position: "absolute",
    right: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    minHeight: 52,
    paddingHorizontal: 19,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
  },
  texte: { ...typo.body, fontWeight: "700", color: colors.onPrimary },
});
