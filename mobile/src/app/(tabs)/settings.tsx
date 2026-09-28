/**
 * Réglages : chaque choix montre sa conséquence.
 *
 * La maquette range les réglages en groupes séparés par des hairlines, et chaque
 * ligne dit ce qu'elle change (« ≈ 8 Mo par titre », « s'applique aux prochains
 * transferts »). Les actions destructrices sont nommées précisément — jamais un
 * « supprimer » générique — et le poids libéré est annoncé avant.
 *
 * Ce que la maquette ne montre pas et qui reste : la ligne d'honnêteté sur le
 * transfert en arrière-plan, affichée seulement quand il n'est pas disponible.
 */
import { useFocusEffect } from "expo-router";
import Constants from "expo-constants";
import { useCallback, useState } from "react";
import { ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as repo from "@/db/repos";
import { viderLeTelephone } from "@/library/effacement";
import { useLecture } from "@/playback/store";
import { useApp } from "@/state/app";
import { pluraliser } from "@/transfer/format";
import { Bouton, EnTeteEcran, LigneLien, TitreSection, Valeur } from "@/ui/kit";
import { useDialogue } from "@/ui/dialog";
import { IconTrash } from "@/ui/icons";
import { placeEnBas } from "@/ui/barre";
import { colors, space, type as typo } from "@/theme/tokens";

export default function Reglages() {
  const insets = useSafeAreaInsets();
  const mini = useLecture((etat) => etat.file.length > 0);
  const wifi = useApp((etat) => etat.wifiUniquement);
  const reglerWifi = useApp((etat) => etat.reglerWifi);
  const persistant = useApp((etat) => etat.transfertPersistantActif);
  const [bilan, setBilan] = useState<repo.Bilan>({ titres: 0, chez_toi: 0, octets: 0 });
  const { ouvrir: ouvrirDialogue, element: dialogue } = useDialogue();

  const charger = useCallback(async () => {
    setBilan(await repo.bilan());
  }, []);

  useFocusEffect(
    useCallback(() => {
      void charger();
    }, [charger]),
  );

  const sansFichier = Math.max(0, bilan.titres - bilan.chez_toi);
  // Repli volontairement absent de version en dur : une valeur figee
  // deviendrait fausse a chaque changement de version, et l'afficherait sans
  // qu'on le remarque. « Inconnue » se voit ; « 0.1 » passerait pour vrai.
  const version = Constants.expoConfig?.version ?? "inconnue";

  return (
    <View style={styles.porte}>
      <EnTeteEcran titre="Réglages" meta={`v${version}`} />
      <ScrollView
        contentContainerStyle={[
          styles.contenu,
          { paddingBottom: placeEnBas(insets.bottom, mini) },
        ]}
      >
        <View style={styles.groupe}>
          <TitreSection texte="Ta musique" />
          <Valeur texte={pluraliser(bilan.chez_toi, "titre")} />
          <Text style={styles.consequence}>
            Prêts sans réseau, où que tu sois.
          </Text>
        </View>

        <View style={styles.groupe}>
          <View style={styles.interrupteur}>
            <View style={styles.interrupteurTextes}>
              <Text style={styles.interrupteurTitre}>Télécharger en Wi-Fi uniquement</Text>
              <Text style={styles.interrupteurDetail}>Évite de consommer ton forfait</Text>
            </View>
            <Switch
              value={wifi}
              onValueChange={(valeur) => void reglerWifi(valeur)}
              accessibilityLabel="Télécharger en Wi-Fi uniquement"
              trackColor={{ false: "rgba(255,255,255,0.18)", true: colors.primary }}
              thumbColor={colors.ink}
            />
          </View>
          {!persistant ? (
            <Text style={styles.consequence}>
              Quitte l'app et les transferts s'arrêtent.
            </Text>
          ) : null}
        </View>

        <View style={styles.groupe}>
          <TitreSection texte="Origine de la musique" />
          <Text style={styles.consequence}>
            Tes playlists arrivent depuis ton ordinateur.
          </Text>
        </View>

        <View style={styles.groupe}>
          <TitreSection texte="Le projet" />
          <LigneLien
            titre="neurobeats.site"
            detail="Documentation, versions, code source"
            presse="neurobeats.site, ouvre le site du projet dans le navigateur"
          />
          <Text style={styles.consequence}>
            Ce que l'app envoie sur le réseau y est détaillé.
          </Text>
        </View>

        <View style={styles.groupe}>
          <TitreSection texte="Effacer" />
          <Bouton
            titre={
              sansFichier > 0
                ? `Retirer les ${pluraliser(sansFichier, "titre")} sans musique`
                : "Aucun titre sans musique"
            }
            variante="danger"
            desactive={sansFichier === 0}
            onPress={() =>
              ouvrirDialogue({
                ton: "danger",
                titre: `Retirer ${pluraliser(sansFichier, "titre")} sans musique ?`,
                message:
                  "Ces titres seront retirés de la bibliothèque. Aucune musique n'est supprimée.",
                icone: <IconTrash size={26} color={colors.danger} />,
                annuler: "Annuler",
                confirmer: "Retirer",
                surConfirmer: async () => {
                  await repo.oublierSansFichier();
                  await charger();
                },
              })
            }
          />
          <Bouton
            titre="Tout effacer"
            variante="danger"
            desactive={bilan.titres === 0}
            onPress={() =>
              ouvrirDialogue({
                ton: "danger",
                titre: "Tout effacer ?",
                message: "Tous les titres seront retirés de ton téléphone et des playlists. Il faudra rescanner un code pour les retrouver.",
                icone: <IconTrash size={26} color={colors.danger} />,
                annuler: "Annuler",
                confirmer: "Tout effacer",
                surConfirmer: async () => {
                  await viderLeTelephone();
                  await charger();
                },
              })
            }
          />
          <Text style={styles.consequence}>
            Irréversible : les titres partent aussi. Confirmation demandée avant.
          </Text>
        </View>
      </ScrollView>
      {dialogue}
    </View>
  );
}

const styles = StyleSheet.create({
  porte: { flex: 1, backgroundColor: colors.canvas },
  contenu: { paddingHorizontal: 18 },
  groupe: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingVertical: 13,
    gap: space.sm,
  },
  consequence: { ...typo.note, color: colors.ink2 },
  interrupteur: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 48,
  },
  interrupteurTextes: { flex: 1, gap: 2 },
  interrupteurTitre: { fontSize: 13.5, lineHeight: 18, fontWeight: "600", color: colors.ink },
  interrupteurDetail: { ...typo.caption, color: colors.ink2 },
});
