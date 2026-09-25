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
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp } from "@/state/app";
import { IconChevronLeft, IconCodeQr, IconLampe, IconPaste } from "@/ui/icons";
import { Bandeau, Bouton, EcranVide, Feuille } from "@/ui/kit";
import { colors, radius, space, touch, type as typo } from "@/theme/tokens";

export default function Scanner() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [permission, demanderPermission, relirePermission] = useCameraPermissions();
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
      try {
        const reussi = await ouvrirDepuisCode(brut);
        if (reussi) {
          router.replace("/import");
          return;
        }
        dejaLu.current = false;
      } finally {
        // Quoi qu'il arrive (échec réseau, exception inattendue), on relâche
        // l'écran : sinon « Lecture du code… » resterait affiché pour toujours.
        setOccupe(false);
      }
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

  // Au retour sur l'écran, on relit l'état réel de la caméra : une permission
  // « une seule fois » (Android) est révoquée à la sortie de l'app, et le
  // hook ne la relirait pas de lui-même à chaque passage.
  useFocusEffect(
    useCallback(() => {
      void relirePermission();
    }, [relirePermission]),
  );

  // Une seule demande de permission en vol à la fois : sur Android, le
  // listener de résultat de ReactActivity est un slot unique — une 2e demande
  // pendant que la 1re attend écrase le listener et pend indefiniment (cas
  // observé sur S23/One UI). Le garde-fou de 6 s relâche le verrou même si le
  // dialogue système ne répond pas, et relit l'état réel pour que l'UI suive.
  const requeteEnCours = useRef(false);
  const demanderAcces = useCallback(async () => {
    if (requeteEnCours.current) return;
    requeteEnCours.current = true;
    let debloque = false;
    const relacher = () => {
      if (!debloque) {
        debloque = true;
        requeteEnCours.current = false;
      }
    };
    const gardeFou = setTimeout(() => {
      relacher();
      void relirePermission();
    }, 6000);
    try {
      await demanderPermission();
    } catch {
      // La demande peut échouer (dialogue fermé, activité en pause) : la
      // relance appartient à l'utilisateur, et l'état réel est relu au focus.
    } finally {
      clearTimeout(gardeFou);
      relacher();
    }
  }, [demanderPermission, relirePermission]);

  const messageErreur = session.phase === "erreur" ? session.message : null;
  const enLecture = session.phase === "lecture" || occupe;

  return (
    <View style={styles.porte}>
      {/* Le haut et les côtés sont gérés par le SafeAreaView racine ; le bas
          revient à l'écran, car l'app est en edge-to-edge (targetSdk 36) : la
          zone de visée, la copie et le bouton « ressaisir » descendaient sous
          la barre de gestes sur les appareils à navigation par gestes. */}
      <SafeAreaView edges={["bottom"]} style={styles.contour}>
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
                {/* Cadre de visée et texte guide : utiles seulement caméra allumée.
                    Rendus sans autorisation, ils chevauchaient le message
                    « Caméra non autorisée ». Le bouton « Ressaisir » reste
                    accessible dans l'autre cas. */}
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
                      : "Il apparaît dans « Transférer vers le téléphone », et ne vaut que 20 minutes."}
                  </Text>
                </View>
              </>
            ) : permission ? (
              <EcranVide
                titre="Caméra non autorisée"
                explication="Autorise la caméra, ou ressaisis le code que ton ordinateur affiche : la fonction reste entière dans les deux cas. Choisis « Pendant l'utilisation de l'app » pour que l'accès soit mémorisé."
                action={
                  // Le bouton n'apparaît que quand l'état est connu et refusé :
                  // pendant le GET du premier montage (permission encore nulle)
                  // on n'affiche rien, sinon le bouton clignoterait alors que
                  // l'accès est déjà accordé. Si le dialogue système est
                  // définitivement fermé (canAskAgain false), on va aux réglages.
                  <Bouton
                    titre={permission.canAskAgain === false ? "Ouvrir les réglages" : "Autoriser la caméra"}
                    onPress={() => {
                      if (permission.canAskAgain === false) {
                        void Linking.openSettings();
                      } else {
                        void demanderAcces();
                      }
                    }}
                    icone={<IconCodeQr size={18} color={colors.onPrimary} />}
                  />
                }
              />
            ) : null}

            <View style={[styles.bas, { paddingBottom: space.lg }]}>
              <Bouton
                titre="Ressaisir un code"
                variante="fantome"
                icone={<IconPaste size={17} color={colors.ink} />}
                onPress={() => {
                  // La feuille s'ouvre tout de suite ; le presse-papiers est lu
                  // en arrière-plan (la lecture peut traîner ou être refusée
                  // sur Android 13+/Samsung). La saisie manuelle reste possible
                  // dans tous les cas.
                  setColler(true);
                  void Clipboard.getStringAsync()
                    .then((contenu) => {
                      if (contenu.trim()) setSaisie(contenu.trim());
                    })
                    .catch(() => {
                      // Presse-papiers inaccessible : on garde la saisie telle quelle.
                    });
                }}
              />
            </View>
          </View>
        </View>
      </SafeAreaView>

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
  contour: { flex: 1 },
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
