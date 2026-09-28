/**
 * Racine de l'application : base locale, suivi des transferts, thème.
 *
 * Le suivi des transferts reprend au démarrage : un titre téléchargé pendant que
 * l'application était fermée doit apparaître dans la bibliothèque au retour,
 * sans que l'utilisateur ait à faire quoi que ce soit.
 */
import { Stack } from "expo-router";
import * as NavigationBar from "expo-navigation-bar";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { AppState, StyleSheet } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { libererSiInactif, preparerLecteur } from "@/playback/lecteur";
import { gestionnaire, useApp } from "@/state/app";
import { BandeauMiseAJour } from "@/update/bandeau";
import { controler } from "@/update/service";
import { colors } from "@/theme/tokens";

export default function Racine() {
  const initialiser = useApp((etat) => etat.initialiser);

  useEffect(() => {
    void initialiser();
    void preparerLecteur();
    // Verification de version en tache de fond : la cadence (24 h) est geree
    // par le service, qui peut donc etre appele sans danger a chaque demarrage.
    void controler();
    // La barre de navigation native reste sombre, thème système clair ou non :
    // l'app est en thème sombre, OneUI la peindrait en blanc sinon. « light »
    // = icônes claires sur barre sombre (même contrat visuel que Spotify, qui
    // ne suit pas non plus le thème du téléphone sur sa page d'accueil).
    NavigationBar.setStyle("light");
    return gestionnaire.demarrerLeSuivi();
  }, [initialiser]);

  // Quitter l'application ne doit pas laisser le process Android en vie pour
  // rien. Le service de lecture est un service de premier plan : il maintient le
  // process, et c'est voulu quand un titre joue (le son continue hors de
  // l'app). Quand aucun titre n'est chargé, il ne sert plus à rien — on le rend
  // au système, qui libère alors la mémoire.
  //
  // Le déclencheur est `background` et non `inactive` : `inactive` survient
  // aussi quand une feuille système (volet de notifications, boîte de dialogue)
  // recouvre l'app, et libérer sur ce simple mouvement ferait disparaître la
  // notification de lecture au moindre glissement du volet.
  useEffect(() => {
    const abonnement = AppState.addEventListener("change", (etatSuivant) => {
      if (etatSuivant === "background") libererSiInactif();
    });
    return () => abonnement.remove();
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {/*
        Une seule fois, ici : les écrans à onglets ne géraient pas la marge
        haute, leur en-tête passait donc sous la barre d'état. Le bas reste aux
        écrans, qui connaissent leur propre contenu (barre de navigation,
        lecteur plein écran).
      */}
      <SafeAreaView style={styles.racine} edges={["top", "left", "right"]}>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.canvas },
            animation: "slide_from_right",
          }}
        >
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="playlist/[id]" options={{ animation: "slide_from_right" }} />
          <Stack.Screen name="scan" options={{ animation: "fade" }} />
          <Stack.Screen
            name="import"
            options={{ presentation: "transparentModal", animation: "slide_from_bottom" }}
          />
          <Stack.Screen name="player" options={{ animation: "slide_from_bottom" }} />
        </Stack>
        <BandeauMiseAJour />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  racine: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
});
