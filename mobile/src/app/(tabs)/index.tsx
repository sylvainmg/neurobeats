/**
 * Bibliothèque : la recherche, puis les playlists.
 *
 * La maquette range les titres sous des libellés ; ici les playlists sont la
 * structure, et les titres ne s'affichent que dans une playlist — leur vue. Ce
 * qui reste de la maquette, c'est son registre : une recherche en pilule, des
 * lignes séparées par des hairlines, une pastille d'état à droite, et le scan
 * en bouton flottant.
 *
 * Deux exceptions à « les titres vivent dans leur playlist », parce qu'elles
 * répondent à une demande explicite : la recherche les montre, et un appui long
 * permet de retirer un fichier du téléphone.
 *
 * La sélection multiple vit ici aussi, sur les playlists : un long appui entre
 * en sélection, et la suppression fait partir les fichiers avec elles. « Sans
 * playlist » n'est pas une playlist — c'est le tiroir des titres qui n'en ont
 * plus — alors elle ne se sélectionne pas et ne peut pas être supprimée.
 */
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Animated,
  BackHandler,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as repo from "@/db/repos";
import type { Piste, Playlist } from "@/db/repos";
import { retirerDuTelephone, retirerPlaylists } from "@/library/effacement";
import { resumeDePlaylist, SANS_PLAYLIST, type ResumePlaylist } from "@/library/playlists";
import { pluraliser } from "@/transfer/format";
import { jouer, jouerAleatoirement } from "@/playback/lecteur";
import { useLecture, type PisteLecture } from "@/playback/store";
import { useApp } from "@/state/app";
import { BoutonFlottant } from "@/ui/fab";
import {
  IconAleatoire,
  IconClose,
  IconCloudDown,
  IconPlay,
  IconPlus,
  IconSearch,
  IconTrash,
} from "@/ui/icons";
import { EcranVide, COURBE, EnTeteEcran, TitreSection } from "@/ui/kit";
import { useDialogue } from "@/ui/dialog";
import { FeuilleNouvellePlaylist } from "@/ui/feuille-playlist";
import { LignePlaylist } from "@/ui/playlist-row";
import { LigneTitre } from "@/ui/track-row";
import { colors, radius, space, touch, type as typo } from "@/theme/tokens";
import { placeEnBas } from "@/ui/barre";

