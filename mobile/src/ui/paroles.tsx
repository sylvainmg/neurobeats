/**
 * Les paroles, en feuille.
 *
 * Même promesse que sur le web : la ligne de la chanson en cours est mise en
 * avant et suit la lecture. Ce qui change, c'est le comportement hors ligne :
 * les paroles sont **copiées sur le téléphone au moment du transfert** (comme
 * les pochettes), donc le panneau reste lisible en mode avion — et le backend
 * n'est plus sollicité du tout pour un titre déjà rapatrié.
 *
 * Le défilement automatique s'arrête dès que l'utilisateur touche l'écran, et
 * ne repart qu'après un moment : sinon la feuille se rebouge toute seule sous
 * son pouce, ce qui est le pire moment pour lire des paroles.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";

import { useLecture } from "@/playback/store";
import { useApp } from "@/state/app";
import { chargerParoles, type LigneParole, type Paroles } from "@/transfer/paroles";
import { Bouton, Feuille, Separateur } from "@/ui/kit";
import { colors, space, touch, type as typo } from "@/theme/tokens";

/** Reprise du défilement auto après une interruption manuelle. */
const REPRISE_MS = 3500;

/** La ligne karaoké courante : la dernière qui a déjà commencé. */
function ligneActive(
  lignes: LigneParole[],
  position: number,
): number {
  let active = -1;
  for (let i = 0; i < lignes.length; i += 1) {
    const time = lignes[i].time;
    if (time == null || time > position) break;
    active = i;
  }
  return active;
}

/**
 * Étale des lignes sans timestamp sur la durée du titre.
 *
 * Une source « texte brut » ( Genius ) n'a pas de temps : sans répartition, la
 * feuille ne peut pas suivre la lecture. On répartit donc au prorata du nombre
 * de caractères, ce qui place chaque ligne à peu près là où elle se chante.
 */
function repartir(lignes: LigneParole[], duree: number): LigneParole[] {
  if (lignes.some((ligne) => ligne.time != null) || duree <= 0) return lignes;
  const poids = lignes.map((ligne) => Math.max(1, ligne.text.trim().length));
  const total = poids.reduce((acc, valeur) => acc + valeur, 0);
  let ecoule = 0;
  return lignes.map((ligne, i) => {
    const debut = (ecoule / total) * duree;
    ecoule += poids[i];
    return { ...ligne, time: debut };
  });
}

