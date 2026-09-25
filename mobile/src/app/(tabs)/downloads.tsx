/**
 * Téléchargements : une tâche longue a son propre écran, pas un message fugace.
 *
 * La maquette en fait un écran de travail : le total chiffré en haut avec sa
 * barre qui balaie, puis une ligne par titre, chacune portant son état et ce
 * qu'il reste à faire. Un échec porte sa cause **et** son bouton, dans la ligne —
 * pas dans un menu.
 *
 * Les titres que l'ordinateur prépare ont leur propre ligne (« en préparation ») :
 * une attente qui n'apparaît nulle part est une attente qu'on croit perdue.
 */
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as repo from "@/db/repos";
import { formaterPourcent, pluraliser } from "@/transfer/format";
import { useLecture } from "@/playback/store";
import { gestionnaire, useApp, type TitreEnPreparation } from "@/state/app";
import type { Suivi } from "@/transfer/downloader";
import { useDialogue } from "@/ui/dialog";
import {
  IconAlert,
  IconClock,
  IconPause,
  IconPlay,
  IconSync,
  IconTrash,
} from "@/ui/icons";
import { Bandeau, BarreDeProgression, Bouton, EcranVide, EnTeteEcran, Etiquette, Spinner } from "@/ui/kit";
import { placeEnBas } from "@/ui/barre";
import { colors, radius, space, tabular, type as typo } from "@/theme/tokens";

type Ligne = { cle: string; suivi: Suivi } | { cle: string; preparation: TitreEnPreparation };