export default function Bibliotheque() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const suivis = useApp((etat) => etat.suivis);
  const mini = useLecture((etat) => etat.file.length > 0);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const { ouvrir: ouvrirDialogue, element: dialogue } = useDialogue();
  const [sansPlaylist, setSansPlaylist] = useState<ResumePlaylist | null>(null);
  const [trouvees, setTrouvees] = useState<Piste[]>([]);
  const [bilan, setBilan] = useState<repo.Bilan>({ titres: 0, chez_toi: 0, octets: 0 });
  const [recherche, setRecherche] = useState("");
  const [pret, setPret] = useState(false);
  const [nouvelleOuverte, setNouvelleOuverte] = useState(false);
  /**
   * Hauteur du titre de section, mesurée avant l'entrée en sélection.
   *
   * C'est cette mesure que la liste reprend en montant : le champ de recherche
   * reste en place au-dessus, seul ce bloc s'efface.
   */
  const [hauteurRecherche, setHauteurRecherche] = useState(0);
  /** La hauteur du conteneur des playlists, mesurée avant l'entrée en sélection. */
  const [hauteurListe, setHauteurListe] = useState(0);
  /** Les playlists choisies par un long appui, identifiées par leur id. */
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const enSelection = selection.size > 0;
  const enRecherche = recherche.trim().length > 0;

  // L'entrée en sélection traverse l'écran d'un même geste : l'en-tête normal
  // cède la place à la barre de sélection, les coches se posent sur les lignes,
  // le bloc de recherche et le bouton flottant s'effacent. Une seule valeur
  // anime tout (0 = lecture, 1 = sélection), d'un fondu qui respecte la courbe
  // maison. Si l'utilisateur coupe les animations, on saute l'aller-retour.
  //
  // Deux drivers : opacités et déplacements partent sur le fil natif
  // (`avancee`), tandis que la repli de la recherche touche à la hauteur —
  // propriété de mise en page, réservée au fil JS (`avanceeJs`).
  const anime = useApp((etat) => etat.animations);
  const [avancee] = useState(() => new Animated.Value(0));
  const [avanceeJs] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (anime) {
      Animated.parallel([
        Animated.timing(avancee, {
          toValue: enSelection ? 1 : 0,
          duration: enSelection ? 240 : 200,
          easing: COURBE,
          useNativeDriver: true,
        }),
        Animated.timing(avanceeJs, {
          toValue: enSelection ? 1 : 0,
          duration: enSelection ? 240 : 200,
          easing: COURBE,
          useNativeDriver: false,
        }),
      ]).start();
    } else {
      avancee.setValue(enSelection ? 1 : 0);
      avanceeJs.setValue(enSelection ? 1 : 0);
    }
  }, [anime, enSelection, avancee, avanceeJs]);

  const recharger = useCallback(async () => {
    const [rangees, orphelines, total, resultats] = await Promise.all([
      repo.listerPlaylists(),
      repo.resumeSansPlaylist(),
      repo.bilan(),
      enRecherche ? repo.listerPistes(recherche) : Promise.resolve<Piste[]>([]),
    ]);
    setPlaylists(rangees);
    setSansPlaylist(orphelines);
    setBilan(total);
    setTrouvees(resultats);
    setPret(true);
  }, [recherche, enRecherche]);

  // Un transfert qui se termine change ce qu'annonce une playlist : on relit.
  const termines = suivis.filter((suivi) => suivi.etat === "termine").length;
  useFocusEffect(
    useCallback(() => {
      let actif = true;
      void (async () => {
        // Peinture immédiate : ce qu'annonce la base s'affiche sans attendre le
        // scan des fichiers (stat de chaque titre — le geste lent du retour sur
        // l'écran après un lot). « Chez toi » surcompte un instant si un fichier
        // a disparu ; la vérification en arrière-plan corrige dès qu'elle rend
        // son verdict, et on relit alors pour effacer les titres fantômes.
        await recharger();
        if (!actif) return;
        const disparus = await useApp.getState().verifierTitres();
        if (!actif) return;
        if (disparus > 0) await recharger();
      })();
      return () => {
        actif = false;
      };
    }, [recharger, termines]),
  );

  // Une fois l'écran quitté, la sélection ne doit pas survivre et ressurgir au
  // retour : on la vide dans le nettoyage du focus.
  useFocusEffect(
    useCallback(() => {
      return () => setSelection(new Set());
    }, []),
  );

  // Le bouton système referme la sélection avant l'écran : c'est le geste
  // inverse du long appui qui l'a ouverte.
  useEffect(() => {
    if (!enSelection) return;
    const abonne = BackHandler.addEventListener("hardwareBackPress", () => {
      setSelection(new Set());
      return true;
    });
    return () => abonne.remove();
  }, [enSelection]);

  const basculerSelection = (playlistId: string) => {
    setSelection((precedente) => {
      const suivante = new Set(precedente);
      if (suivante.has(playlistId)) {
        suivante.delete(playlistId);
      } else {
        suivante.add(playlistId);
      }
      return suivante;
    });
  };

  /** Une ligne par playlist, plus celle des titres qu'aucune ne réclame. */
  const groupes = useMemo(() => {
    const lignes = playlists.map((playlist) => {
      const titres = playlist.titres ?? 0;
      const chezToi = playlist.chez_toi ?? 0;
      return {
        cle: playlist.playlist_id,
        nom: playlist.nom,
        pochette: playlist.pochette ?? null,
        resume: resumeDePlaylist(titres),
        complete: titres > 0 && chezToi === titres,
        manquants: Math.max(0, titres - chezToi),
      };
    });
    if (sansPlaylist && sansPlaylist.titres > 0) {
      lignes.push({
        cle: SANS_PLAYLIST,
        nom: "Sans playlist",
        pochette: null,
        resume: resumeDePlaylist(sansPlaylist.titres),
        complete: sansPlaylist.chez_toi === sansPlaylist.titres,
        manquants: Math.max(0, sansPlaylist.titres - sansPlaylist.chez_toi),
      });
    }
    return lignes;
  }, [playlists, sansPlaylist]);

  const nomDePlaylist = useMemo(
    () => new Map(playlists.map((playlist) => [playlist.playlist_id, playlist.nom])),
    [playlists],
  );

  /** Jouer un titre trouvé en recherche : il s'écoute dans sa playlist. */
  const ecouter = async (piste: Piste) => {
    const file = (await repo.listerPistesParPlaylist(piste.playlist_id))
      .filter((element) => element.etat === "chez_toi")
      .map((element) => ({
        id: element.video_id,
        titre: element.titre,
        chaine: element.chaine,
        album: element.album,
        fichier: element.fichier ?? "",
        pochette: element.pochette,
        duree: element.duree,
      }));
    const index = file.findIndex((element) => element.id === piste.video_id);
    if (index < 0) {
      ouvrirDialogue({
        titre: "Titre pas encore transféré",
        message:
          "Ce titre n'est pas encore arrivé. Transfère-le depuis ton ordinateur pour l'écouter.",
        icone: <IconCloudDown size={26} color="#04121f" />,
      });
      return;
    }
    await jouer(file, index);
    router.push("/player");
  };

  /**
   * La file de toute la bibliothèque : chaque playlist dans l'ordre de
   * l'écran, ses titres dans leur ordre, seulement ceux déjà sur le
   * téléphone. C'est la même file que lancerait chaque playlist à la suite —
   * un seul appel au lecteur, pas d'assemblage spécial.
   *
   * « Sans playlist » en fait partie : c'est une ligne de l'écran comme une
   * autre, et sa musique est de la musique possédée. L'oublier rendait les
   * boutons menteurs — affichés au compte des titres sur le téléphone, mais
   * sans rien à jouer quand tous vivaient là.
   */
  const fileDeTouteLaBibliotheque = useCallback(async (): Promise<PisteLecture[]> => {
    const rangees = await Promise.all(
      [...playlists.map((playlist) => playlist.playlist_id), null].map((identifiant) =>
        repo.listerPistesParPlaylist(identifiant),
      ),
    );
    return rangees
      .flat()
      .filter((piste) => piste.etat === "chez_toi")
      .map((piste) => ({
        id: piste.video_id,
        titre: piste.titre,
        chaine: piste.chaine,
        album: piste.album,
        fichier: piste.fichier ?? "",
        pochette: piste.pochette,
        duree: piste.duree,
      }));
  }, [playlists]);

  /** Lecture unifiée : toute la bibliothèque dans l'ordre, ou en aléatoire. */
  const jouerTout = async (aleatoire: boolean) => {
    const file = await fileDeTouteLaBibliotheque();
    if (file.length === 0) {
      ouvrirDialogue({
        titre: "Rien à écouter",
        message:
          "Aucun titre n'est encore sur le téléphone. Transfère une playlist depuis ton ordinateur pour l'écouter.",
        icone: <IconCloudDown size={26} color="#04121f" />,
      });
      return;
    }
    if (aleatoire) await jouerAleatoirement(file, 0);
    else await jouer(file, 0);
    router.push("/player");
  };

  const retirer = (piste: Piste) => {
    ouvrirDialogue({
      ton: "danger",
      titre: piste.titre,
      message:
        "Le titre sera retiré de ton téléphone. Il restera dans sa playlist : un nouveau scan du code te le rendra.",
      icone: <IconTrash size={26} color={colors.danger} />,
      annuler: "Annuler",
      confirmer: "Retirer du téléphone",
      surConfirmer: async () => {
        await retirerDuTelephone([piste]);
        await recharger();
      },
    });
  };

  /**
   * Supprimer les playlists sélectionnées : les fichiers avec elles.
   *
   * Un confinement unique : la liste des playlists choisies s'affiche dans la
   * carte, et le bouton efface fichiers et lignes d'un coup. « Sans playlist »
   * est exclue de la sélection — ce n'est pas une playlist à supprimer.
   */
  const supprimerSelection = () => {
    const cibles = playlists.filter((playlist) => selection.has(playlist.playlist_id));
    if (cibles.length === 0) return;
    const toutesLocales = cibles.every((playlist) => playlist.locale === 1);
    ouvrirDialogue({
      ton: "danger",
      titre: `Supprimer ${pluraliser(cibles.length, "playlist")} ?`,
      message: toutesLocales
        ? "Les playlists et leurs titres (fichiers compris) seront supprimés définitivement."
        : "Les playlists et leurs titres (fichiers compris) seront retirés du téléphone. Un scan de leurs codes les fera revenir.",
      icone: <IconTrash size={26} color={colors.danger} />,
      liste: cibles.map((playlist) => ({
        libelle: playlist.nom,
        note: pluraliser(playlist.titres ?? 0, "titre"),
      })),
      annuler: "Annuler",
      confirmer: "Supprimer",
      surConfirmer: async () => {
        await retirerPlaylists(cibles.map((playlist) => playlist.playlist_id));
        setSelection(new Set());
        await recharger();
      },
    });
  };

  // La recherche vit HORS de la liste, dans le flux de l'écran.
  //
  // Elle y était en `ListHeaderComponent`, ce qui la faisait monter et descendre
  // avec le contenu : au premier caractère saisi, la liste passait des
  // playlists aux résultats, son bloc d'en-tête changeait de hauteur, et le
  // champ remontait sous le doigt — exactement le saut qu'on ne veut pas quand
  // on est en train d'écrire. Ici il ne bouge plus jamais : seule la liste en
  // dessous se substitue.
  const champRecherche = (
    <View style={styles.recherche}>
      <IconSearch size={17} color={colors.ink2} />
      <TextInput
        value={recherche}
        onChangeText={setRecherche}
        placeholder="Rechercher un titre, un artiste"
        placeholderTextColor={colors.ink3}
        style={styles.champ}
        accessibilityLabel="Rechercher un titre, un artiste"
        returnKeyType="search"
      />
    </View>
  );

  // Le titre de section change seul (« Playlists » → « Résultats ») : c'est le
  // seul élément qui a le droit de varier, l'input reste en place.
  const enTete = (
    <View style={styles.libelleLigne}>
      <TitreSection texte={enRecherche ? "Résultats" : "Playlists"} style={styles.libelle} />
      {!enRecherche ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Créer une nouvelle playlist"
          onPress={() => setNouvelleOuverte(true)}
          hitSlop={6}
          style={({ pressed }) => [styles.creer, pressed && styles.creerPresse]}
        >
          <IconPlus size={15} color={colors.accent} />
          <Text style={styles.creerTexte}>Nouvelle</Text>
        </Pressable>
      ) : null}
    </View>
  );

  return (
    <View style={styles.porte}>
      {/* L'en-tête normal cède la place à la barre de sélection : les deux
          sont superposées dans le même hôte, et l'avancée fait un fondu croisé
          (la barre glisse d'une minuscule hauteur — le geste qui « pose »
          l'état de sélection, pas un simple clignotement). */}
      <View style={styles.hoteEntetes}>
        <Animated.View
          pointerEvents={enSelection ? "none" : "auto"}
          style={{ opacity: avancee.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }}
        >
          <EnTeteEcran
            titre="Bibliothèque"
            meta={
              bilan.titres > 0 && bilan.chez_toi === 0
                ? pluraliser(bilan.titres, "titre")
                : undefined
            }
            action={
              // Les deux commandes n'existent que s'il y a quelque chose à
              // jouer : un bouton qui ne peut rien lancer est un mensonge
              // cliquable. « Chez toi » compte exactement les titres que la
              // file emporte, donc les deux s'accordent toujours.
              bilan.chez_toi > 0 ? (
                <View style={styles.lecture}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Tout lire"
                    onPress={() => void jouerTout(false)}
                    style={({ pressed }) => [styles.pillLecture, pressed && styles.pillLecturePresse]}
                  >
                    <IconPlay size={15} color={colors.accent} rempli />
                    <Text style={styles.pillLectureTexte}>Tout lire</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Lecture aléatoire"
                    onPress={() => void jouerTout(true)}
                    style={({ pressed }) => [styles.pillLecture, pressed && styles.pillLecturePresse]}
                  >
                    <IconAleatoire size={15} color={colors.accent} />
                    <Text style={styles.pillLectureTexte}>Aléatoire</Text>
                  </Pressable>
                </View>
              ) : undefined
            }
          />
        </Animated.View>
        <Animated.View
          pointerEvents={enSelection ? "auto" : "none"}
          style={[
            styles.enteteSelection,
            {
              opacity: avancee,
              transform: [
                { translateY: avancee.interpolate({ inputRange: [0, 1], outputRange: [-8, 0] }) },
              ],
            },
          ]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Annuler la sélection"
            onPress={() => setSelection(new Set())}
            style={({ pressed }) => [styles.iconeEntete, pressed && styles.iconeEntetePressee]}
          >
            <IconClose size={22} color={colors.ink} />
          </Pressable>
          <Text style={styles.compteSelection} numberOfLines={1}>
            {pluraliser(selection.size, "sélectionné")}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Supprimer la sélection"
            onPress={supprimerSelection}
            style={({ pressed }) => [styles.iconeEntete, pressed && styles.iconeEntetePressee]}
          >
            <IconTrash size={20} color={colors.danger} />
          </Pressable>
        </Animated.View>
      </View>

      {/* Le champ de recherche est HORS des deux branches de liste, dans le flux
          de l'écran : il ne peut donc pas être remonté ni redescendu quand la
          liste change de contenu. Seule la zone en dessous se substitue. */}
      <View style={styles.zoneRecherche}>{champRecherche}</View>

      {enRecherche ? (
        <FlatList
          data={trouvees}
          keyExtractor={(piste) => `${piste.playlist_id ?? "sans"}-${piste.video_id}`}
          ListHeaderComponent={enTete}
          renderItem={({ item }) => (
            <LigneTitre
              piste={item}
              secondaire={[
                item.chaine,
                nomDePlaylist.get(item.playlist_id ?? "") ?? "Sans playlist",
              ]
                .filter(Boolean)
                .join(" · ")}
              onPress={() => void ecouter(item)}
              onLongPress={() => item.etat === "chez_toi" && retirer(item)}
            />
          )}
          contentContainerStyle={[styles.liste, { paddingBottom: placeEnBas(insets.bottom, mini) }]}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <EcranVide
              titre="Aucun titre trouvé"
              explication="Aucun titre de tes playlists ne correspond à cette recherche."
            />
          }
        />
      ) : (
        <>
          {/* Le titre de section s'efface sur place quand la sélection entre.
              Le conteneur des playlists monte ensuite à sa place : un
              glissement (translateY natif) pendant que sa hauteur grandit de
              la même mesure, pour que le bas reste anclé — aucun saut de
              position, contrairement à une réorganisation de la colonne.
              Le champ de recherche reste au-dessus, intact : c'est lui qu'on
              veut garder à portée de pouce pendant qu'on sélectionne. */}
          <Animated.View
            pointerEvents={enSelection ? "none" : "auto"}
            onLayout={(e) => {
              if (hauteurRecherche === 0) setHauteurRecherche(e.nativeEvent.layout.height);
            }}
            style={{
              opacity: avancee.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
            }}
          >
            {/* L'en-tête vit même sans playlist : c'est lui qui porte le bouton
                « Nouvelle », et une bibliothèque vide n'a pas moins besoin de
                créer une playlist qu'une autre. */}
            {enTete}
          </Animated.View>
          {/* La montée se joue sur deux vues imbriquées pour garder un seul
              driver par vue : l'extérieure monte d'un glissement natif
              (translateY), l'intérieure grandit de la même mesure en JS
              (height) — le bas reste ancré et le haut ressert sur la
              recherche, qui s'efface en place au-dessus.
              La hauteur de base (hauteurListe) est re-mesurée à chaque
              layout, jamais figée : l'en-tête grandit quand les données
              arrivent (résumé chiffré), et si l'espace restant restait
              verrouillé à sa taille d'avant, le viewport s'étendait sous
              la baguette d'onglets — plus rien à défiler, et le dernier
              playlist passait sous le mini-lecteur. */}
          <Animated.View
            onLayout={(e) => setHauteurListe(e.nativeEvent.layout.height)}
            style={[
              styles.porteListe,
              {
                transform: [
                  {
                    translateY: avancee.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0, -hauteurRecherche],
                    }),
                  },
                ],
              },
            ]}
          >
            <Animated.View
              style={{
                height:
                  hauteurListe > 0
                    ? avanceeJs.interpolate({
                        inputRange: [0, 1],
                        outputRange: [hauteurListe, hauteurListe + hauteurRecherche],
                      })
                    : undefined,
              }}
            >
              <FlatList
                data={enSelection ? groupes.filter((groupe) => groupe.cle !== SANS_PLAYLIST) : groupes}
                keyExtractor={(groupe) => groupe.cle}
                style={styles.listeInterne}
          renderItem={({ item }) => (
            <LignePlaylist
              nom={item.nom}
              pochette={item.pochette}
              resume={item.resume}
              complete={item.complete}
              manquants={item.manquants}
              enSelection={enSelection}
              selectionne={selection.has(item.cle)}
              avancee={avancee}
              onPress={() =>
                enSelection
                  ? basculerSelection(item.cle)
                  : router.push(`/playlist/${item.cle}`)
              }
              onLongPress={() => {
                // Le long appui entre en sélection et choisit la ligne pressée.
                // Déjà en sélection, il continue de choisir sans la quitter.
                if (!enSelection) {
                  setSelection(new Set([item.cle]));
                } else {
                  basculerSelection(item.cle);
                }
              }}
            />
          )}
          contentContainerStyle={styles.liste}
          ListFooterComponent={
            // L'espace du bas vit dans le contenu, pas en marge de fin :
            // en pied de liste, il défile et reste visible au-dessus du
            // mini-lecteur quand la liste est longue, et offre un peu d'air
            // quand elle est courte. La marge d'un contentContainer n'était,
            // elle, atteinte qu'en fin de défilement maximum.
            <View style={{ height: placeEnBas(insets.bottom, mini) }} />
          }
          ListEmptyComponent={
            pret ? (
              <EcranVide
                titre="Aucune playlist"
                explication="Crée une playlist, ou scanne le code d'une playlist de ton ordinateur : elle arrive ici, prête à écouter partout, même sans réseau."
              />
            ) : null
          }
          />
            </Animated.View>
          </Animated.View>
        </>
      )}

      <Animated.View
        pointerEvents={enSelection ? "none" : "box-none"}
        style={[
          StyleSheet.absoluteFill,
          {
            opacity: avancee.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
          },
        ]}
      >
        <BoutonFlottant
          titre={bilan.titres > 0 ? "Scanner" : "Scanner un code"}
          onPress={() => router.push("/scan")}
        />
      </Animated.View>

      {/* Créer une playlist locale, sans quitter la bibliothèque. */}
      <FeuilleNouvellePlaylist
        visible={nouvelleOuverte}
        onFermer={() => setNouvelleOuverte(false)}
        titre="Nouvelle playlist"
        icone={<IconPlus size={18} color={colors.onPrimary} />}
        valider={async (nom) => Boolean(await useApp.getState().creerPlaylist(nom))}
        apresValidation={() => {
          setNouvelleOuverte(false);
          void recharger();
        }}
      />
      {dialogue}
    </View>
  );
}