export function FeuilleParoles({ visible, onFermer }: { visible: boolean; onFermer: () => void }) {
  const file = useLecture((etat) => etat.file);
  const index = useLecture((etat) => etat.index);
  const position = useLecture((etat) => etat.position);
  const duree = useLecture((etat) => etat.duree);
  const piste = file[index] ?? null;
  const videoId = piste?.id ?? null;
  // L'adresse du bureau, PERSISTÉE (dernier scan valide). La session, elle, ne
  // survit pas à un redémarrage : c'est pourquoi les paroles étaient
  // « indisponibles » alors que le bureau répondait très bien.
  const base = useApp((etat) => etat.baseBureau);

  const [paroles, setParoles] = useState<Paroles | null>(null);
  const [chargement, setChargement] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [manuel, setManuel] = useState(false);

  const scrollRef = useRef<ScrollView>(null);
  const repriseRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Titre changé : on repart de zéro. Le reset se fait par CLÉ (comme le repo
  // le fait pour la feuille de playlist) plutôt que par un effet : un résultat
  // périmé ne doit jamais s'afficher sous le titre suivant, et le linter a
  // raison de refuser un setState synchrone dans un effet.
  const [cleTitre, setCleTitre] = useState(videoId ?? "");
  if (cleTitre !== (videoId ?? "")) {
    setCleTitre(videoId ?? "");
    setParoles(null);
    setErreur(null);
  }

  const charger = useMemo(
    () => async () => {
      if (!videoId || !visible) return;
      setChargement(true);
      setErreur(null);
      try {
        const resultat = await chargerParoles(
          videoId,
          base,
          piste?.titre ?? "",
          piste?.chaine ?? "",
          piste?.duree ?? 0,
        );
        setParoles(resultat);
        // Trace de rendu : distingue « rien trouvé » d'une réponse arrivée mais
        // non affichée (titres qui diffèrent, lignes vides après répartition).
        console.log(
          `[paroles-ui] ${videoId} trouve=${resultat.found} ` +
            `lignes=${resultat.lines.length} videoIdRecu=${resultat.videoId} ` +
            `base=${base ?? "nulle"}`,
        );
        // Une panne réseau n'est pas un « pas de paroles » : on distingue les
        // deux pour ne pas afficher « aucune parole trouvée » à tort.
        if (resultat.retryable) {
          setErreur("L'ordinateur n'a pas répondu.");
        } else if (!resultat.found && !resultat.instrumental) {
          setErreur(resultat.message ?? "Aucune parole trouvée pour ce titre.");
        }
      } finally {
        setChargement(false);
      }
    },
    [videoId, visible, base, piste],
  );

  // Le chargement part par un timer plutôt que directement dans l'effet : il
  // commence par écrire `chargement`, ce qu'un effet ne doit pas faire de façon
  // synchrone (le linter le signale, et un rendu en cascade est le prix).
  useEffect(() => {
    const minuterie = setTimeout(() => void charger(), 0);
    return () => clearTimeout(minuterie);
  }, [charger]);

  const lignes = useMemo(() => {
    if (!paroles?.found) return [];
    return repartir(paroles.lines, piste?.duree || duree || 0);
  }, [paroles, piste, duree]);

  // Ligne courante : un ÉTAT DÉRIVÉ, calculé au rendu. Le lecteur publie la
  // position ~4 fois par seconde ; la garder en state exigerait un effet qui
  // s'écrit à chaque tic (et un rendu en cascade), alors que le calcul est pur
  // et ne coûte qu'une boucle sur les lignes.
  const ligne = useMemo(
    () => (lignes.length === 0 ? -1 : ligneActive(lignes, position)),
    [lignes, position],
  );

  // Défilement auto : suivi de la ligne, sauf si l'utilisateur a le doigt
  // dessus. La reprise est différée — la feuille ne se rebouge pas dans la
  // seconde qui suit le geste.
  useEffect(() => {
    if (ligne < 0 || !visible) return;
    if (manuel) {
      if (repriseRef.current) clearTimeout(repriseRef.current);
      repriseRef.current = setTimeout(() => setManuel(false), REPRISE_MS);
      return;
    }
    scrollRef.current?.scrollTo({ y: Math.max(0, ligne * 46 - 140), animated: true });
  }, [ligne, visible, manuel]);

  useEffect(
    () => () => {
      if (repriseRef.current) clearTimeout(repriseRef.current);
    },
    [],
  );

  return (
    <Feuille visible={visible} onFermer={onFermer} titre="Paroles">
      <ScrollView
        ref={scrollRef}
        onScrollBeginDrag={() => setManuel(true)}
        scrollEventThrottle={32}
        contentContainerStyle={styles.contenu}
      >
        {!piste ? (
          <Text style={styles.vide}>
            Lance un titre pour voir ses paroles.
          </Text>
        ) : lignes.length > 0 ? (
          // Un titre précédent peut laisser des paroles d'un autre titre à
          // l'écran pendant la requête : on ne les montre que si elles
          // appartiennent bien au titre courant, sinon le panneau clignoterait
          // d'un texte à l'autre à chaque tick.
          paroles?.videoId === videoId ? (
            <>
              <Text style={styles.titre}>{piste.titre}</Text>
              <Text style={styles.chaine}>{piste.chaine}</Text>
              <Separateur />
              {lignes.map((parole, i) => (
                <Text
                  key={`${i}-${parole.text.slice(0, 12)}`}
                  style={[styles.ligne, i === ligne && styles.ligneActive]}
                  onPress={() => {
                    // Un appui sur une parole déplace la lecture : même contrat que
                    // sur le web, où le tap positionne.
                    void seekToParole(parole, piste.duree || duree);
                  }}
                >
                  {parole.text}
                </Text>
              ))}
              {/* La source n'est pas synchronisée (texte brut) : on le dit,
                  sinon l'utilisateur croit à un décalage réel. */}
              {!paroles?.synced ? (
                <Text style={styles.note}>
                  Paroles non synchronisées : le défilement est estimé.
                </Text>
              ) : null}
            </>
          ) : null
        ) : (
          /* Le bloc « pas de paroles » reste MONTÉ et REMPLI pendant la requête :
             seuls ses enfants changent, jamais le conteneur. Le remplacer par un
             « Chargement… » d'une ligne faisait sauter la feuille d'une
             demi-seconde à chaque « Réessayer » (règle « Layout / Content
             Jumping » : un état asynchrone reste dans le même conteneur, aux
             mêmes dimensions).

             Le bouton reste rendu dans tous les cas — il est simplement
             désactivé quand il n'a pas d'action possible. Le retirer ferait
             diminuer la hauteur du bloc ; le laisser actif ferait qu'un appui
             relance une requête déjà partie. `desactive` règle les deux d'un
             geste, et l'accessibilité le dit (l'écran lecteur ne propose plus une
             commande inerte). */
          <View style={styles.videBloc}>
            <View style={styles.videIndicateur}>
              {chargement ? <ActivityIndicator size="small" color={colors.accent} /> : null}
            </View>
            <Text style={styles.videTitre}>
              {chargement
                ? "Recherche des paroles…"
                : paroles?.instrumental
                  ? "Titre instrumental"
                  : "Paroles indisponibles"}
            </Text>
            <Text style={styles.vide}>
              {chargement
                ? " "
                : (erreur ??
                  (base
                    ? "L'ordinateur n'a trouvé aucune source pour ce titre."
                    : "Les paroles viennent de l'ordinateur. Scanne son code une fois pour qu'il sache où te les envoyer."))}
            </Text>
            <Bouton
              titre="Réessayer"
              variante="fantome"
              desactive={!erreur || chargement}
              onPress={() => void charger()}
              style={styles.reessayer}
            />
          </View>
        )}
      </ScrollView>
    </Feuille>
  );
}

/** Déplace la lecture au début de la ligne (`reader` = position en secondes). */
async function seekToParole(parole: LigneParole, duree: number): Promise<void> {
  if (parole.time == null) return;
  const cible = Math.max(0, Math.min(parole.time, Math.max(0, duree - 1)));
  const { chercher } = await import("@/playback/lecteur");
  await chercher(cible);
}

const styles = StyleSheet.create({
  contenu: { paddingBottom: space.xl, paddingTop: space.sm },
  titre: { ...typo.ligne, color: colors.ink, fontWeight: "700" },
  chaine: { ...typo.caption, color: colors.ink2, marginTop: 2 },
  // Une ligne fait ~46 pt de haut (2 lignes à 15 pt + interligne) : c'est le
  // pas du défilement automatique, calculé dans les mêmes unités.
  ligne: { ...typo.ligne, color: colors.ink3, paddingVertical: 7 },
  ligneActive: { color: colors.accent, fontWeight: "600" },
  note: { ...typo.caption, color: colors.ink3, marginTop: space.md, fontStyle: "italic" },
  videBloc: { alignItems: "center", gap: space.sm, paddingVertical: space.xl },
  videTitre: { ...typo.ligne, color: colors.ink, fontWeight: "600", textAlign: "center" },
  // La place du spinner est TOUJOURS réservée, même quand il est absent : c'est
  // elle qui ferait sauter le bloc entre « recherche » et « pas de paroles ».
  videIndicateur: { height: 16, justifyContent: "center" },
  vide: { ...typo.body, color: colors.ink2, textAlign: "center" },
  reessayer: { marginTop: space.sm, alignSelf: "center", minHeight: touch.min },
});
