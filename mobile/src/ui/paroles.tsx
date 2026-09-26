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
 *
 * La ligne en cours est posée AU CENTRE de la zone visible — pas en haut, comme
 * un simple suivi. C'est la position de lecture confortable (le regard n'a pas à
 * descendre pour la ligne suivante, qui entre par en bas), et c'est ce que fait
 * le karaoké du web. La réserve de bas de page vaut la moitié de la vue, pour que
 * la dernière parole puisse elle aussi atteindre le centre.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";

import { useLecture } from "@/playback/store";
import { useApp } from "@/state/app";
import { chargerParoles, type LigneParole, type Paroles } from "@/transfer/paroles";
import { Bouton, Feuille, Separateur } from "@/ui/kit";
import { colors, space, touch, type as typo } from "@/theme/tokens";

/** Reprise du défilement auto après une interruption manuelle. */
const REPRISE_MS = 3500;

/**
 * Le pas vertical d'une ligne, en points.
 *
 * Approximation, comme avant : une ligne tient sur une ou deux lignes de texte,
 * plus son remplissage vertical. Elle sert à placer la ligne chantée, donc une
 * erreur d'un point se voit à peine — et la MESURE réelle de la vue, elle, vient
 * du `onLayout` plus bas.
 */
const PAS_LIGNE = 46;

/**
 * Marge de repli tant que la vue n'est pas mesurée.
 *
 * La feuille occupe une bonne moitié de l'écran : la moitié de cette hauteur est
 * déjà une position crédible. Elle ne sert qu'au tout premier rendu, le temps que
 * le `onLayout` livre la vraie valeur.
 */
const CENTRE_REPLI = 220;

/**
 * La place prise par l'en-tête AVANT la première ligne : titre du morceau,
 * artiste, séparateur. Elle s'ajoute au cumul des hauteurs pour que la ligne 0
 * soit bien à sa vraie position — sans elle, la première ligne se placerait trop
 * haut de la hauteur de cet en-tête, et les suivantes suivraient ce décalage.
 */
