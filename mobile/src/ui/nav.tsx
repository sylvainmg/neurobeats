/**
 * Barre de navigation — la capsule de la maquette.
 *
 * Ce qui est repris tel quel, et pourquoi :
 * - **capsule flottante** laissée au-dessus de la zone de geste, en dégradé et
 *   ombre portée : elle se détache du contenu au lieu d'y coller ;
 * - **quatre destinations** : au-delà, les libellés se tronquent et la barre
 *   devient un menu ;
 * - **trois signaux pour l'onglet actif** (pastille d'accent cerclée + pictogramme
 *   en accent + libellé blanc semi-gras) : la couleur seule ne suffit pas ;
 * - cible de 56 dp, pastille 56×32, retour tactile par fond, jamais par ripple
 *   (un ripple borné dessine un carré sur une cible sans fond) ;
 * - la pastille de transfert est **aussi annoncée** au lecteur d'écran
 *   (« 8 transferts en cours ») : un point coloré seul serait muet.
 */
import { LinearGradient } from "expo-linear-gradient";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { HAUTEUR_CAPSULE } from "@/ui/barre";
import { degrade, colors, ombre, radius, space, tabular, touch } from "@/theme/tokens";
import { IconDownloads, IconLibrary, IconNavigateur, IconSettings } from "@/ui/icons";

/**
 * Ce que la barre utilise réellement du navigateur, décrit ici : expo-router
 * embarque sa propre copie de React Navigation, et importer les types du paquet
 * installé à côté revient à mélanger deux versions.
 */
type PropsNavigation = {
  state: { index: number; routes: { key: string; name: string }[] };
  navigation: {
    emit: (evenement: {
      type: "tabPress";
      target: string;
      canPreventDefault: true;
    }) => { defaultPrevented: boolean };
    navigate: (nom: string) => void;
  };
};

const ONGLETS = [
  { nom: "index", libelle: "Bibliothèque", Icone: IconLibrary },
  { nom: "navigateur", libelle: "Navigateur", Icone: IconNavigateur },
  { nom: "downloads", libelle: "Téléchargements", Icone: IconDownloads },
  { nom: "settings", libelle: "Réglages", Icone: IconSettings },
] as const;

export function BarreDeNavigation({
  state,
  navigation,
  transferts = 0,
}: PropsNavigation & { transferts?: number }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[styles.porte, { paddingBottom: Math.max(insets.bottom, space.md) }]}
      pointerEvents="box-none"
    >
      <LinearGradient
        colors={degrade.nav}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={[styles.barre, ombre.nav]}
      >
        {state.routes.map((route, index) => {
          const onglet = ONGLETS.find((o) => o.nom === route.name);
          if (!onglet) return null;
          const actif = state.index === index;
          const compte = route.name === "downloads" ? transferts : 0;
          return (
            <Pressable
              key={route.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: actif }}
              accessibilityLabel={
                compte > 0
                  ? `${onglet.libelle}, ${compte} transfert${compte > 1 ? "s" : ""} en cours`
                  : onglet.libelle
              }
              onPress={() => {
                const evenement = navigation.emit({
                  type: "tabPress",
                  target: route.key,
                  canPreventDefault: true,
                });
                if (!actif && !evenement.defaultPrevented) {
                  navigation.navigate(route.name);
                }
              }}
              style={styles.cible}
            >
              {({ pressed }) => (
                <>
                  <View style={styles.pastille}>
                    {/* Fond et anneau sont des enfants, jamais le fond ni la
                        bordure de la pastille : sur cette vue-là, React Native
                        ignore le rayon — deux onglets sur trois sortaient à
                        angles droits. Un enfant absolu, lui, le respecte. */}
                    {actif || pressed ? (
                      <View
                        pointerEvents="none"
                        style={[
                          styles.fond,
                          actif && styles.fondActif,
                          pressed && styles.fondPresse,
                        ]}
                      />
                    ) : null}
                    <onglet.Icone size={24} color={actif ? colors.accent : colors.ink2} />
                    {compte > 0 ? (
                      <View style={styles.badge}>
                        <Text style={styles.badgeTexte} allowFontScaling={false}>
                          {compte > 9 ? "9+" : compte}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                  <Text
                    style={[styles.libelle, actif && styles.libelleActif]}
                    numberOfLines={1}
                  >
                    {onglet.libelle}
                  </Text>
                </>
              )}
            </Pressable>
          );
        })}
      </LinearGradient>
    </View>
  );
}

const styles = StyleSheet.create({
  porte: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: space.md,
  },
  barre: {
    // La capsule fait HAUTEUR_CAPSULE (6 + 56 + 6) : c'est cette hauteur que le
    // mini-lecteur et le bouton flottant utilisent pour se poser au-dessus.
    minHeight: HAUTEUR_CAPSULE,
    flexDirection: "row",
    alignItems: "center",
    borderRadius: radius.nav,
    borderWidth: 1,
    borderColor: colors.borderFort,
    paddingVertical: 6,
    paddingHorizontal: space.xs,
  },
  cible: {
    flex: 1,
    minHeight: touch.navItem,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
  },
  pastille: {
    width: touch.navPill.width,
    height: touch.navPill.height,
    alignItems: "center",
    justifyContent: "center",
  },
  fond: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: touch.navPill.height / 2,
  },
  fondActif: {
    backgroundColor: "rgba(0,217,255,0.15)",
    borderWidth: 1,
    borderColor: "rgba(0,217,255,0.28)",
  },
  fondPresse: {
    backgroundColor: "rgba(255,255,255,0.10)",
  },
  badge: {
    position: "absolute",
    top: -5,
    right: 0,
    minWidth: 17,
    height: 17,
    borderRadius: radius.pill,
    paddingHorizontal: 5,
    backgroundColor: colors.primary,
    borderWidth: 2,
    borderColor: "rgba(21,26,37,0.95)",
    alignItems: "center",
    justifyContent: "center",
  },
  badgeTexte: {
    color: colors.onPrimary,
    fontSize: 10.5,
    lineHeight: 13,
    fontWeight: "700",
    ...tabular,
  },
  libelle: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "500",
    color: colors.ink2,
  },
  libelleActif: {
    color: colors.ink,
    fontWeight: "600",
  },
});
