/**
 * Scanner : le geste d'entrée du produit.
 *
 * La maquette en fait un écran, pas un utilitaire : la zone de visée prend toute
 * la place restante, la copie dit quoi viser et combien de temps le code vaut,
 * la lampe est à portée, et le repli « ressaisir un code » reste dans la zone —
 * jamais en dehors, jamais caché dans un menu.
 *
 * Trois pannes sont traitées comme des cas normaux : caméra refusée, code
 * illisible, ordinateur injoignable. La première se dit dans la zone, la
 * dernière au-dessus, avec les deux gestes utiles.
 */
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp } from "@/state/app";
import { IconChevronLeft, IconCodeQr, IconLampe, IconPaste } from "@/ui/icons";
import { Bandeau, Bouton, EcranVide, Feuille } from "@/ui/kit";
import { colors, radius, space, touch, type as typo } from "@/theme/tokens";

export default function Scanner() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [permission, demanderPermission] = useCameraPermissions();
  const ouvrirDepuisCode = useApp((etat) => etat.ouvrirDepuisCode);
  const session = useApp((etat) => etat.session);
  const [coller, setColler] = useState(false);
  const [saisie, setSaisie] = useState("");
  const [occupe, setOccupe] = useState(false);
  const [lampe, setLampe] = useState(false);
  // Un QR reste dans le champ plusieurs images : on ne le lit qu'une fois.
  const dejaLu = useRef(false);

  const traiter = useCallback(
    async (brut: string) => {
      if (occupe) return;
      setOccupe(true);
      const reussi = await ouvrirDepuisCode(brut);
      setOccupe(false);
      if (reussi) {
        router.replace("/import");
        return;
      }
      dejaLu.current = false;
    },
    [occupe, ouvrirDepuisCode, router],
  );

  const surLecture = useCallback(
    ({ data }: { data: string }) => {
      if (dejaLu.current) return;
      dejaLu.current = true;
      void traiter(data);
    },
    [traiter],
  );

  const messageErreur = session.phase === "erreur" ? session.message : null;
  const enLecture = session.phase === "lecture" || occupe;

  return (
    <View style={styles.porte}>
      <View style={[styles.entete, { paddingTop: insets.top + space.sm }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Revenir à la bibliothèque"
          onPress={() => router.back()}
          style={({ pressed }) => [styles.retour, pressed && styles.retourPresse]}
        >
          <IconChevronLeft size={24} color={colors.ink} />
        </Pressable>
        <Text style={styles.enteteTitre}>Scanner le code</Text>
        <View style={styles.retour} />
      </View>

      <View style={styles.corps}>
        {messageErreur ? (
          <Bandeau
            ton="bad"
            texte={`${messageErreur} Vérifie que NeuroBeats est ouvert sur l'ordinateur, puis ressaisis le code.`}
          />
        ) : null}

        <View style={styles.cadre}>
          {permission?.granted ? (
            <>
              <CameraView
                style={StyleSheet.absoluteFill}
                facing="back"
                enableTorch={lampe}
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={enLecture ? undefined : surLecture}
                active={!enLecture}
              />
              <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
                <Defs>
                  <RadialGradient id="halo" cx="50%" cy="42%" r="60%">
                    <Stop offset="0" stopColor={colors.accent} stopOpacity="0.14" />
                    <Stop offset="0.7" stopColor={colors.accent} stopOpacity="0" />
                  </RadialGradient>
                </Defs>
                <Rect x="0" y="0" width="100%" height="100%" fill="url(#halo)" />
              </Svg>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={lampe ? "Éteindre la lampe" : "Allumer la lampe"}
                accessibilityState={{ selected: lampe }}
                onPress={() => setLampe((allumee) => !allumee)}
                style={({ pressed }) => [
                  styles.lampe,
                  lampe && styles.lampeAllumee,
                  pressed && styles.lampePressee,
                ]}
              >
                <IconLampe size={20} color={lampe ? colors.accent : colors.ink} />
              </Pressable>
            </>
          ) : (
            <EcranVide
              titre="Caméra non autorisée"
              explication="Autorise la caméra, ou ressaisis le code que ton ordinateur affiche : la fonction reste entière dans les deux cas."
              action={
                permission && !permission.granted ? (
                  <Bouton
                    titre="Autoriser la caméra"
                    onPress={() => void demanderPermission()}
                    icone={<IconCodeQr size={18} color={colors.onPrimary} />}
                  />
                ) : null
              }
            />
          )}

          <View style={styles.viseur} pointerEvents="none">
            <View style={[styles.angle, styles.hg]} />
            <View style={[styles.angle, styles.hd]} />
            <View style={[styles.angle, styles.bg]} />
            <View style={[styles.angle, styles.bd]} />
          </View>

          <View style={styles.copie} pointerEvents="none">
            <Text style={styles.copieTitre}>
              {enLecture ? "Lecture du code…" : "Vise le code de la playlist"}
            </Text>
            <Text style={styles.copieTexte}>
              {enLecture
                ? "Reste sur le même Wi-Fi que l'ordinateur."
                : "Il apparaît dans « Transférer vers le téléphone », et ne vaut que 5 minutes."}
            </Text>
          </View>

          <View style={[styles.bas, { paddingBottom: space.lg }]}>
            <Bouton
              titre="Ressaisir un code"
              variante="fantome"
              icone={<IconPaste size={17} color={colors.ink} />}
              onPress={async () => {
                const contenu = await Clipboard.getStringAsync();
                if (contenu.trim()) setSaisie(contenu.trim());
                setColler(true);
              }}
            />
          </View>
        </View>
      </View>

      <Feuille
        visible={coller}
        onFermer={() => setColler(false)}
        titre="Ressaisir le code"
        sousTitre="Colle l'adresse affichée sous le code sur ton ordinateur."
      >
        <TextInput
          value={saisie}
          onChangeText={setSaisie}
          placeholder="http://192.168.1.20:8040/t/…"
          placeholderTextColor={colors.ink3}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.champ}
          accessibilityLabel="Adresse du transfert"
        />
        <Bouton
          titre="Ouvrir l'aperçu"
          onPress={() => {
            setColler(false);
            void traiter(saisie);
          }}
        />
      </Feuille>
    </View>
  );
}