const DECALAGE_ENTETE = 96;

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
  /**
   * La moitié de la hauteur visible : la réserve de bas de page.
   *
   * Elle est en state parce qu'elle entre dans le rendu (le padding du contenu),
   * contrairement à la hauteur elle-même qui n'est lue qu'au moment du
   * défilement. Une seule écriture par ouverture de feuille, donc aucun rendu en
   * boucle.
   */
  const [reserveBasse, setReserveBasse] = useState(CENTRE_REPLI);

  const scrollRef = useRef<ScrollView>(null);
  const repriseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * La hauteur visible de la zone de défilement, mesurée en REF et non en state.
   *
   * Un ref suffit parce que le calcul du défilement le lit au moment où il
   * s'exécute : le mettre en state re-rendrait le composant à chaque mesure, et
   * une re-mesure pendant un glissement déstabiliserait le geste en cours
   * (même raison que dans `EnTeteEcran`).
   */
  const hauteurVue = useRef(0);

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

  /**
   * La hauteur RÉELLE de chaque ligne, et le compteur qui la fait réagir.
   *
   * `mesuresLigne` porte la hauteur mesurée de chaque ligne (remplissage et
   * repli compris) ; `mesures` n'est qu'un compteur qui change quand une mesure
   * arrive, pour que l'effet de défilement se ré-exécute une fois le texte posé.
   * Sans lui, la première mesure arrive après le premier `scrollTo` : la ligne se
   * placerait avec des hauteurs par défaut, puis plus jamais une fois mesurée.
   */
  /**
   * Ce qui identifie le texte mesuré : le titre, puis le nombre de lignes et
   * leur contenu. Une parole rechargée ou une ligne ajoutée change cette clé,
   * donc les mesures, donc la position — le défilement se recalcule juste.
   */
  const cleMesures = `${videoId ?? ""}:${lignes.length}:${lignes[0]?.text ?? ""}`;
  /**
   * Les hauteurs mesurées, PAR TEXTE.
   *
   * Le tableau appartient au texte qu'il décrit : un nouveau titre en repart d'un
   * vierge. D'où un état qui porte la clé — le reset est une DÉDUCTION (les
   * mesures ne valent plus rien), écrite pendant le rendu, ce qui est autorisé
   * pour un état (React le gelera pour le rendu en cours) et interdit pour un
   * ref. Aucun effet, donc aucun rendu en cascade.
   */
  const [mesureTexte, setMesureTexte] = useState<{ cle: string; hauteurs: number[] }>({
    cle: cleMesures,
    hauteurs: [],
  });
  if (mesureTexte.cle !== cleMesures) {
    setMesureTexte({ cle: cleMesures, hauteurs: [] });
  }
  // Mémoïsée pour garder une identité stable tant que le texte ne change pas :
  // sans cela, les `useCallback` plus bas se recréeraient à chaque rendu, et
  // l'effet de défilement se relancerait sans fin.
  const hauteurs = useMemo(
    () => (mesureTexte.cle === cleMesures ? mesureTexte.hauteurs : []),
    [mesureTexte, cleMesures],
  );
  /**
   * La position d'une ligne dans le contenu : la somme des hauteurs de celles qui
   * la précèdent, plus le décalage de l'en-tête (titre, artiste, séparateur).
   *
   * Renvoie `null` tant qu'une seule hauteur manque — le tableau est creux le
   * temps que le texte se pose, et une somme sur des zéros ferait défiler trop
   * peu. On préfère ne pas scroller plutôt que scroller n'importe où : la ligne
   * se placera dès que la mesure sera là.
   */
  const positionLigne = useCallback(
    (index: number): number | null => {
      let total = DECALAGE_ENTETE;
      for (let i = 0; i < index; i += 1) {
        const h = hauteurs[i];
        if (h == null) return null;
        total += h;
      }
      return total;
    },
    [hauteurs],
  );
  /** La hauteur mesurée d'une ligne, ou un pas prudent si elle n'est pas venue. */
  const hauteurLigne = useCallback(
    (index: number): number => hauteurs[index] ?? PAS_LIGNE,
    [hauteurs],
  );

  // Défilement auto : suivi de la ligne, sauf si l'utilisateur a le doigt
  // dessus. La reprise est différée — la feuille ne se rebouge pas dans la
  // seconde qui suit le geste.
  //
  // La ligne chantée est posée AU CENTRE de la zone visible, pas en haut : c'est
  // là qu'on peut la lire longtemps sans que les yeux remontent, et c'est aussi
  // ce que fait le karaoké du web.
  //
  // Sa position est MESURÉE, jamais estimée. La version précédente multipliait
  // l'index par une hauteur de ligne fixe (46 pt) : les lignes qui se replient
  // sur deux lignes font plus haut que ça, l'erreur s'accumule à chaque ligne,
  // et le texte finit par scroller toujours trop loin — la ligne chantante
  // remontait au-dessus du centre, puis hors de l'écran. On cumule donc les
  // hauteurs réellement mesurées, ce qui reste juste même quand les paroles
  // sont coupées arbitrairement.
  useEffect(() => {
    if (ligne < 0 || !visible) return;
    if (manuel) {
      if (repriseRef.current) clearTimeout(repriseRef.current);
      repriseRef.current = setTimeout(() => setManuel(false), REPRISE_MS);
      return;
    }
    const haut = positionLigne(ligne);
    if (haut == null) return;
    const centre = hauteurVue.current > 0 ? hauteurVue.current / 2 : CENTRE_REPLI;
    // `y` est calculé sur la position de la ligne ; on retranche la moitié de
    // sa PROPRE hauteur pour la poser entière au centre, pas son bord.
    scrollRef.current?.scrollTo({
      y: Math.max(0, haut + (hauteurLigne(ligne) / 2) - centre),
      animated: true,
    });
  }, [ligne, visible, manuel, positionLigne, hauteurLigne]);

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
        contentContainerStyle={[styles.contenu, { paddingBottom: reserveBasse }]}
        onLayout={(e) => {
          // La hauteur visible, une fois pour toutes. C'est elle qui place la
          // ligne chantée au centre ; sans elle, le texte resterait collé en haut.
          hauteurVue.current = e.nativeEvent.layout.height;
          setReserveBasse(Math.max(space.xl, hauteurVue.current / 2));
        }}
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
                  onLayout={(e) => {
                    // La hauteur réelle de CETTE ligne, mesurée et non estimée.
                    // C'est elle qui rend le centrage exact quand une parole se
                    // replie sur deux lignes — le cas le plus courant, et celui
                    // qui faisait déraper l'ancienne position calculée.
                    const h = e.nativeEvent.layout.height;
                    if (hauteurs[i] !== h) {
                      // Un NOUVEAU tableau, jamais la même référence mutée :
                      // React ne voit un changement d'état que par son identité.
                      setMesureTexte((precedent) => {
                        if (precedent.cle !== cleMesures || precedent.hauteurs[i] === h) {
                          return precedent;
                        }
                        const copie = precedent.hauteurs.slice();
                        copie[i] = h;
                        return { cle: cleMesures, hauteurs: copie };
                      });
                    }
                  }}
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
  contenu: { paddingTop: space.sm },
  titre: { ...typo.ligne, color: colors.ink, fontWeight: "700" },
  chaine: { ...typo.caption, color: colors.ink2, marginTop: 2 },
  // Le remplissage vertical double la hauteur naturelle d'une ligne (19 pt de
  // texte) : c'est ce qui porte le pas de 46 pt mesuré plus haut, et donc
  // l'espacement que deux lignes chantées gardent entre elles.
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
