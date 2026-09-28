/**
 * Bandeau de mise à jour.
 *
 * Il n'y a pas de modale ici, et c'est délibéré : l'utilisateur peut être en
 * train d'écouter, et une boîte de dialogue qui surgit par-dessus un titre est
 * exactement le comportement que la politique partagée cherche à éviter. Le
 * composant ne fait que mettre en scène la décision déjà prise par
 * `shared/update/policy.ts` — si le bruit vaut `rien` ou `silencieux`, rien ne
 * s'affiche.
 *
 * Même raison pour le repli : le second palier reste jusqu'à ce que
 * l'utilisateur tranche, puis se retire tout seul. Un bandeau laissé en place
 * finit par masquer le contenu sans que personne l'ait choisi.
 */
import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Bouton } from "@/ui/kit";
import { colors, ombre, radius, space, type as typo } from "@/theme/tokens";
import {
  etat,
  ignorer,
  reporter,
  surChangement,
  telechargerApk,
  type EtatMaj,
} from "@/update/service";

/** Délai avant repli du bandeau actionnable. */
const REPLI_MS = 12_000;

export function BandeauMiseAJour() {
  const marges = useSafeAreaInsets();
  const [etatMaj, setEtatMaj] = useState<EtatMaj>(() => etat());
  // Ce qui a été replié, sous forme de clef et non d'un booléen : un booléen
  // cacherait aussi la version suivante, qui doit au contraire se montrer. La
  // visibilité se déduit, on ne la mémorise pas.
  const [repliePour, setRepliePour] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);
  const [message, setMessage] = useState("");
  const minuterie = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => surChangement(setEtatMaj), []);

  const clef = `${etatMaj.bruit}:${etatMaj.versionDisponible ?? ""}`;

  useEffect(() => {
    if (minuterie.current) {
      clearTimeout(minuterie.current);
      minuterie.current = null;
    }
    // Seul le second palier se replie tout seul. Le premier s'efface déjà à
    // l'affichage, et une mise à jour obligatoire doit attendre la décision.
    if (etatMaj.bruit !== "proposition") return;
    minuterie.current = setTimeout(() => setRepliePour(clef), REPLI_MS);
    return () => {
      if (minuterie.current) clearTimeout(minuterie.current);
    };
  }, [clef, etatMaj.bruit]);

  const actionnable = etatMaj.bruit === "proposition" || etatMaj.bruit === "obligatoire";
  const visible =
    Boolean(etatMaj.versionDisponible) && repliePour !== clef && (actionnable || etatMaj.bruit === "information");
  if (!visible) return null;

  async function installer() {
    setOccupe(true);
    setMessage("Téléchargement de l'APK…");
    const resultat = await telechargerApk();
    setOccupe(false);
    setMessage(resultat.message);
  }

  return (
    <View style={[styles.conteneur, { paddingTop: marges.top + space.sm }]} pointerEvents="box-none">
      <View style={styles.carte} accessibilityLiveRegion="polite">
        <Text style={styles.titre}>
          {etatMaj.obligatoire
            ? "Mise à jour nécessaire"
            : `NeuroBeats ${etatMaj.versionDisponible} est disponible`}
        </Text>
        {etatMaj.notes ? (
          <Text style={styles.notes} numberOfLines={4}>
            {etatMaj.notes}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Bouton
            titre="Mettre à jour"
            variante="primaire"
            taille="petite"
            style={styles.action}
            desactive={occupe}
            enCours={occupe}
            onPress={() => void installer()}
          />
          {etatMaj.obligatoire ? null : (
            <>
              <Bouton
                titre="Plus tard"
                variante="fantome"
                taille="petite"
                style={styles.action}
                onPress={() => void reporter()}
              />
              <Bouton
                titre="Ignorer"
                variante="discret"
                taille="petite"
                style={styles.action}
                onPress={() => void ignorer()}
              />
            </>
          )}
        </View>
        {message ? <Text style={styles.message}>{message}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  conteneur: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: space.md,
    zIndex: 40,
  },
  carte: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderFort,
    padding: space.md,
    gap: space.sm,
    ...ombre.nav,
  },
  titre: { ...typo.caption, fontWeight: "700", color: colors.ink },
  notes: { ...typo.note, color: colors.ink2 },
  // Les trois boutons partagent la largeur, au lieu de s'empiler.
  //
  // `flexWrap: "wrap"` laissait filer le troisieme bouton a la rangee du
  // desous des que la largeur totale depassait celle de l'ecran — c'etait
  // regulierement le cas, et le bandeau gagnait alors une rangee pour rien.
  // `flex: 1` avec `minWidth: 0` les fait tenir sur une seule rangee : le
  // libelle, deja coupe a une ligne par `Bouton`, se tronque plutot que de
  // pousser le bouton suivant au rang inferieur.
  actions: { flexDirection: "row", gap: space.sm },
  action: { flex: 1, minWidth: 0 },
  message: { ...typo.caption, color: colors.ink3 },
});
