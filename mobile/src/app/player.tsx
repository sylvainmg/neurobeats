/**
 * Lecture : la pochette, l'état hors ligne, le transport, la file.
 *
 * L'écran ne fait que lire le magasin de lecture : c'est le lecteur qui publie la
 * position et l'index réel, donc l'écran suit l'enchaînement sans le décider.
 *
 * Cinq commandes, comme la maquette : précédent, −15 s, lecture, +15 s, suivant.
 * Les sauts de quinze secondes sont là parce qu'un titre écouté au casque se
 * reprend au milieu, pas au début ; pendant la lecture, le bouton central montre
 * l'égaliseur — il dit « ça joue » plutôt que « appuie ici ».
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as lecteur from "@/playback/lecteur";
import { useLecture, type ModeBoucle } from "@/playback/store";
import { formaterDuree } from "@/transfer/format";
import { Egaliseur } from "@/ui/egaliseur";
import {
  IconAleatoire,
  IconAvancer15,
  IconChevronLeft,
  IconNext,
  IconPlay,
  IconPrevious,
  IconQueue,
  IconReculer15,
  IconRepeter,
  IconTelecharge,
} from "@/ui/icons";
import { BarreDeProgression } from "@/ui/kit";
import { FeuilleFile } from "@/ui/file";
import { Vignette } from "@/ui/vignette";
import { colors, ombre, radius, space, tabular, touch, type as typo } from "@/theme/tokens";

export default function Lecteur() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const file = useLecture((etat) => etat.file);
  const index = useLecture((etat) => etat.index);
  const lecture = useLecture((etat) => etat.lecture);
  const position = useLecture((etat) => etat.position);
  const dureeLue = useLecture((etat) => etat.duree);
  const melanger = useLecture((etat) => etat.melanger);
  const boucle = useLecture((etat) => etat.boucle);
  const probleme = useLecture((etat) => etat.probleme);
  // L'écran ne défile pas : la pochette grandit ou rétrécit au lieu de pousser
  // le transport hors de la vue. La zone qui lui est dédiée remplit l'espace
  // restant, et la pochette se fait tenir dedans en carré le plus grand.
  const { width: largeurEcran } = useWindowDimensions();
  const [zonePochette, setZonePochette] = useState({ largeur: largeurEcran - 36, hauteur: 296 });
  const taillePochette = Math.min(
    zonePochette.hauteur,
    Math.max(180, zonePochette.largeur),
  );
  // La feuille de la file d'attente : ouverte d'ici ou depuis l'en-tête.
  const [fileOuverte, setFileOuverte] = useState(false);
  // Aperçu pendant le glissement : le seek n'a lieu qu'au relâchement, donc le
  // temps affiché suivrait la lecture réelle sans ce coût de « visé » local.
  const [apercu, setApercu] = useState<number | null>(null);
  // La position réelle a rejoint la cible visée : on rend l'affichage à la
  // lecture (même patron que la barre — le saut n'est pas instantané).
  if (apercu != null && Math.abs(position - apercu) <= 1.5) {
    setApercu(null);
  }
  const mesurerPochette = useCallback(
    (largeur: number, hauteur: number) => setZonePochette({ largeur, hauteur }),
    [],
  );
  const piste = file[index] ?? null;
  const duree = dureeLue || piste?.duree || 0;
  const suite = file.slice(index + 1);
  const fraction = duree > 0 ? position / duree : 0;
  const tempsAffiche = apercu ?? position;
  // `formaterDuree(0)` dit « durée inconnue » (tiret) : ici 0 est le début du
  // titre, montrons-le, sinon le « — » clignote entre un seek et le tick suivant.
  const tempsFormatte = tempsAffiche > 0 ? formaterDuree(tempsAffiche) : "0:00";

  // Filet de sécurité : si le seek échoue, l'aperçu ne reste pas figé pour
  // toujours.
  useEffect(() => {
    if (apercu == null) return;
    const id = setTimeout(() => setApercu(null), 2500);
    return () => clearTimeout(id);
  }, [apercu]);

  const surDéplacement = useCallback(
    (nouvelleFraction: number) => {
      setApercu(nouvelleFraction * duree);
    },
    [duree],
  );

  const surRelâchement = useCallback(
    (nouvelleFraction: number) => {
      // La cible reste affichée jusqu'à confirmation, comme la barre : sans
      // quoi le temps reviendrait brièvement sur l'ancienne position.
      const cible = Math.round(nouvelleFraction * duree);
      setApercu(cible);
      void lecteur.chercher(cible);
    },
    [duree],
  );

  return (
    <View style={styles.porte}>
      <View style={[styles.entete, { paddingTop: insets.top + space.sm }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Fermer le lecteur"
          onPress={() => router.back()}
          style={({ pressed }) => [styles.retour, pressed && styles.retourPresse]}
        >
          <IconChevronLeft size={24} color={colors.ink} />
        </Pressable>
        {piste ? (
          <View style={styles.enteteActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Ouvrir la file d'attente"
              onPress={() => setFileOuverte(true)}
              style={({ pressed }) => [styles.retour, pressed && styles.retourPresse]}
            >
              <IconQueue size={24} color={colors.ink} />
            </Pressable>
          </View>
        ) : null}
      </View>

      {!piste ? (
        <View style={styles.centre}>
          <Text style={styles.titreVide}>Rien en lecture</Text>
        </View>
      ) : (
        <View
          style={[styles.contenu, { paddingBottom: insets.bottom + space.md }]}
        >
          <View
            style={styles.zonePochette}
            onLayout={(e) =>
              mesurerPochette(e.nativeEvent.layout.width, e.nativeEvent.layout.height)
            }
          >
            <View style={[styles.pochette, { width: taillePochette, height: taillePochette }]}>
              <Vignette
                pochette={piste.pochette}
                titre={piste.titre}
                taille={taillePochette}
                rayon={radius.lg}
                tailleInitiale={44}
              />
            </View>
          </View>

          <View style={styles.textes}>
            <View style={styles.titreRang}>
              <Text style={styles.titre} numberOfLines={2}>
                {piste.titre}
              </Text>
              <View
                style={styles.telecharge}
                accessible
                accessibilityRole="image"
                accessibilityLabel="Titre téléchargé en local"
              >
                <IconTelecharge size={16} color={colors.ok} />
              </View>
            </View>
            <Text style={styles.chaine} numberOfLines={1}>
              {piste.chaine}
            </Text>
          </View>

          {probleme ? (
            <Text style={styles.probleme} accessibilityRole="alert">
              {probleme}
            </Text>
          ) : null}

          <View style={styles.progression}>
            <Text style={styles.temps}>{tempsFormatte}</Text>
            <View style={styles.rail}>
              <BarreDeProgression
                fraction={fraction}
                actif={lecture}
                libelle={`Position dans ${piste.titre}`}
                surDéplacement={surDéplacement}
                surRelâchement={surRelâchement}
              />
            </View>
            <Text style={styles.temps}>{formaterDuree(duree)}</Text>
          </View>

          <View style={styles.transport}>
            <Commande
              libelle="Titre précédent"
              onPress={() => void lecteur.precedent()}
              Icone={IconPrevious}
            />
            <Commande
              libelle="Reculer de 15 secondes"
              onPress={() => void lecteur.reculer()}
              Icone={IconReculer15}
              trait
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={lecture ? "Lecture en cours, mettre en pause" : "Lire"}
              onPress={() => void lecteur.basculer()}
              style={({ pressed }) => [
                styles.grande,
                ombre.lecture,
                pressed && styles.grandePressee,
              ]}
            >
              {lecture ? (
                <Egaliseur />
              ) : (
                <IconPlay size={28} color={colors.onPrimary} rempli />
              )}
            </Pressable>
            <Commande
              libelle="Avancer de 15 secondes"
              onPress={() => void lecteur.avancer()}
              Icone={IconAvancer15}
              trait
            />
            <Commande
              libelle="Titre suivant"
              onPress={() => void lecteur.suivant()}
              Icone={IconNext}
            />
          </View>

          {file.length > 0 ? (
            <View style={styles.fileControles}>
              <Pressable
                accessibilityRole="switch"
                accessibilityLabel="Lecture aléatoire"
                accessibilityState={{ checked: melanger }}
                onPress={() => void lecteur.basculerAleatoire()}
                style={({ pressed }) => [
                  styles.mode,
                  melanger && styles.modeActif,
                  pressed && styles.retourPresse,
                ]}
              >
                <IconAleatoire size={20} color={melanger ? colors.accent : colors.ink2} />
              </Pressable>
              {/* Shuffle, répéter et ce qui reste sont les contrôles de la file
                  (ordre + état), pas du titre en cours : ils vivent sur la même
                  rangée, le compte les reliant. L'ouverture de la file, elle,
                  reste dans l'en-tête — une seule entrée, pas de doublon. */}
              <Text style={styles.fileInfo} numberOfLines={1}>
                {compteFile(suite.length, melanger, boucle)}
              </Text>
              <Pressable
                accessibilityRole="switch"
                accessibilityLabel={libelleBoucle(boucle)}
                accessibilityState={{ checked: boucle !== "simple" }}
                onPress={() => void lecteur.basculerBoucle()}
                style={({ pressed }) => [
                  styles.mode,
                  boucle !== "simple" && styles.modeActif,
                  pressed && styles.retourPresse,
                ]}
              >
                <IconRepeter size={20} color={boucle !== "simple" ? colors.accent : colors.ink2} />
                {boucle === "titre" ? <Text style={styles.boucleUn}>1</Text> : null}
              </Pressable>
            </View>
          ) : null}
        </View>
      )}

      <FeuilleFile visible={fileOuverte} onFermer={() => setFileOuverte(false)} />
    </View>
  );
}

