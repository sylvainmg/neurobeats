/**
 * Boîte de dialogue, à la place des alertes natives.
 *
 * Une alerte native sort de la langue de l'écran : même police que le système,
 * même disposition, aucune parenté avec la maquette. Ici c'est une carte de la
 * maquette — scrim, surface, médaillon, boutons du kit — posée sur le contenu
 * qu'elle concerne. Elle reste une boîte de dialogue : on ne répond qu'aux
 * boutons, jamais en touchant le scrim, pour qu'une confirmation destructive ne
 * s'évapore pas d'un tap involontaire.
 *
 * Deux mises en forme seulement, comme les alertes remplacées :
 * - `ton="info"` : médaillon en dégradé de marque, un unique bouton (ou deux
 *   quand l'action a un « Annuler ») ;
 * - `ton="danger"` : médaillon et bouton principal en couleur d'effacement,
 *   pour annoncer ce qui disparaît.
 */
import { LinearGradient } from "expo-linear-gradient";
import { useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Bouton } from "@/ui/kit";
import { IconAlert, IconCodeQr } from "@/ui/icons";
import { colors, degrade, radius, space, type as typo } from "@/theme/tokens";

/**
 * Une option d'un dialogue à choix : remplace le bouton principal par autant
 * de lignes que nécessaire, chacune fermant la boîte après son action.
 */
export type OptionDialogue = {
  libelle: string;
  /** La conséquence, en plus petit, sous le libellé (ex. « Le fichier est effacé… »). */
  description?: string;
  icone?: ReactNode;
  /** Ton effacement pour les options destructives. */
  danger?: boolean;
  surChoisir: () => void | Promise<void>;
};

/**
 * Une entrée d'une notice : la liste scrollable qu'un dialogue peut porter
 * quand il annonce plusieurs choses à la fois (ex. les titres qu'on ne
 * partagera pas).
 */
export type NoticeDialogue = {
  libelle: string;
  note?: string;
  icone?: ReactNode;
};

type DialogueProps = {
  visible: boolean;
  titre: string;
  message: string;
  ton?: "info" | "danger";
  /** Emblème du médaillon ; par défaut celui du ton. */
  icone?: ReactNode;
  /** Libellé du bouton principal. Sans action, « Compris » referme. */
  confirmer?: string;
  /** Libellé du bouton secondaire ; sa présence fait deux boutons. */
  annuler?: string;
  /** L'action du bouton principal. Épuisée, la boîte se referme. */
  surConfirmer?: () => void | Promise<void>;
  /** Quand plusieurs issues sont possibles, ses lignes remplacent le bouton principal. */
  choix?: OptionDialogue[];
  /** Notice scrollable entre le message et les actions (liste, jamais narrative). */
  liste?: NoticeDialogue[];
  surFermer: () => void;
};

