/**
 * Aperçu de l'import : le moment de décider.
 *
 * La maquette en fait une feuille qui monte sur la bibliothèque — on ne quitte
 * pas ce qu'on regardait, on décide par-dessus. Trois choses y coûtent, et
 * toutes sont annoncées avant d'agir : le poids, la durée si l'ordinateur la
 * connaît, et surtout ce qui est **déjà là** — rescanner n'ajoute que la
 * différence. Le bouton se nomme par son action et par son nombre.
 */
import { useRouter } from "expo-router";
import { useState } from "react";
import { ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { formaterDuree, pluraliser } from "@/transfer/format";
import { useApp } from "@/state/app";
import { IconAlert, IconDownloads } from "@/ui/icons";
import { Bandeau, Bouton, EnTeteEcran, Etiquette, Ligne, Separateur, TitreSection } from "@/ui/kit";
import { useDialogue } from "@/ui/dialog";
import { colors, radius, space, touch, type as typo } from "@/theme/tokens";

export default function ApercuImport() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const session = useApp((etat) => etat.session);
  const bilan = useApp((etat) => etat.bilan);
  const wifi = useApp((etat) => etat.wifiUniquement);
  const reglerWifi = useApp((etat) => etat.reglerWifi);
  const lancer = useApp((etat) => etat.lancerTransfert);
  const fermer = useApp((etat) => etat.fermerSession);
  const [envoi, setEnvoi] = useState(false);
  const { ouvrir: ouvrirDialogue, element: dialogue } = useDialogue();

  if (session.phase !== "ouverte" || !bilan) {
    return (
      <View style={[styles.porte, styles.centre]}>
        <EnTeteEcran titre="Import" />
        <Text style={styles.videTitre}>Aucun import en cours</Text>
        <Text style={styles.videTexte}>
          Scanne le code affiché par ton ordinateur pour voir ce qu'il propose.
        </Text>
        <Bouton titre="Fermer" variante="fantome" onPress={() => router.back()} />
      </View>
    );
  }

  const { manifeste, code } = session;
  const rienAFaire = bilan.nouveaux.length === 0;
  // La maquette annonce une durée totale : on ne l'affiche que si le bureau
  // annonce vraiment des durées (sinon « — » n'apprendrait rien).
  const dureeTotale = bilan.nouveaux.reduce((total, piste) => total + (piste.duree || 0), 0);

  return (
    <View style={styles.porte}>
      <View style={styles.voile} />
      <View style={[styles.feuille, { paddingBottom: insets.bottom + space.lg }]}>
        <View style={styles.poignee} />
        <ScrollView contentContainerStyle={styles.contenu} showsVerticalScrollIndicator={false}>
          <Text style={styles.titre}>{manifeste.playlist}</Text>
          <Text style={styles.sousTitre}>
            Code lu depuis {code.base.replace(/^https?:\/\//, "")}
          </Text>

          <View style={styles.bloc}>
            <Ligne gauche="Nouveaux titres à récupérer" droite={String(bilan.nouveaux.length)} />
            <Ligne gauche="Déjà chez toi" droite={String(bilan.dejaLa.length)} />
            <Ligne gauche="Titres à préparer" droite={String(bilan.aPreparer)} />
            {dureeTotale > 0 ? (
              <Ligne gauche="Durée totale" droite={formaterDuree(dureeTotale)} />
            ) : null}
          </View>

          {bilan.aPreparer > 0 ? (
            <Bandeau
              ton="info"
              texte="Certains titres attendent d'être lus par ton ordinateur. Le transfert démarrera au fur et à mesure."
            />
          ) : null}

          <View style={styles.interrupteur}>
            <View style={styles.interrupteurTextes}>
              <Text style={styles.interrupteurTitre}>Wi-Fi uniquement</Text>
              <Text style={styles.interrupteurDetail}>
                Le transfert attend un réseau fiable
              </Text>
            </View>
            <Switch
              value={wifi}
              onValueChange={(valeur) => void reglerWifi(valeur)}
              accessibilityLabel="Wi-Fi uniquement"
              trackColor={{ false: "rgba(255,255,255,0.18)", true: colors.primary }}
              thumbColor={colors.ink}
            />
          </View>

          {bilan.dejaLa.length > 0 ? (
            <>
              <Separateur />
              <View style={styles.dejaLaBloc}>
                <TitreSection texte="Déjà sur ce téléphone" />
                {bilan.dejaLa.slice(0, 4).map((piste) => (
                  <View key={piste.video_id} style={styles.dejaLa}>
                    <Text style={styles.dejaLaTitre} numberOfLines={1}>
                      {piste.titre}
                    </Text>
                    <Etiquette ton="done" texte="Chez toi" />
                  </View>
                ))}
                {bilan.dejaLa.length > 4 ? (
                  <Text style={styles.dejaLaSuite}>
                    et {bilan.dejaLa.length - 4} autres…
                  </Text>
                ) : null}
              </View>
            </>
          ) : null}

          <Bouton
            titre={
              rienAFaire
                ? "Tout est déjà là"
                : `Télécharger ${pluraliser(bilan.nouveaux.length, "titre")}`
            }
            desactive={rienAFaire}
            enCours={envoi}
            icone={<IconDownloads size={18} color={colors.onPrimary} />}
            style={styles.action}
            onPress={async () => {
              setEnvoi(true);
              try {
                await lancer();
                router.replace("/downloads");
              } catch {
                // L'enregistrement des titres a échoué : le dire, plutôt que de
                // laisser une promesse rejetée dans le vide et un écran figé.
                ouvrirDialogue({
                  titre: "Transfert non lancé",
                  message:
                    "Le transfert n'a pas pu démarrer. Réessaie, ou rescanne un code.",
                  icone: <IconAlert size={26} color="#04121f" />,
                });
              } finally {
                setEnvoi(false);
              }
            }}
          />
          <Bouton
            titre="Annuler"
            variante="discret"
            onPress={() => {
              fermer();
              router.back();
            }}
          />
        </ScrollView>
      </View>
      {dialogue}
    </View>
  );
}

const styles = StyleSheet.create({
  porte: { flex: 1, justifyContent: "flex-end" },
  voile: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  centre: { alignItems: "center", justifyContent: "center", gap: space.md, padding: space.xl },
  videTitre: { ...typo.vide, color: colors.ink },
  videTexte: { ...typo.body, color: colors.ink2, textAlign: "center" },
  feuille: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: colors.borderFort,
    paddingTop: space.md,
    maxHeight: "88%",
  },
  poignee: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.borderFort,
    marginBottom: 14,
  },
  contenu: { paddingHorizontal: space.lg, gap: space.md, paddingBottom: space.lg },
  titre: { ...typo.feuille, color: colors.ink },
  sousTitre: { ...typo.label, fontWeight: "500", color: colors.ink2, marginTop: -8 },
  bloc: { gap: 9 },
  interrupteur: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: touch.min,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: space.md,
  },
  interrupteurTextes: { flex: 1, gap: 2 },
  interrupteurTitre: { fontSize: 13.5, lineHeight: 18, fontWeight: "600", color: colors.ink },
  interrupteurDetail: { ...typo.caption, color: colors.ink2 },
  dejaLaBloc: { gap: 9 },
  dejaLa: { flexDirection: "row", alignItems: "center", gap: space.sm },
  dejaLaTitre: { ...typo.ligne, color: colors.ink, flex: 1 },
  dejaLaSuite: { ...typo.caption, color: colors.ink2 },
  action: { marginTop: space.xs },
});
