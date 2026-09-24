/**
 * Permission d'afficher des notifications.
 *
 * Elle n'est pas décorative : sur Android 13 et plus, le gestionnaire de
 * téléchargements du système ne peut pas montrer sa notification de suivi si
 * l'application ne l'a pas obtenue — la promesse « tu peux quitter l'app, une
 * notification suit le transfert » tombe avec elle. La permission est déclarée
 * dans le manifeste, mais une déclaration ne suffit plus : il faut la demander.
 *
 * On la demande au moment où l'utilisateur lance un transfert, pas au
 * démarrage : une demande de permission sans rapport avec ce qu'on est en train
 * de faire se refuse par réflexe.
 */
import { PermissionsAndroid, Platform } from "react-native";

/** Vrai si l'application peut afficher des notifications. */
export async function notificationsAutorisees(): Promise<boolean> {
  if (Platform.OS !== "android" || Number(Platform.Version) < 33) return true;
  try {
    return await PermissionsAndroid.check(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    );
  } catch {
    return false;
  }
}

/** Demande la permission si elle n'est pas déjà accordée. Rend l'état final. */
export async function demanderNotifications(): Promise<boolean> {
  if (await notificationsAutorisees()) return true;
  if (Platform.OS !== "android" || Number(Platform.Version) < 33) return true;
  try {
    const reponse = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    );
    return reponse === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return false;
  }
}
