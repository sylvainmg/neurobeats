/**
 * Les destinations : bibliothèque, transferts, navigateur, réglages.
 *
 * Le mini-lecteur vit ici, au-dessus de la barre : il appartient à la coquille de
 * l'application, pas à un écran — sinon il disparaîtrait dès qu'on change
 * d'onglet.
 *
 * `animation: "shift"` : sans lui, les onglets se remplaçaient d'un coup, sans
 * aucun raccord — le passage d'un écran à l'autre était brutal. Le décalage
 * latéral avec fondu est celui des transitions de l'application par défaut.
 */
import { Tabs, useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";

import { useApp } from "@/state/app";
import { BarreDeNavigation } from "@/ui/nav";
import { MiniLecteur } from "@/ui/mini-player";
import { colors } from "@/theme/tokens";

export default function Onglets() {
  const transferts = useApp((etat) => etat.transferts);
  const router = useRouter();

  return (
    <View style={styles.porte}>
      <Tabs
        screenOptions={{
          headerShown: false,
          sceneStyle: { backgroundColor: colors.canvas },
          animation: "shift",
        }}
        tabBar={(props) => <BarreDeNavigation {...props} transferts={transferts} />}
      >
        <Tabs.Screen name="index" options={{ title: "Bibliothèque" }} />
        <Tabs.Screen name="downloads" options={{ title: "Téléchargements" }} />
        <Tabs.Screen name="navigateur" options={{ title: "Navigateur" }} />
        <Tabs.Screen name="settings" options={{ title: "Réglages" }} />
      </Tabs>
      <MiniLecteur onOuvrir={() => router.push("/player")} />
    </View>
  );
}

const styles = StyleSheet.create({
  porte: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
});
