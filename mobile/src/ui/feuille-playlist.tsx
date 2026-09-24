/**
 * Feuille du nom d'une playlist : créer (mini-navigateur) ou renommer.
 *
 * Une seule carte fait les deux, pour que la règle soit la même au même
 * endroit : un nom non vide, sinon l'erreur apparaît sous le champ au premier
 * essai — pas au premier caractère tapé, qui décourage. L'appelant tranche
 * comment valider : l'écran ne sait pas si c'est une naissance ou un
 * changement de nom, il sait seulement annoncer un échec.
 */
import { useState, type ReactNode } from "react";
import { StyleSheet, Text, TextInput } from "react-native";

import { Bouton, Bandeau, Feuille } from "@/ui/kit";
import { IconPencil } from "@/ui/icons";
import { colors, radius, space, touch, type as typo } from "@/theme/tokens";

const LONGUEUR_MAX = 60;

export function FeuilleNouvellePlaylist({
  visible,
  onFermer,
  titre,
  valeurInitiale = "",
  libelleBouton = "Créer",
  icone,
  valider,
  apresValidation,
}: {
  visible: boolean;
  onFermer: () => void;
  titre: string;
  valeurInitiale?: string;
  libelleBouton?: string;
  /** L'emblème du duel : « + » pour une naissance, crayon pour un nom. */
  icone?: ReactNode;
  /** Rend l'appelant décidé : nom propre, puis suite au téléphone. */
  valider: (nom: string) => Promise<boolean>;
  /** Appelée quand la validation a réussi (fermer, recharger…). */
  apresValidation: () => void;
}) {
  const [nom, setNom] = useState(valeurInitiale);
  const [tentative, setTentative] = useState(false);
  const [echec, setEchec] = useState(false);
  const [enCours, setEnCours] = useState(false);

  // Chaque ouverture ouvre une feuille neuve : nom de départ, essai zéro.
  // Ajustement d'état pendant le rendu (Recommandation React) — pas un
  // effet, dont les setState synchrones font des rendus en cascade.
  const [cle, setCle] = useState(`${visible}·${valeurInitiale}`);
  if (cle !== `${visible}·${valeurInitiale}`) {
    setCle(`${visible}·${valeurInitiale}`);
    setNom(valeurInitiale);
    setTentative(false);
    setEchec(false);
    setEnCours(false);
  }

  const erreur = tentative && !nom.trim();
  const pret = nom.trim().length > 0 && !enCours;

  const soumettre = async () => {
    if (!nom.trim()) {
      setTentative(true);
      return;
    }
    setEnCours(true);
    setEchec(false);
    try {
      const ok = await valider(nom);
      if (ok) {
        apresValidation();
        return;
      }
      setEchec(true);
    } catch {
      setEchec(true);
    } finally {
      setEnCours(false);
    }
  };

  return (
    <Feuille visible={visible} onFermer={onFermer} titre={titre}>
      <TextInput
        value={nom}
        onChangeText={(texte) => {
          setNom(texte);
          if (tentative) setTentative(false);
        }}
        onBlur={() => setTentative(nom.trim().length === 0)}
        placeholder="Nom de la playlist"
        placeholderTextColor={colors.ink3}
        maxLength={LONGUEUR_MAX}
        autoFocus
        returnKeyType="done"
        blurOnSubmit={false}
        onSubmitEditing={() => void soumettre()}
        accessibilityLabel={titre}
        style={[styles.champ, erreur && styles.champErreur]}
      />
      {erreur ? (
        <Text style={styles.erreur} accessibilityRole="alert">
          Donne un nom à la playlist.
        </Text>
      ) : null}
      {echec ? (
        <Bandeau ton="bad" texte="Ce nom n'a pas pu être enregistré. Réessaie." />
      ) : null}
      <Bouton
        titre={libelleBouton}
        onPress={() => void soumettre()}
        desactive={!pret}
        enCours={enCours}
        icone={icone ?? <IconPencil size={18} color={colors.onPrimary} />}
        style={styles.bouton}
      />
    </Feuille>
  );
}

const styles = StyleSheet.create({
  champ: {
    minHeight: touch.min,
    paddingHorizontal: 14,
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.borderFort,
    color: colors.ink,
    fontSize: 14,
  },
  champErreur: { borderColor: colors.danger },
  erreur: {
    ...typo.caption,
    color: colors.danger,
    marginTop: -space.sm,
    fontWeight: "500",
  },
  bouton: { alignSelf: "stretch" },
});