const styles = StyleSheet.create({
  porte: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  // L'hôte garde la hauteur de l'en-tête normal (en flux) ; la barre de
  // sélection, elle, est posée dessus en absolu et se centre sur cette aire,
  // pour que le fondu croisé ne fasse pas sauter la mise en page.
  hoteEntetes: {
    position: "relative",
  },
  enteteSelection: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  iconeEntete: {
    width: touch.min,
    height: touch.min,
    alignItems: "center",
    justifyContent: "center",
  },
  iconeEntetePressee: { opacity: 0.6 },
  compteSelection: {
    flex: 1,
    ...typo.body,
    fontWeight: "700",
    color: colors.ink,
    textAlign: "center",
    marginHorizontal: space.sm,
  },
  // La zone du champ est un bloc à part entière : elle porte les marges
  // latérales de l'écran, l'espace au-dessus du champ, et l'espace qui le sépare
  // du titre de section. Cette separation est ce qui rend le champ IMMOBILE —
  // il occupe toujours la même place, quelle que soit la liste du dessous.
  zoneRecherche: { paddingHorizontal: 18, flexShrink: 0 },
  recherche: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 18,
    marginTop: space.lg,
    paddingHorizontal: 15,
    paddingVertical: 11,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  champ: {
    flex: 1,
    color: colors.ink,
    fontSize: 14,
    padding: 0,
  },
  libelle: { marginBottom: space.sm },
  libelleLigne: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
  },
  creer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: touch.min,
    paddingHorizontal: space.sm,
    borderRadius: radius.pill,
  },
  creerPresse: { opacity: 0.6 },
  creerTexte: { ...typo.section, color: colors.accent, fontWeight: "700" },
  // Les deux commandes de lecture unifiée : des pilules compactes à la place
  // du compteur de titres dans l'en-tête, discrètes tant que rien ne joue.
  lecture: { flexDirection: "row", alignItems: "center", gap: space.xs },
  pillLecture: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: 34,
    paddingHorizontal: 11,
    borderRadius: radius.pill,
    backgroundColor: colors.surface2,
  },
  pillLectureTexte: { ...typo.label, color: colors.ink, fontWeight: "600" },
  pillLecturePresse: { opacity: 0.6 },
  liste: { paddingTop: 0 },
  // Le conteneur des playlists : il monte d'un glissement quand la sélection
  // entre, la recherche s'effaçant sur place au-dessus de lui.
  // Toujours en flex:1, sans hauteur figée : l'en-tête au-dessus grandit
  // quand les données arrivent, l'espace restant doit suivre, sans quoi le
  // viewport s'étend sous la baguette et la liste perd son défilement.
  porteListe: { flex: 1 },
  listeInterne: { flex: 1 },
});