export default function Transferts() {
  const insets = useSafeAreaInsets();
  const mini = useLecture((etat) => etat.file.length > 0);
  const suivis = useApp((etat) => etat.suivis);
  const persistant = useApp((etat) => etat.transfertPersistantActif);
  const preparation = useApp((etat) => etat.enPreparation);
  const wifiSeul = useApp((etat) => etat.wifiUniquement);
  const notificationsAccordees = useApp((etat) => etat.notificationsAccordees);
  const [bilan, setBilan] = useState<repo.Bilan | null>(null);
  const { ouvrir: ouvrirDialogue, element: dialogue } = useDialogue();

  const recharger = useCallback(async () => {
    setBilan(await repo.bilan());
  }, []);

  // Le bilan change quand un transfert se termine : on relit à ce moment-là, en
  // plus du retour sur l'écran.
  const finis = suivis.filter((suivi) => suivi.etat === "termine").length;
  useFocusEffect(
    useCallback(() => {
      void gestionnaire.rafraichir();
      void recharger();
    }, [recharger, finis]),
  );

  const enCours = suivis.filter((suivi) => suivi.etat !== "annule" && suivi.etat !== "termine");
  /**
   * Ce qui télécharge vraiment, et ce qui attend son tour.
   *
   * Un titre terminé n'est plus « en cours » — il n'a plus rien à recevoir —, et
   * un titre en pause ou en échec non plus. Un direct, lui, attend dans la file
   * (une extraction à la fois) : il est « en attente », pas « en cours ». Le
   * chiffre annoncé dit donc exactement ce qui parle au réseau maintenant.
   */
  const actifs = enCours.filter(
    (suivi) => suivi.etat === "en_cours" || suivi.etat === "en_file",
  );
  const telechargent = actifs.filter((suivi) => suivi.etat === "en_cours");
  const attendent = actifs.length - telechargent.length;
  const recus = actifs.reduce((total, suivi) => total + suivi.recus, 0);
  const poidsTotal = actifs.reduce((total, suivi) => total + (suivi.total || 0), 0);
  const lignes: Ligne[] = [
    ...enCours.map((suivi) => ({ cle: suivi.videoId, suivi })),
    ...preparation.map((titre) => ({ cle: titre.videoId, preparation: titre })),
  ];
  // Le système le dit : une demande gardée « en attente du Wi-Fi » (ou du
  // réseau) sans un octet reçu. C'est la seule preuve honnête d'une attente de
  // réseau — un « en file » muet est le plus souvent une file qui s'ouvre, pas
  // une attente annoncée. Une attente du Wi-Fi vraie arrive aussi en « suspendu »
  // (le système a mis la demande en pause en attendant le Wi-Fi).
  const attenteReseau =
    wifiSeul &&
    enCours.some(
      (suivi) =>
        (suivi.etat === "en_file" || suivi.etat === "suspendu") &&
        suivi.recus === 0 &&
        (suivi.raison === "en attente du Wi-Fi" || suivi.raison === "en attente du réseau"),
    );

  return (
    <View style={styles.porte}>
      <EnTeteEcran titre="Téléchargements" />

      {!persistant ? (
        <View style={styles.bloc}>
          <Bandeau
            ton="attention"
            texte="Quitte l'app et les transferts s'arrêtent. Les titres déjà reçus restent disponibles."
          />
        </View>
      ) : null}

      {actifs.length > 0 ? (
        <View style={styles.bloc}>
          <View style={styles.total}>
            <View style={styles.totalHaut}>
              <Text style={styles.totalChiffre}>
                {formaterPourcent(poidsTotal > 0 ? recus / poidsTotal : 0)}
              </Text>
              {/* Ce qui parle au réseau, et ce qui fait la queue derrière : les
                  deux nombres sont vrais, aucun ne compte ce qui est arrivé. */}
              <Text style={styles.totalDetail}>
                {attendent > 0
                  ? `${pluraliser(telechargent.length, "titre")} en cours · ${pluraliser(attendent, "titre")} en attente`
                  : `${pluraliser(telechargent.length, "titre")} en cours`}
              </Text>
            </View>
            <BarreDeProgression
              fraction={poidsTotal > 0 ? recus / poidsTotal : 0}
              travail={actifs.some((s) => s.etat === "en_cours" && s.recus > 0)}
              libelle="Téléchargement de la playlist en cours"
            />
            <View style={styles.actions}>
              {!persistant ? (
                <Bouton
                  titre="Suspendre"
                  variante="fantome"
                  taille="petite"
                  icone={<IconPause size={15} color={colors.ink} rempli />}
                  onPress={() => {
                    for (const suivi of actifs) {
                      if (suivi.etat === "en_cours") void gestionnaire.pause(suivi.videoId);
                    }
                  }}
                />
              ) : null}
              <Bouton
                titre="Tout annuler"
                variante="fantome"
                taille="petite"
                onPress={() =>
                  ouvrirDialogue({
                    ton: "danger",
                    titre: "Arrêter les transferts ?",
                    message:
                      "Les transferts en cours s'arrêtent. Les titres déjà arrivés restent disponibles.",
                    icone: <IconTrash size={26} color={colors.danger} />,
                    annuler: "Continuer",
                    confirmer: "Arrêter",
                    surConfirmer: () => void useApp.getState().toutAnnulerTout(),
                  })
                }
              />
            </View>
          </View>
        </View>
      ) : null}

      {attenteReseau ? (
        <View style={styles.bloc}>
          <Bandeau
            ton="attention"
            texte="Les transferts attendent un réseau Wi-Fi et reprendront tout seuls. Pour les lancer sur ton forfait, désactive « Wi-Fi uniquement » dans les réglages."
          />
        </View>
      ) : null}

      <FlatList
        data={lignes}
        keyExtractor={(ligne) => ligne.cle}
        renderItem={({ item }) =>
          "suivi" in item ? (
            <LigneTransfert suivi={item.suivi} persistant={persistant} />
          ) : (
            <LignePreparation titre={item.preparation} />
          )
        }
        contentContainerStyle={[
          styles.liste,
          lignes.length === 0 && styles.listeVide,
          { paddingBottom: placeEnBas(insets.bottom, mini) },
        ]}
        ListEmptyComponent={
          <EcranVide
            titre={
              finis > 0 || (bilan && bilan.chez_toi > 0)
                ? "Tout est arrivé"
                : "Aucun transfert en cours"
            }
            explication={
              bilan && bilan.chez_toi > 0
                ? `${pluraliser(bilan.chez_toi, "titre")} disponibles. Écoute partout, même sans réseau.`
                : "Scanne le code affiché par ton ordinateur : l'aperçu de l'import s'ouvre ici."
            }
          />
        }
        ListFooterComponent={
          lignes.length > 0 && persistant && !notificationsAccordees ? (
            <View style={styles.bloc}>
              <Bandeau
                ton="attention"
                texte="Autorise les notifications dans les réglages du téléphone pour être prévenu de la fin du transfert."
              />
            </View>
          ) : null
        }
      />
      {dialogue}
    </View>
  );
}

/**
 * Ce que la sous-ligne annonce : l'état, la raison quand il y en a une, puis
 * l'avancement en pourcentage.
 *
 * Une demande confiée au système peut attendre longtemps sans rien dire. Quand
 * le système donne sa raison (« en attente du Wi-Fi »), on la reprend telle
 * quelle — c'est la seule explication honnête de l'immobilité. Sans raison, on
 * reste neutre (« en attente ») : une file qui s'ouvre n'est pas une attente de
 * réseau à affirmer.
 */