/**
 * Ce que la file annonce sous le transport : ce qui reste, ou ce qui l'attend —
 * la prochaine passe aléatoire en bout de cycle, le renvoi en tête du mode
 * « file », ou la relecture sans fin du mode « titre ».
 */
function compteFile(suite: number, melanger: boolean, boucle: ModeBoucle): string {
  if (suite > 0) return `${suite} titre${suite > 1 ? "s" : ""} à venir`;
  if (melanger) return "passe aléatoire";
  if (boucle === "titre") return "titre en boucle";
  if (boucle === "file") return "retour en tête";
  return "dernier titre";
}

/** Ce que le bouton « lecture en boucle » annonce, selon son état. */
function libelleBoucle(mode: ModeBoucle): string {
  if (mode === "titre") return "Lecture en boucle : rejoue le titre";
  if (mode === "file") return "Lecture en boucle : rejoue la file";
  return "Lecture en boucle : désactivée";
}

/**
 * Une commande du transport.
 *
 * Toutes ont la même cible (48 dp) et le même retour au toucher : un rond qui
 * s'éclaire sous le doigt. Seule la lecture reste pleine et plus grande, comme
 * sur n'importe quel lecteur — c'est la hiérarchie qu'on attend, et rien
 * d'autre n'est mis en avant.
 */