export function Dialogue({
  visible,
  titre,
  message,
  ton = "info",
  icone,
  confirmer = "Compris",
  annuler,
  surConfirmer,
  choix,
  liste,
  surFermer,
}: DialogueProps) {
  const [enCours, setEnCours] = useState(false);

  const confirmerEl = async () => {
    if (!surConfirmer) return surFermer();
    setEnCours(true);
    try {
      await surConfirmer();
    } finally {
      setEnCours(false);
    }
    surFermer();
  };

  const choisir = async (option: OptionDialogue) => {
    if (!option.surChoisir) return surFermer();
    setEnCours(true);
    try {
      await option.surChoisir();
    } finally {
      setEnCours(false);
    }
    surFermer();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={surFermer}
    >
      <View style={styles.porte}>
        <Pressable style={styles.scrim} onPress={undefined} accessible={false} />
        <View style={styles.carte} accessibilityViewIsModal>
          {ton === "danger" ? (
            <View style={styles.medaillonDanger} accessible={false}>
              {icone ?? <IconAlert size={26} color={colors.danger} />}
            </View>
          ) : (
            <LinearGradient
              colors={degrade.marque}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.medaillonMarque}
              accessible={false}
            >
              {icone ?? <IconCodeQr size={26} color="#04121f" />}
            </LinearGradient>
          )}
          <Text style={styles.titre}>{titre}</Text>
          <Text style={styles.message}>{message}</Text>
          {liste ? (
            <ScrollView
              style={styles.liste}
              contentContainerStyle={styles.listeContenu}
              nestedScrollEnabled
              showsVerticalScrollIndicator
            >
              {/* Une notice est une liste : chaque entrée est une écoute
                  (les lecteurs d'écran la lisent entière), pas un amas de
                  texte en un seul nœud. */}
              {liste.map((entree) => (
                <View key={entree.libelle} style={styles.listeLigne} accessible>
                  {entree.icone}
                  <View style={styles.listeTextes}>
                    <Text style={styles.listeLibelle} numberOfLines={1}>
                      {entree.libelle}
                    </Text>
                    {entree.note ? (
                      <Text style={styles.listeNote} numberOfLines={1}>
                        {entree.note}
                      </Text>
                    ) : null}
                  </View>
                </View>
              ))}
            </ScrollView>
          ) : null}
          {choix ? (
            <View style={styles.choix}>
              {choix.map((option) => (
                <Pressable
                  key={option.libelle}
                  accessibilityRole="button"
                  accessibilityLabel={option.libelle}
                  disabled={enCours}
                  onPress={() => void choisir(option)}
                  style={({ pressed }) => [
                    styles.choixLigne,
                    option.danger && styles.choixLigneDanger,
                    pressed && styles.choixLignePressee,
                  ]}
                >
                  {option.icone}
                  <View style={styles.choixTextes}>
                    <Text
                      style={[styles.choixLibelle, option.danger && { color: colors.danger }]}
                    >
                      {option.libelle}
                    </Text>
                    {option.description ? (
                      <Text style={styles.choixDescription}>{option.description}</Text>
                    ) : null}
                  </View>
                </Pressable>
              ))}
            </View>
          ) : null}
          {choix ? (
            <View style={styles.actions}>
              <Bouton
                titre={annuler ?? "Annuler"}
                variante="fantome"
                desactive={enCours}
                onPress={surFermer}
                style={styles.acteur}
              />
            </View>
          ) : (
            <View style={styles.actions}>
              <Bouton
                titre={confirmer}
                variante={ton === "danger" ? "danger" : "primaire"}
                enCours={enCours}
                desactive={enCours}
                onPress={() => void confirmerEl()}
                style={styles.acteur}
              />
              {annuler ? (
                <Bouton
                  titre={annuler}
                  variante="fantome"
                  desactive={enCours}
                  onPress={surFermer}
                  style={styles.acteur}
                />
              ) : null}
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

/**
 * L'état d'une boîte de dialogue, posé dans l'écran qui la convoque.
 *
 * `ouvrir({...})` affiche la carte, `element` se rend n'importe où dans l'arbre
 * de l'écran. Chaque écran garde sa boîte : deux écrans ne se marchent pas
 * dessus, et le retour par le bouton système referme proprement.
 */
export function useDialogue() {
  const [demande, setDemande] = useState<
    Omit<DialogueProps, "visible" | "surFermer"> | null
  >(null);

  const ouvrir = (params: Omit<DialogueProps, "visible" | "surFermer">) => setDemande(params);
  const fermer = () => setDemande(null);

  return {
    ouvrir,
    fermer,
    element: demande ? <Dialogue {...demande} visible surFermer={fermer} /> : null,
  };
}

const styles = StyleSheet.create({
  porte: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.xl,
  },
  scrim: {
    ...StyleSheet.absoluteFill,
    backgroundColor: colors.scrim,
  },
  carte: {
    alignSelf: "stretch",
    maxWidth: 360,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderFort,
    padding: space.xl,
    gap: space.md,
    alignItems: "center",
    elevation: 24,
  },
  medaillonDanger: {
    width: 56,
    height: 56,
    borderRadius: radius.lg,
    backgroundColor: "rgba(255,107,107,0.14)",
    alignItems: "center",
    justifyContent: "center",
  },
  medaillonMarque: {
    width: 56,
    height: 56,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  titre: { ...typo.feuille, color: colors.ink, textAlign: "center" },
  message: {
    fontSize: 13.5,
    lineHeight: 19,
    fontWeight: "500",
    color: colors.ink2,
    textAlign: "center",
  },
  actions: {
    flexDirection: "row",
    gap: space.sm,
    marginTop: space.sm,
    alignSelf: "stretch",
  },
  acteur: { flex: 1 },
  // La notice ne doit pas dominer la carte : elle plafonne à quelques lignes
  // et fait défiler le surplus, sinon un dialogue de partage deviendrait un
  // mur de texte imparable.
  liste: {
    maxHeight: 200,
    alignSelf: "stretch",
  },
  listeContenu: {
    gap: 7,
    paddingVertical: 2,
  },
  listeLigne: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    backgroundColor: "rgba(255,255,255,0.05)",
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 8,
    paddingHorizontal: 11,
  },
  listeTextes: { flex: 1, gap: 1 },
  listeLibelle: { ...typo.body, color: colors.ink, fontSize: 12.5 },
  listeNote: { ...typo.caption, color: colors.ink2, fontSize: 11 },
  choix: {
    alignSelf: "stretch",
    gap: space.sm,
    marginTop: space.xs,
  },
  choixLigne: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderFort,
    paddingVertical: 12,
    paddingHorizontal: space.md,
  },
  choixLigneDanger: {
    borderColor: "rgba(255,107,107,0.45)",
  },
  choixLignePressee: {
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  choixTextes: { flex: 1, gap: 2 },
  choixLibelle: { ...typo.body, color: colors.ink, fontWeight: "700" },
  choixDescription: { ...typo.caption, color: colors.ink2, lineHeight: 17 },
});