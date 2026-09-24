/**
 * La file d'attente, en feuille.
 *
 * C'est la vue pleine de ce que le lecteur fait ensuite : le titre en cours,
 * puis l'ordre réel des titres à venir — y compris une file réordonnée par la
 * lecture aléatoire. Une rangée montrée ici reflète donc exactement ce qu'un
 * tirage sans remise a décidé.
 *
 * Le sélecteur de lecture aléatoire vit dans l'en-tête, à portée du pouce :
 * il concerne la file entière, pas un titre.
 */
import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as lecteur from "@/playback/lecteur";
import { useLecture, type ModeBoucle } from "@/playback/store";
import { formaterDuree } from "@/transfer/format";
import { Egaliseur } from "@/ui/egaliseur";
import { Feuille, Separateur, TitreSection } from "@/ui/kit";
import { IconAleatoire, IconRepeter } from "@/ui/icons";
import { Vignette } from "@/ui/vignette";
import { colors, radius, space, tabular, touch, type as typo } from "@/theme/tokens";

/** Un sélecteur de mode d'en-tête : pastille neutre, accent quand actif. */
function PastilleMode({
  actif,
  libelle,
  onPress,
  children,
}: {
  actif: boolean;
  libelle: string;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={libelle}
      accessibilityState={{ checked: actif }}
      onPress={onPress}
      style={({ pressed }) => [styles.mode, actif && styles.modeActif, pressed && styles.pressee]}
    >
      {children}
    </Pressable>
  );
}

/** Ce que le bouton « lecture en boucle » de la feuille annonce. */
function libelleBoucle(mode: ModeBoucle): string {
  if (mode === "titre") return "Lecture en boucle : rejoue le titre";
  if (mode === "file") return "Lecture en boucle : rejoue la file";
  return "Lecture en boucle : désactivée";
}