function Commande({
  libelle,
  onPress,
  Icone,
  trait = false,
}: {
  libelle: string;
  onPress: () => void;
  Icone: (props: { size?: number; color?: string; rempli?: boolean }) => React.ReactElement;
  /** Pictogramme au trait : le transport ne remplit que précédent, lecture, suivant. */
  trait?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={libelle}
      onPress={onPress}
      style={({ pressed }) => [styles.commande, pressed && styles.commandePressee]}
    >
      <Icone size={trait ? 26 : 28} color={colors.ink} rempli={!trait} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  porte: { flex: 1, backgroundColor: colors.canvas },
  centre: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.md },
  titreVide: { ...typo.vide, color: colors.ink },
  entete: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingBottom: space.xs,
  },
  retour: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  retourPresse: { opacity: 0.6 },
  enteteActions: { marginLeft: "auto", flexDirection: "row" },
  contenu: { flex: 1, paddingHorizontal: 18, paddingTop: space.sm, gap: space.md },
  // La voie de vie de l'écran : elle absorbe l'espace libre, donc l'ensemble
  // tient toujours d'une vue — il n'y a pas de page qui déborde.
  zonePochette: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  pochette: {
    borderRadius: radius.lg,
    overflow: "hidden",
    ...ombre.pochette,
  },
  textes: { gap: space.xs, alignItems: "flex-start" },
  titreRang: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: space.sm,
    width: "100%",
  },
  telecharge: { paddingTop: 7 },
  titre: { ...typo.vide, color: colors.ink, flexShrink: 1 },
  chaine: { ...typo.label, fontWeight: "500", color: colors.ink2 },
  probleme: { ...typo.body, color: colors.danger },
  progression: { flexDirection: "row", alignItems: "center", gap: 10 },
  rail: { flex: 1 },
  temps: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "500",
    color: colors.ink2,
    ...tabular,
    // Largeur fixe pour les deux temps : la rangée ne se rééguilibre pas quand
    // le texte change (sinon le rail se redimensionne en plein glissement).
    width: 50,
    textAlign: "right",
  },
  transport: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  commande: {
    width: 48,
    height: 48,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  commandePressee: { backgroundColor: "rgba(255,255,255,0.08)" },
  grande: {
    width: 64,
    height: 64,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  grandePressee: { opacity: 0.9 },
  fileControles: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingTop: space.sm,
  },
  fileInfo: {
    flex: 1,
    textAlign: "center",
    ...typo.caption,
    color: colors.ink2,
  },
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
    right: 5,
    color: colors.accent,
    fontSize: 10,
    fontWeight: "800",
  },
});
