/**
 * Une ligne de playlist : ce qu'elle contient, et ce qu'il reste à faire.
 *
 * La bibliothèque ne montre plus les titres ; c'est donc cette ligne qui porte
 * la mesure — combien de titres, quel poids, complète ou non — et la pastille
 * d'état qui dit « c'est prêt » ou « il manque quelque chose ».
 */
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";

import { IconCheck, IconCloudDown, IconSync } from "@/ui/icons";
import { Etiquette } from "@/ui/kit";
import { Vignette } from "@/ui/vignette";
import { colors, radius, space, tabular, touch, type as typo } from "@/theme/tokens";

/**
 * Marge verticale de la rangée, en points.
 *
 * Assez pour que la pochette ne touche pas la ligne voisine, assez peu pour que
 * la rangée tienne dans la cible tactile sans devenir une suite de blocs.
 */
const MARGE = 5;

/**
 * Pochette d'une playlist : 56 pt, au-delà des 48 pt de la cible tactile.
 *
 * Le format « tactile » ne dit pas que la pochette doit être petite : il dit que
 * la ZONE APPUYABLE doit faire 48dp. La pochette est le repère visuel de la
 * rangée — c'est elle qu'on cherche du doigt, pas un nom dans du gris — donc elle
 * occupe la hauteur utile en débordant franchement du minimum, et c'est la
 * rangée qui s'agrandit avec elle (le `minHeight` ci-dessous ne borne plus rien).
 */
const TAILLE_POCHETTE = 56;

export function LignePlaylist({
  nom,
  pochette,
  resume,
  complete,
  manquants,
  onPress,
  onLongPress,
  enSelection = false,
  selectionne = false,
  avancee,
}: {
  nom: string;
  /** Couverture : la vignette du premier titre de la playlist, comme sur le web. */
  pochette: string | null;
  resume: string;
  complete: boolean;
  manquants: number;
  onPress: () => void;
  onLongPress?: () => void;
  /** Mode sélection : la ligne coche, le tap bascule, l'ouverture attend. */
  enSelection?: boolean;
  selectionne?: boolean;
  /** Progression de l'entrée en sélection (0–1) : la coche se pose, pas à peine. */
  avancee?: Animated.Value;
}) {
  return (
    <Pressable
      accessibilityRole={enSelection ? "checkbox" : "button"}
      accessibilityLabel={`${nom}, ${resume}`}
      accessibilityState={enSelection ? { checked: selectionne } : undefined}
      accessibilityHint={
        enSelection
          ? selectionne
            ? "Sélectionné, touchez pour désélectionner"
            : "Non sélectionné, touchez pour sélectionner"
          : "Ouvre la playlist"
      }
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      style={({ pressed }) => [
        styles.ligne,
        selectionne && styles.ligneSelectionnee,
        pressed && styles.pressee,
      ]}
    >
      {/* La pochette remplit la hauteur utile de la rangée : 48 pt de cible
          tactile moins les 5 pt de marge haute et basse. C'est le format
          « tactile » — une cible d'appui confortable, pas une pochette de
          couverture. Le défaut de `Vignette` (46) n'est pas repris tel quel,
          il ferait déborder la rangée de ses marges. */}
      <Vignette pochette={pochette} titre={nom} taille={TAILLE_POCHETTE} />
      <View style={styles.centre}>
        <Text style={styles.titre} numberOfLines={1} ellipsizeMode="tail">
          {nom}
        </Text>
        <Text style={styles.detail} numberOfLines={1}>
          {resume}
        </Text>
      </View>
      {enSelection ? (
        // La coche remplace l'état : en sélection, ce qui compte ce n'est plus
        // la synchronisation, c'est le choix. Elle apparaît en fondu avec
        // l'entrée en sélection, au lieu de surgir d'un coup.
        <Animated.View
          style={[
            styles.coche,
            selectionne && styles.cocheSelectionnee,
            avancee
              ? {
                  opacity: avancee,
                  transform: [
                    { scale: avancee.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }) },
                  ],
                }
              : null,
          ]}
          accessible={false}
        >
          {selectionne ? <IconCheck size={14} color={colors.onPrimary} /> : null}
        </Animated.View>
      ) : complete ? (
        <Etiquette
          ton="done"
          icone={<IconSync size={13} color={colors.ok} />}
          accessibilityLabel="Playlist synchronisée"
        />
      ) : (
        <Etiquette
          ton="miss"
          texte={manquants > 9 ? "9+" : String(manquants)}
          icone={<IconCloudDown size={13} color={colors.ink2} />}
        />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  ligne: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    /**
     * La marge suit la pochette : 56 + 2 × 5 = 66 pt de rangée. Elle déborde
     * donc volontairement des 48 pt de la cible tactile — c'est la pochette qui
     * commande, et le doigt n'a rien à perdre : la zone appuyable ne fait que
     * grossir.
     */
    paddingVertical: MARGE,
    paddingHorizontal: 18,
    /**
     * 48 pt reste le PLANCHER — la cible tactile Android (`.opencode/skills/
     * ui-ux-pro-max`, « Touch Target Size » : 48dp sur Android, 44pt sur iOS,
     * le même token `touch.min` que le reste de l'application). En pratique
     * c'est la pochette (56 pt) qui l'emporte, et la rangée suit.
     */
    minHeight: touch.min,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  ligneSelectionnee: {
    backgroundColor: "rgba(0,217,255,0.07)",
  },
  pressee: { backgroundColor: "rgba(255,255,255,0.03)" },
  centre: { flex: 1, gap: 2 },
  titre: { ...typo.ligne, color: colors.ink },
  detail: { ...typo.caption, color: colors.ink2, ...tabular },
  coche: {
    width: 24,
    height: 24,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.ink3,
    alignItems: "center",
    justifyContent: "center",
  },
  cocheSelectionnee: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
});