const styles = StyleSheet.create({
  porte: { flex: 1, backgroundColor: colors.canvas },
  entete: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingBottom: space.sm,
  },
  retour: {
    width: touch.min,
    height: touch.min,
    alignItems: "center",
    justifyContent: "center",
  },
  retourPresse: { opacity: 0.6 },
  enteteTitre: { ...typo.ecran, color: colors.ink },
  corps: { flex: 1, paddingHorizontal: 18, paddingBottom: space.lg, gap: space.md },
  cadre: {
    flex: 1,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderFort,
    overflow: "hidden",
    backgroundColor: "#05080c",
    justifyContent: "center",
  },
  viseur: {
    position: "absolute",
    left: "50%",
    top: "40%",
    marginLeft: -104,
    marginTop: -104,
    width: 208,
    height: 208,
  },
  angle: { position: "absolute", width: 34, height: 34, borderColor: colors.accent, borderWidth: 3 },
  hg: { top: 0, left: 0, borderRightWidth: 0, borderBottomWidth: 0, borderTopLeftRadius: 6 },
  hd: { top: 0, right: 0, borderLeftWidth: 0, borderBottomWidth: 0, borderTopRightRadius: 6 },
  bg: { bottom: 0, left: 0, borderRightWidth: 0, borderTopWidth: 0, borderBottomLeftRadius: 6 },
  bd: { bottom: 0, right: 0, borderLeftWidth: 0, borderTopWidth: 0, borderBottomRightRadius: 6 },
  copie: { position: "absolute", left: 26, right: 26, bottom: 96, alignItems: "center", gap: 6 },
  copieTitre: { fontSize: 17, lineHeight: 22, fontWeight: "700", color: colors.ink },
  copieTexte: { fontSize: 13, lineHeight: 18, fontWeight: "500", color: colors.ink2, textAlign: "center" },
  bas: { position: "absolute", left: 16, right: 16, bottom: 0 },
  lampe: {
    position: "absolute",
    right: 16,
    top: 16,
    width: 46,
    height: 46,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderFort,
    backgroundColor: "rgba(10,16,24,0.72)",
    alignItems: "center",
    justifyContent: "center",
  },
  lampeAllumee: { borderColor: "rgba(0,217,255,0.5)", backgroundColor: "rgba(0,217,255,0.16)" },
  lampePressee: { opacity: 0.7 },
  champ: {
    minHeight: touch.min,
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
    paddingHorizontal: space.md,
    color: colors.ink,
    fontSize: 15,
  },
});
