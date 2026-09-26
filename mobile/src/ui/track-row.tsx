/**
 * Une ligne de titre : le fichier est l'objet visible.
 *
 * Elle dit toujours son état, y compris ce qu'il reste à faire — c'est le
 * principe qui tient toute la bibliothèque. La maquette la dessine en ligne
 * séparée par un hairline, avec la durée sous le titre et l'état en bout de
 * ligne (icône de synchro verte si le titre est là, grise sinon) : plus de
 * colonne de poids, l'information est dans la ligne.
 */
import { useEffect, useState } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";

import type { Piste } from "@/db/repos";
import { formaterDuree } from "@/transfer/format";
import { useApp } from "@/state/app";
import { MarqueEtat } from "@/ui/kit";
import { IconCheck } from "@/ui/icons";
import { Vignette } from "@/ui/vignette";
import { colors, ease, radius, space, tabular, type as typo } from "@/theme/tokens";

const COURBE = Easing.bezier(ease[0], ease[1], ease[2], ease[3]);
/** Distance de la « montée » : assez pour se lire, pas assez pour flotter. */
const MONTE = 10;
/** Le décalage entre deux lignes : les titres se lèvent en vague, pas en bloc. */
const DECALAGE = 26;

/** Ce que la sous-ligne annonce : la durée, pour chaque titre. */
function sousLigne(piste: Piste): string {
  // La mesure appartient au titre, pas à son état : elle s'affiche donc pour
  // tous. L'état, lui, est porté par l'icône en bout de ligne (verte si le
  // titre est là, grise sinon) — et quand la durée n'est pas connue, c'est
  // elle que la sous-ligne nomme, plutôt qu'un tiret.
  if (piste.duree > 0) {
    return formaterDuree(piste.duree);
  }
  if (piste.etat === "partiel") {
    return "transfert interrompu";
  }
  if (piste.etat === "absent") {
    return "pas encore sur ton téléphone";
  }
  // Les titres des vieux imports n'avaient pas de durée : le fichier, lui, la
  // porte. On la sonde une fois sur le téléphone, et en attendant la ligne
  // reste honnête — jamais vide.
  return "durée connue à la lecture";
}

export function LigneTitre({
  piste,
  onPress,
  onLongPress,
  secondaire,
  enLecture = false,
  enCours = false,
  enSelection = false,
  selectionne = false,
  entree,
}: {
  piste: Piste;
  onPress?: () => void;
  onLongPress?: () => void;
  secondaire?: string;
  enLecture?: boolean;
  enCours?: boolean;
  /** Mode sélection : la ligne coche, le tap bascule, la lecture attend. */
  enSelection?: boolean;
  selectionne?: boolean;
  /**
   * Rang d'arrivée de la ligne dans la liste. Également absent quand la ligne
   * est stable (une lecture, une sélection) : c'est le rechargement d'un
   * FILTRE qui fait monter les résultats, et une liste qui se réordonne en
   * silence ne doit pas se mettre à danser sous le doigt.
   */
  entree?: number;
}) {
  const anime = useApp((etat) => etat.animations);
  const [levee] = useState(() => new Animated.Value(0));

  // La ligne se lève à son arrivée : elle monte de MONTE et se pose, chacune à
  // son tour, l'écart croissant avec son rang (DECALAGE) — une vague, pas un
  // bloc qui bascule d'un coup. Le décalage est plafonné à huit rangs : au-delà,
  // toutes les lignes restantes se lèvent ensemble, pour que le dernier
  // résultat d'une longue recherche n'attende pas d'être lu.
  const retard = Math.min(entree ?? 0, 8) * DECALAGE;
  useEffect(() => {
    if (entree === undefined) return;
    levee.setValue(0);
    if (!anime) {
      // « Réduire le mouvement » : la ligne est déjà là, sans détour.
      levee.setValue(1);
      return;
    }
    const animation = Animated.timing(levee, {
      toValue: 1,
      duration: 200,
      delay: retard,
      easing: COURBE,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [anime, entree, retard, levee]);

  const contenu = (
    <Pressable
      accessibilityRole={enSelection ? "checkbox" : "button"}
      accessibilityLabel={`${piste.titre}, ${piste.chaine}`}
      accessibilityState={enSelection ? { checked: selectionne } : undefined}
      accessibilityHint={
        enSelection
          ? selectionne
            ? "Sélectionné, touchez pour désélectionner"
            : "Non sélectionné, touchez pour sélectionner"
          : piste.etat === "chez_toi"
            ? "Lecture hors ligne"
            : "Pas encore sur le téléphone"
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
      <Vignette pochette={piste.pochette} titre={piste.titre} />
      <View style={styles.centre}>
        <Text
          style={[styles.titre, enLecture && styles.titreActif]}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {piste.titre}
        </Text>
        <Text style={styles.detail} numberOfLines={1}>
          {secondaire ?? sousLigne(piste)}
        </Text>
      </View>
      {enSelection ? (
        // La coche remplace la marque d'état : en sélection, ce qui compte
        // ce n'est plus la possession, c'est le choix. Elle vit dans un
        // cercle, comme la case d'une checkbox.
        <View
          style={[styles.coche, selectionne && styles.cocheSelectionnee]}
          accessible={false}
        >
          {selectionne ? <IconCheck size={14} color={colors.onPrimary} /> : null}
        </View>
      ) : (
        <MarqueEtat etat={piste.etat} compact enCours={enCours} />
      )}
    </Pressable>
  );

  if (entree === undefined) return contenu;

  return (
    <Animated.View
      style={{
        opacity: levee,
        transform: [
          { translateY: levee.interpolate({ inputRange: [0, 1], outputRange: [MONTE, 0] }) },
        ],
      }}
    >
      {contenu}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  ligne: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.sm,
    paddingHorizontal: 18,
    minHeight: 62,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  ligneSelectionnee: {
    backgroundColor: "rgba(0,217,255,0.07)",
  },
  pressee: {
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  centre: {
    flex: 1,
    gap: 2,
  },
  titre: {
    ...typo.ligne,
    color: colors.ink,
  },
  titreActif: {
    color: colors.accent,
    fontWeight: "700",
  },
  detail: {
    ...typo.caption,
    color: colors.ink2,
    ...tabular,
  },
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