export function FeuilleFile({ visible, onFermer }: { visible: boolean; onFermer: () => void }) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const file = useLecture((etat) => etat.file);
  const index = useLecture((etat) => etat.index);
  const lecture = useLecture((etat) => etat.lecture);
  const melanger = useLecture((etat) => etat.melanger);
  const boucle = useLecture((etat) => etat.boucle);

  const piste = file[index] ?? null;
  const suite = file.slice(index + 1);
  const mode = melanger
    ? "lecture aléatoire"
    : boucle === "titre"
      ? "titre en boucle"
      : boucle === "file"
        ? "lecture en boucle"
        : null;
  const sousTitre =
    file.length === 0
      ? "La file est vide"
      : `${file.length} titre${file.length > 1 ? "s" : ""}${mode ? ` · ${mode}` : ""}`;

  return (
    <Feuille
      visible={visible}
      onFermer={onFermer}
      titre="File d'attente"
      sousTitre={sousTitre}
      action={
        <View style={styles.modes}>
          <PastilleMode
            actif={boucle !== "simple"}
            libelle={libelleBoucle(boucle)}
            onPress={() => void lecteur.basculerBoucle()}
          >
            <IconRepeter size={22} color={boucle !== "simple" ? colors.accent : colors.ink2} />
            {boucle === "titre" ? <Text style={styles.boucleUn}>1</Text> : null}
          </PastilleMode>
          <PastilleMode
            actif={melanger}
            libelle="Lecture aléatoire"
            onPress={() => void lecteur.basculerAleatoire()}
          >
            <IconAleatoire size={22} color={melanger ? colors.accent : colors.ink2} />
          </PastilleMode>
        </View>
      }
    >
      <ScrollView
        style={[styles.liste, { maxHeight: height * 0.56 }]}
        contentContainerStyle={[styles.listeContenu, { paddingBottom: insets.bottom + space.md }]}
        showsVerticalScrollIndicator={false}
      >
        {piste ? (
          <>
            <TitreSection texte="En lecture" />
            <View style={styles.enLecture}>
              <Vignette pochette={piste.pochette} titre={piste.titre} />
              <View style={styles.centre}>
                <Text style={styles.actif} numberOfLines={1}>
                  {piste.titre}
                </Text>
                <Text style={styles.detail} numberOfLines={1}>
                  {piste.chaine}
                </Text>
              </View>
              {lecture ? <Egaliseur couleur={colors.accent} /> : null}
              <Text style={styles.duree}>{formaterDuree(piste.duree)}</Text>
            </View>
            <Separateur />
          </>
        ) : null}

        {suite.length > 0 ? (
          <>
            <TitreSection texte="Ensuite" />
            {suite.map((element, ecart) => {
              const rang = index + ecart + 1;
              return (
                <Pressable
                  key={element.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${element.titre}, ${element.chaine}`}
                  onPress={() => void lecteur.sauterA(index + ecart + 1)}
                  style={({ pressed }) => [styles.ligne, pressed && styles.pressee]}
                >
                  <Text style={styles.rang}>{rang + 1}</Text>
                  <Vignette pochette={element.pochette} titre={element.titre} />
                  <View style={styles.centre}>
                    <Text style={styles.titre} numberOfLines={1}>
                      {element.titre}
                    </Text>
                    <Text style={styles.detail} numberOfLines={1}>
                      {element.chaine}
                    </Text>
                  </View>
                  <Text style={styles.duree}>{formaterDuree(element.duree)}</Text>
                </Pressable>
              );
            })}
            <Separateur />
          </>
        ) : null}

        {file.length === 0 ? (
          <View style={styles.vide}>
            <Text style={styles.videTitre}>Rien dans la file</Text>
            <Text style={styles.videTexte}>
              Lance un titre depuis la bibliothèque : la file se remplit toute seule.
            </Text>
          </View>
        ) : null}

        {file.length > 0 && suite.length === 0 ? (
          <View style={styles.fin}>
            <Text style={styles.finTitre}>Fin de la file</Text>
            <Text style={styles.finTexte}>
              {melanger
                ? "Au dernier titre, la passe repart de la tête : le même ordre revient, chaque titre à son tour."
                : boucle === "titre"
                  ? "Le titre en cours se répète : la file n'avance pas toute seule."
                  : boucle === "file"
                    ? "Vous êtes au dernier titre : la lecture en boucle repart de la tête."
                    : "Vous êtes au dernier titre de la playlist : la lecture s'arrêtera après."}
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </Feuille>
  );
}

const styles = StyleSheet.create({
  modes: { flexDirection: "row", gap: space.xs },
  mode: {
    width: touch.min,
    height: touch.min,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  modeActif: { backgroundColor: "rgba(0,217,255,0.12)" },
  boucleUn: {
    position: "absolute",
    top: 3,
    right: 7,
    color: colors.accent,
    fontSize: 10,
    fontWeight: "800",
  },
  pressee: { opacity: 0.7 },
  liste: { marginHorizontal: -space.md },
  listeContenu: { gap: 2, paddingHorizontal: space.md, paddingTop: space.md },
  enLecture: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.sm,
    minHeight: 62,
  },
  centre: { flex: 1, gap: 2 },
  actif: { ...typo.ligne, fontWeight: "700", color: colors.accent },
  titre: { ...typo.ligne, color: colors.ink },
  detail: { ...typo.caption, color: colors.ink2 },
  duree: { ...typo.caption, color: colors.ink2, ...tabular },
  ligne: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.sm,
    minHeight: 62,
  },
  rang: { ...typo.caption, color: colors.ink3, width: 18, textAlign: "right", ...tabular },
  vide: { alignItems: "center", gap: 6, paddingVertical: space.xl },
  videTitre: { ...typo.vide, color: colors.ink },
  videTexte: { ...typo.caption, color: colors.ink2, textAlign: "center" },
  fin: { gap: 2, paddingVertical: space.sm },
  finTitre: { ...typo.section, color: colors.ink2 },
  finTexte: { ...typo.caption, color: colors.ink2 },
});