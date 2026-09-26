/**
 * Refermer le clavier en touchant le vide de l'écran.
 *
 * Un champ qui garde le clavier ouvert après la lecture force l'utilisateur à le
 * fermer lui-même — la croix du système, un retour en arrière, un geste de plus
 * qu'un simple aller-retour de champ. Sur un écran de liste, le clavier recouvre
 * les résultats qu'on vient d'obtenir : le rappel de fermeture doit être à portée
 * de n'importe où, pas caché derrière le clavier.
 *
 * Le composant ne dessine rien et n'ajoute aucune zone tactile visible : c'est un
 * `Pressable` qui remplit l'écran et rend le focus au reste. Il se place en
 * PREMIER enfant de son parent — donc sous le contenu — et les enfants qui savent
 * répondre (lignes, boutons, le champ lui-même) gardent la main : seuls les
 * appuis tombés sur le vide atteignent ce fond, ce qui est exactement ce qu'on
 * cherche. Un simple `Keyboard.dismiss()` suffit, le focus suit.
 */
import { useCallback, type ReactNode } from "react";
import { Keyboard, Pressable, StyleSheet, View, type ViewStyle } from "react-native";

export function FondClavier({
  children,
  style,
}: {
  children: ReactNode;
  style?: ViewStyle;
}) {
  const fermer = useCallback(() => {
    Keyboard.dismiss();
  }, []);

  return (
    <View style={style}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Fermer le clavier"
        onPress={fermer}
        // Le fond n'est pas une cible pour les lecteurs d'écran : c'est un geste
        // de confort, la croix système reste l'action annoncée par la plateforme.
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={StyleSheet.absoluteFill}
      />
      {children}
    </View>
  );
}