function detailDe(suivi: Suivi): string {
  const avance = suivi.total > 0 ? formaterPourcent(suivi.recus / suivi.total) : "";
  switch (suivi.etat) {
    case "en_file":
      return suivi.raison ?? "en attente";
    case "en_cours":
      // Une raison (publication en attente, nouvelle tentative) dit mieux ce
      // qui se passe qu'un simple pourcentage : on la montre d'abord.
      if (suivi.raison) return suivi.raison;
      return avance ? `en cours · ${avance}` : "en cours";
    case "termine":
      return "terminé";
    case "suspendu":
      if (suivi.raison) return suivi.raison;
      return avance ? `en pause · ${avance}` : "en pause";
    case "annule":
      return "arrêté";
    default:
      return suivi.raison || "échec";
  }
}

function LigneTransfert({
  suivi,
  persistant,
}: {
  suivi: Suivi;
  persistant: boolean;
}) {
  const nom = gestionnaire.titreDe(suivi.videoId);
  const fraction = suivi.total > 0 ? suivi.recus / suivi.total : 0;
  const aReprendre = suivi.etat === "suspendu" || suivi.etat === "echoue";

  const marque = {
    en_file: (
      <Etiquette ton="miss" texte="en file" icone={<IconClock size={13} color={colors.ink2} />} />
    ),
    en_cours: (
      <Etiquette
        ton="live"
        texte={fraction > 0 ? formaterPourcent(fraction) : "en cours"}
        icone={<Spinner taille={13} couleur={colors.accent} />}
      />
    ),
    termine: <Etiquette ton="done" texte="terminé" icone={<IconSync size={13} color={colors.ok} />} />,
    suspendu: (
      <Etiquette ton="part" texte="en pause" icone={<IconPause size={13} color={colors.warn} />} />
    ),
    echoue: (
      <Etiquette ton="fail" texte="échec" icone={<IconAlert size={13} color={colors.danger} />} />
    ),
    annule: (
      <Etiquette ton="miss" texte="arrêté" icone={<IconTrash size={13} color={colors.ink2} />} />
    ),
  }[suivi.etat];

  return (
    <View style={styles.ligne}>
      <View style={styles.ligneTexte}>
        <Text style={styles.ligneTitre} numberOfLines={1}>
          {nom}
        </Text>
        <Text style={styles.ligneDetail} numberOfLines={2}>
          {detailDe(suivi)}
        </Text>
      </View>
      {marque}
      {aReprendre || (persistant && suivi.etat === "en_file") ? (
        <Bouton
          titre={aReprendre && suivi.etat === "echoue" ? "Réessayer" : "Relancer"}
          variante="fantome"
          taille="petite"
          icone={<IconPlay size={14} color={colors.ink} />}
          onPress={() => void gestionnaire.reprendre(suivi.videoId)}
        />
      ) : null}
    </View>
  );
}

function LignePreparation({ titre }: { titre: TitreEnPreparation }) {
  // Une préparation abandonnée porte sa raison et son bouton : une ligne qui
  // reste « en préparation » alors que le bureau a rendu les armes ment.
  const echec = Boolean(titre.raison);
  return (
    <View style={styles.ligne}>
      <View style={styles.ligneTexte}>
        <Text style={styles.ligneTitre} numberOfLines={1}>
          {titre.titre}
        </Text>
        <Text style={styles.ligneDetail} numberOfLines={2}>
          {titre.raison ?? "ton ordinateur prépare ce titre"}
        </Text>
      </View>
      <Etiquette
        ton={echec ? "fail" : "part"}
        texte={echec ? "échec" : "en préparation"}
        icone={
          echec ? (
            <IconAlert size={13} color={colors.danger} />
          ) : (
            <IconClock size={13} color={colors.warn} />
          )
        }
      />
      {echec ? (
        <Bouton
          titre="Réessayer"
          variante="fantome"
          taille="petite"
          icone={<IconPlay size={14} color={colors.ink} />}
          onPress={() => useApp.getState().relancerPreparation(titre.videoId)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  porte: { flex: 1, backgroundColor: colors.canvas },
  bloc: { paddingHorizontal: 18, marginBottom: space.lg },
  total: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: 13,
    paddingHorizontal: 14,
    gap: 9,
  },
  totalHaut: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.md,
  },
  totalChiffre: { ...typo.chiffre, color: colors.ink, ...tabular },
  totalDetail: { ...typo.caption, color: colors.ink2, ...tabular, flexShrink: 1 },
  actions: { flexDirection: "row", gap: 10, marginTop: 3 },
  liste: { paddingTop: 0 },
  listeVide: { flexGrow: 1, justifyContent: "center" },
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
  ligneTexte: { flex: 1, gap: 2 },
  ligneTitre: { ...typo.ligne, color: colors.ink },
  ligneDetail: { ...typo.caption, color: colors.ink2, ...tabular },
});
