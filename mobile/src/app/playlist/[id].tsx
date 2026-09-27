/**
 * Une playlist : ce qu'elle contient, ce qui lui manque, et ce qu'elle occupe.
 *
 * C'est ici que les titres vivent — les écrans de la maquette rangent les lignes
 * sous un libellé, et ce libellé est une playlist. L'écran répond donc aux deux
 * questions qu'une liste plate ne pouvait pas poser : « qu'est-ce qui manque, et
 * comment le récupérer » et « comment libérer la place ». La réponse change avec
 * la naissance de la playlist : une venue de l'ordinateur se complète en
 * rescanant son code, une née sur le téléphone reprend ses téléchargements —
 * ses titres manquants ont déjà un lien, pas besoin de repasser par le
 * navigateur pour les retrouver.
 *
 * Le retrait est annoncé avant d'être fait, parce qu'il efface des fichiers du
 * téléphone, copie publiée dans le dossier Musique comprise. Depuis la
 * sélection multiple, il se décline en deux issues : retirer du téléphone seul
 * (le titre reste dans la playlist) ou supprimer définitivement (le titre
 * quitte la bibliothèque). Le long appui n'ouvre plus un retrait unique : il
 * entre en sélection, où il devient possible d'agir sur plusieurs titres à la
 * fois — les retirer, ou les partager avec une autre application.
 */
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  BackHandler,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as module from "modules/downloader";

import * as repo from "@/db/repos";
import type { Piste } from "@/db/repos";
import { retirerDuTelephone, retirerPlaylist, supprimerDefinitivement } from "@/library/effacement";
import { separerPartageables } from "@/library/partage";
import { resumeDePlaylist, SANS_PLAYLIST } from "@/library/playlists";
import { pluraliser } from "@/transfer/format";
import { jouer, jouerAleatoirement } from "@/playback/lecteur";
import { useLecture } from "@/playback/store";
import { useApp } from "@/state/app";
import {
  IconAleatoire,
  IconChevronLeft,
  IconClose,
  IconCloudDown,
  IconCodeQr,
  IconNavigateur,
  IconPartage,
  IconPencil,
  IconPlay,
  IconSearch,
  IconTrash,
} from "@/ui/icons";
import { Bouton, COURBE, EcranVide } from "@/ui/kit";
import { FondClavier } from "@/ui/clavier";
import { useDialogue } from "@/ui/dialog";
import { FeuilleNouvellePlaylist } from "@/ui/feuille-playlist";
import { MiniLecteur } from "@/ui/mini-player";
import { placeSansBarre } from "@/ui/barre";
import { LigneTitre } from "@/ui/track-row";
import { Vignette } from "@/ui/vignette";
import { colors, ombre, radius, space, touch, type as typo } from "@/theme/tokens";

export default function PagePlaylist() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const mini = useLecture((etat) => etat.file.length > 0);
  const sansPlaylist = id === SANS_PLAYLIST;
  const [nom, setNom] = useState(sansPlaylist ? "Sans playlist" : "");
  /** Née sur le téléphone ? Seule une telle playlist se renomme. */
  const [locale, setLocale] = useState(0);
  /** La couverture scannée sur PC : le détail montre la même image que l'icône. */
  const [couverture, setCouverture] = useState<string | null>(null);
  const [pistes, setPistes] = useState<Piste[]>([]);
  /** Filtre local : l'UX d'une longue playlist sans quitter l'écran. */
  const [recherche, setRecherche] = useState("");
  const liste = useRef<FlatList<Piste>>(null);
  const [chargé, setChargé] = useState(false);
  const [renommer, setRenommer] = useState(false);
  const { ouvrir: ouvrirDialogue, element: dialogue } = useDialogue();

  /** Les titres choisis par un long appui, identifiés par leur videoId. */
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const enSelection = selection.size > 0;
  const selectionPistes = pistes.filter((piste) => selection.has(String(piste.id)));

  const recharger = useCallback(async () => {
    const trouvees = await repo.listerPistesParPlaylist(sansPlaylist ? null : id);
    setPistes(trouvees);
    // Un vieil import annonçait des durées sans les connaître réelles : les
    // lignes « chez toi » sans durée sont sondées une fois sur leur fichier,
    // en arrière-plan, sans jamais retarder l'affichage.
    if (trouvees.some((piste) => piste.etat === "chez_toi" && piste.duree <= 0)) {
      void useApp.getState().porterDureesManquantes();
    }
    if (!sansPlaylist) {
      const playlist = await repo.playlistParId(id);
      setNom(playlist?.nom ?? "");
      setLocale(playlist?.locale ?? 0);
      setCouverture(playlist?.pochette ?? null);
    }
    setChargé(true);
  }, [id, sansPlaylist]);

  // Une reprise télécharge en arrière-plan : la base n'est « chez toi » qu'à la
  // fin. On relit les pistes quand une livraison s'achève, sinon le bouton
  // « Reprendre » (et sa note) resterait affiché pour des titres déjà revenus.
  // Un compte d'achèvements monte, ne redescend jamais : à chaque montée on se
  // relit, même si la même tâche se termine plus d'une fois dans la session.
  useEffect(
    () =>
      useApp.subscribe((etat, precedent) => {
        if (etat.transfertsTermines !== precedent.transfertsTermines) void recharger();
      }),
    [recharger],
  );

  // Une fois l'écran quitté, la sélection ne doit pas survivre et ressurgir au
  // retour : on la vide dans le nettoyage du focus.
  useFocusEffect(
    useCallback(() => {
      void recharger();
      return () => setSelection(new Set());
    }, [recharger]),
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

  const basculerSelection = (ligne: string) => {
    setSelection((precedente) => {
      const suivante = new Set(precedente);
      if (suivante.has(ligne)) {
        suivante.delete(ligne);
      } else {
        suivante.add(ligne);
      }
      return suivante;
    });
  };

  /**
   * Supprimer la playlist : les fichiers avec elles.
   *
   * Une suppression raconte ce qui disparaît — les titres ET leur place —
   * et ce que ça signifie ensuite, qui change selon l'origine : une playlist
   * créée ici se perd pour de bon, une venue de l'ordinateur reviendra au
   * prochain scan.
   */
  const supprimer = () => {
    ouvrirDialogue({
      ton: "danger",
      titre: `Supprimer « ${nom} » ?`,
      message:
        locale === 1
          ? `La playlist et ${pluraliser(pistes.length, "titre")} (fichiers compris) seront supprimés définitivement.`
          : `La playlist et ${pluraliser(pistes.length, "titre")} (fichiers compris) seront retirés du téléphone. Un scan de son code la fera revenir.`,
      icone: <IconTrash size={26} color={colors.danger} />,
      annuler: "Annuler",
      confirmer: "Supprimer la playlist",
      surConfirmer: async () => {
        await retirerPlaylist(id);
        router.back();
      },
    });
  };

  const possedees = pistes.filter((piste) => piste.etat === "chez_toi");
  const manquants = pistes.length - possedees.length;

  const recherchePropre = recherche.trim().toLowerCase();
  const visibles = recherchePropre
    ? pistes.filter(
        (piste) =>
          piste.titre.toLowerCase().includes(recherchePropre) ||
          piste.chaine.toLowerCase().includes(recherchePropre),
      )
    : pistes;

  /** On écrit ? Alors la pochette et ses boutons s'effacent. */
  const repli = recherchePropre.length > 0;

  /**
   * Repli de la pochette et de ses boutons quand on écrit dans le filtre.
   *
   * La pochette occupe 220 px et les boutons quelques lignes de plus : ensemble
   * ils repoussent les résultats sous le clavier, si bien que l'écran de
   * recherche n'en montre aucun. On les efface donc pendant la saisie — mais par
   * une animation, pas d'un coup : le bloc s'efface en s'élevant, et la HAUTEUR
   * de l'en-tête se replie en même temps pour que les titres remontent le
   * remplir. C'est ce double mouvement — le contenu qui s'en va par le haut, la
   * liste qui monte dessous — qui rend la « montée » lisible au lieu d'un saut.
   *
   * Deux drivers, comme sur l'écran Bibliothèque : l'opacité et le glissement
   * partent sur le fil natif, la hauteur touche à la mise en page et reste sur
   * le fil JS. Si l'utilisateur coupe les animations, les deux valeurs se posent
   * d'un coup, sans détour.
   */
  const anime = useApp((etat) => etat.animations);
  const [repliJs] = useState(() => new Animated.Value(0));
  const [repliNatif] = useState(() => new Animated.Value(0));
  /** La hauteur naturelle de l'en-tête, remesurée à chaque layout pour la rejouer. */
  const [hauteurEntete, setHauteurEntete] = useState(0);
  useEffect(() => {
    if (anime) {
      Animated.parallel([
        Animated.timing(repliNatif, {
          toValue: repli ? 1 : 0,
          // Le retour est plus lent que l'aller : la pochette doit avoir le
          // temps de revenir poser la playlist à nouveau sous les yeux.
          duration: repli ? 220 : 300,
          easing: COURBE,
          useNativeDriver: true,
        }),
        Animated.timing(repliJs, {
          toValue: repli ? 1 : 0,
          duration: repli ? 220 : 300,
          easing: COURBE,
          useNativeDriver: false,
        }),
      ]).start();
    } else {
      repliNatif.setValue(repli ? 1 : 0);
      repliJs.setValue(repli ? 1 : 0);
    }
  }, [anime, repli, repliNatif, repliJs]);

  /**
   * Le relevé des rangs, figé à chaque fois que la saisie se pose.
   *
   * Une ligne ne se lève qu'une fois : lui donner l'index courant la ferait
   * remonter à chaque frappe, puisque la liste se recompose sous les doigts.
   * On photographie donc les rangs au moment où l'on arrête d'écrire (300 ms),
   * et plus rien ne bouge jusqu'à la vague suivante. La clé est le videoId :
   * stable d'un résultat à l'autre, contrairement à l'index.
   *
   * Une ligne absente du relevé ne se lève pas : c'est le cas de la playlist
   * entière, qu'on ne fait pas danser à chaque retour d'écran.
   */
  const [releve, setReleve] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    if (!repli) return;
    // Seule la frappe relance le minuteur. `visibles` est reconstruit à chaque
    // rendu — le mettre dans les dépendances remettrait le compte à zéro en
    // boucle et le relevé ne se ferait jamais ; on relit donc la liste au
    // moment où le délai expire, refermée par sa forme seule.
    const courante = visibles;
    const minuteur = setTimeout(() => {
      setReleve(Object.fromEntries(courante.map((piste, rang) => [String(piste.id), rang])));
    }, 300);
    return () => clearTimeout(minuteur);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recherche, repli]);
  // Hors recherche, aucun rang : la playlist entière ne se lève pas. La remise à
  // zéro est une DÉDUCTION (rien n'est saisi), pas un effet à déclencher — l'écrire
  // dans l'effet ci-dessus obligerait à un rendu en cascade à chaque effacement.
  const rangs = repli ? releve : null;

  // Les titres qui téléchargent tournent leur icône (voir `LigneTitre`). Le
  // live vient de `suivis`, pas de la base : la base ne passe « chez toi »
  // qu'à la fin. La comparaison porte sur le contenu des videoId, jamais sur
  // les octets reçus, sinon l'écran re-rendrait à chaque progression.
  const cleEnCours = useApp((etat) =>
    etat.suivis
      .filter((s) => s.etat === "en_cours" || s.etat === "en_file")
      .map((s) => s.videoId)
      .sort()
      .join("|"),
  );
  const enCours = new Set(cleEnCours.split("|").filter(Boolean));

  const fileDeLaPlaylist = () =>
    possedees.map((element) => ({
      id: element.video_id,
      titre: element.titre,
      chaine: element.chaine,
      album: element.album,
      fichier: element.fichier ?? "",
      pochette: element.pochette,
      duree: element.duree,
    }));

  const ecouter = async (piste: Piste) => {
    const file = fileDeLaPlaylist();
    const index = file.findIndex((element) => element.id === piste.video_id);
    if (index < 0) {
      // Une playlist née sur le téléphone sait d'où viennent ses titres
      // manquants (le lien est déjà connu) : elle reprend leur téléchargement
      // sans repasser par le navigateur.
      if (locale === 1) {
        ouvrirDialogue({
          titre: "Titre pas encore téléchargé",
          message:
            "Ce titre n'est pas téléchargé. Reprends-le directement : son lien est déjà connu.",
          icone: <IconCloudDown size={26} color="#04121f" />,
          annuler: "Annuler",
          confirmer: "Reprendre",
          surConfirmer: async () => {
            await useApp.getState().reprendreDirecte(id, piste.video_id);
          },
        });
        return;
      }
      ouvrirDialogue({
        titre: "Titre pas encore transféré",
        message:
          "Ce titre n'est pas sur le téléphone. Scanne le code de cette playlist pour l'obtenir.",
        icone: <IconCloudDown size={26} color="#04121f" />,
      });
      return;
    }
    await jouer(file, index);
    router.push("/player");
  };

  /**
   * Supprimer les titres sélectionnés, décliné en deux issues.
   *
   * La carte pose les questions d'un retrait : garder le titre dans la playlist
   * (on n'efface que le fichier, la couverture reste) ou le faire disparaître
   * aussi de la bibliothèque, image comprise. Quand plus rien n'est sur le
   * téléphone, seule la seconde reste. Le choix est écrit avant l'acte, jamais
   * « à côté » — une suppression ne s'évapore pas d'un tap involontaire.
   */
  const supprimerSelection = () => {
    const cibles = selectionPistes;
    // Les titres déjà retirés du téléphone n'ont plus de fichier à effacer :
    // leur proposer « Retirer du téléphone » serait proposer une action vide.
    // L'option disparaît quand il ne reste rien à retirer de ce côté-là.
    const aRetirer = cibles.filter((piste) => Boolean(piste.fichier));
    ouvrirDialogue({
      ton: "danger",
      titre: `Supprimer ${pluraliser(cibles.length, "titre")} ?`,
      message: "Choisis ce que tu veux faire de ces titres.",
      icone: <IconTrash size={26} color={colors.danger} />,
      annuler: "Annuler",
      choix: [
        ...(aRetirer.length > 0
          ? [
              {
                libelle: "Retirer du téléphone",
                description: "Le fichier est effacé, le titre reste dans la playlist.",
                icone: <IconCloudDown size={20} color={colors.ink} />,
                surChoisir: async () => {
                  await retirerDuTelephone(cibles);
                  setSelection(new Set());
                  await recharger();
                },
              },
            ]
          : []),
        {
          libelle: "Supprimer définitivement",
          description: "Le fichier, le titre et sa couverture sont retirés.",
          icone: <IconTrash size={20} color={colors.danger} />,
          danger: true,
          surChoisir: async () => {
            await supprimerDefinitivement(cibles);
            setSelection(new Set());
            await recharger();
          },
        },
      ],
    });
  };

  /**
   * Partager la sélection avec une autre application.
   *
   * Seuls les titres réellement présents partent : un titre jamais transféré
   * n'a rien à envoyer, et « chez toi » sans fichier réel mentirait. La
   * vérification du disque est confiée au module natif ; quand des titres
   * manquent, un dialogue les liste — la notice est scrollable si elle est
   * longue — et le partage n'emporte que ce qui est là. Si tout est présent,
   * le partage s'ouvre directement, sans intermédiaire.
   */
  const partagerSelection = async () => {
    const cibles = selectionPistes;
    const uris = cibles
      .map((piste) => piste.fichier)
      .filter((fichier): fichier is string => Boolean(fichier));
    // Sans module natif (Expo Go), on ne peut pas sonder le disque : on tient
    // la base pour parole (les lignes « chez toi » ont un fichier). Avec lui,
    // `verifier` ne garde que ce qui existe vraiment.
    const presents = module.transfertPersistant
      ? new Set(await module.verifier(uris))
      : new Set(uris);
    const { partageables, indisponibles } = separerPartageables(cibles, presents);

    if (indisponibles.length === 0) {
      if (partageables.length > 0) {
        await module.partager(
          partageables.map((piste) => piste.fichier as string),
        );
      } else {
        ouvrirDialogue({
          titre: "Rien à partager",
          message: "Aucun de ces titres n'est sur le téléphone.",
          icone: <IconPartage size={26} color="#04121f" />,
        });
      }
      return;
    }

    const sommes = partageables.length > 0;
    ouvrirDialogue({
      titre: sommes
        ? `Partager ${pluraliser(partageables.length, "titre")} ?`
        : "Rien à partager",
      message: sommes
        ? "Certains titres ne sont pas sur le téléphone : seul ce qui est présent sera partagé."
        : "Aucun de ces titres n'est sur le téléphone : rien à partager.",
      icone: <IconPartage size={26} color="#04121f" />,
      liste: indisponibles.map((piste) => ({
        libelle: piste.titre,
        note: piste.chaine,
      })),
      annuler: sommes ? "Annuler" : undefined,
      confirmer: sommes ? `Partager les ${pluraliser(partageables.length, "titre")}` : undefined,
      surConfirmer: sommes
        ? async () =>
            module.partager(
              partageables.map((piste) => piste.fichier as string),
            )
        : undefined,
    });
  };

  const reprendreLesManquants = async () => {
    const resultat = await useApp.getState().reprendreDirecte(id);
    if (resultat.ok) {
      // La reprise télécharge en arrière-plan : un retour immédiat évite de
      // croire que le bouton n'a rien fait (le titre n'est « chez toi » qu'à la fin).
      ouvrirDialogue({
        titre: "Reprise lancée",
        message:
          resultat.relances === 1
            ? "Le titre manquant est en train de revenir."
            : `${resultat.relances} titres manquants sont en train de revenir.`,
        icone: <IconCloudDown size={26} color="#04121f" />,
      });
      return;
    }
    if (resultat.raison !== "rien") {
      ouvrirDialogue({
        titre: "Reprise impossible",
        message: resultat.message ?? "Les titres manquants n'ont pas pu repartir.",
        icone: <IconCloudDown size={26} color="#04121f" />,
      });
    } else if (manquants > 0) {
      // L'écran montre des manquants mais la base dit le contraire ? Une tâche
      // est peut-être déjà partie pour eux : une seconde reprise serait un doublon.
      ouvrirDialogue({
        titre: "Déjà en cours",
        message: "Un téléchargement est déjà parti pour ces titres.",
        icone: <IconCloudDown size={26} color="#04121f" />,
      });
    }
  };

  if (chargé && !sansPlaylist && !nom) {
    return (
      <View style={styles.porte}>
        <View style={styles.entete}>
          <Retour onPress={() => router.back()} />
        </View>
        <EcranVide
          titre="Playlist introuvable"
          explication="Elle a été retirée du téléphone. Scanne un code sur ton ordinateur pour la récupérer."
          action={
            <Bouton
              titre="Revenir à la bibliothèque"
              variante="fantome"
              onPress={() => router.back()}
            />
          }
        />
      </View>
    );
  }

  return (
    // Le clavier ne doit pas recouvrir le champ de recherche, désormais posé
    // hors de la liste. Même règle que dans `Feuille` : `padding` sur iOS où le
    // clavier flotte par-dessus, RIEN sur Android où la fenêtre se réduit déjà
    // (ADJUST_RESIZE) et où superposer les deux faisait trembler la feuille.
    <KeyboardAvoidingView
      style={styles.porte}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {/* Le fond referme le clavier : un appui sur le vide de l'écran laisse les
          résultats à l'air, et le clavier qui les recouvrait se retire. Il est
          posé SOUS le contenu (premier enfant, remplissage absolu), donc les
          lignes, les boutons et le champ gardent la main — seuls les appuis
          sur le vide l'atteignent. */}
      <FondClavier style={styles.porte}>
      <View style={[styles.entete, { paddingTop: insets.top + space.sm }]}>
        {enSelection ? (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Annuler la sélection"
              onPress={() => setSelection(new Set())}
              style={({ pressed }) => [styles.retour, pressed && styles.retourPresse]}
            >
              <IconClose size={22} color={colors.ink} />
            </Pressable>
            <Text style={styles.compteSelection} numberOfLines={1}>
              {pluraliser(selection.size, "sélectionné")}
            </Text>
            <View style={styles.actionsSelection}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Partager la sélection"
                onPress={() => void partagerSelection()}
                style={({ pressed }) => [styles.iconeEntete, pressed && styles.retourPresse]}
              >
                <IconPartage size={20} color={colors.ink} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Supprimer la sélection"
                onPress={supprimerSelection}
                style={({ pressed }) => [styles.iconeEntete, pressed && styles.retourPresse]}
              >
                <IconTrash size={20} color={colors.danger} />
              </Pressable>
            </View>
          </>
        ) : (
          <>
            <Retour onPress={() => router.back()} />
            {!sansPlaylist && locale === 1 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Renommer la playlist"
                onPress={() => setRenommer(true)}
                style={({ pressed }) => [styles.iconeEntete, pressed && styles.retourPresse]}
              >
                <IconPencil size={20} color={colors.ink} />
              </Pressable>
            ) : null}
          </>
        )}
      </View>

      {/* Le filtre vit HORS de la liste, dans le flux de l'écran.
          Il était dans le `ListHeaderComponent` : il montait et descendait donc
          avec le contenu, et son cran de position changeait dès que le nombre
          de résultats se réduisait — le champ glissait sous le doigt en pleine
          saisie. Ici il ne peut plus bouger : seule la liste en dessous
          se substitue. La pochette et le nom restent dans l'en-tête, qui est
          l'identité de l'écran ; la recherche n'est qu'un outil.

          Le seuil est « plus d'un titre », pas « plus de trois » : une
          recherche qui n'a qu'une ligne à masquer n'apporte rien et n'occupe
          que de la place. Mais une playlist NÉE SUR LE TÉLÉPHONE commence
          souvent à un ou deux titres et grossit ensuite — dès qu'elle en a
          plus d'un, le champ doit être là, sans attendre un rechargement de
          l'écran. La condition ne dépend que du nombre de titres, jamais de
          l'origine de la playlist : une locale s'y applique exactement comme
          une scannée. */}
      {pistes.length > 1 ? (
        <View style={styles.zoneRecherche}>
          <View style={styles.recherche}>
            <IconSearch size={17} color={colors.ink2} />
            <TextInput
              value={recherche}
              onChangeText={setRecherche}
              placeholder="Rechercher dans cette playlist"
              placeholderTextColor={colors.ink3}
              style={styles.champ}
              accessibilityLabel="Rechercher dans cette playlist"
              returnKeyType="search"
            />
            {recherche ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Effacer la recherche"
                onPress={() => setRecherche("")}
                hitSlop={6}
                style={({ pressed }) => [pressed && styles.retourPresse]}
              >
                <IconClose size={17} color={colors.ink2} />
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}

      <FlatList
        ref={liste}
        data={visibles}
        keyExtractor={(piste) => String(piste.id)}
        renderItem={({ item }) => (
          <LigneTitre
            piste={item}
            onPress={() =>
              enSelection ? basculerSelection(String(item.id)) : void ecouter(item)
            }
            onLongPress={() => {
              // Le long appui entre en sélection et choisit la ligne pressée.
              // Déjà en sélection, il continue de choisir sans la quitter.
              if (!enSelection) {
                setSelection(new Set([String(item.id)]));
              } else {
                basculerSelection(String(item.id));
              }
            }}
            enCours={enCours.has(item.video_id)}
            enSelection={enSelection}
            selectionne={selection.has(String(item.id))}
            // Le rang vient d'un instantané figé au moment où la saisie s'est
            // posée, jamais de l'index courant : celui-ci change à chaque
            // frappe, et les lignes survivantes remonteraient sans cesse sous
            // le doigt pendant qu'on écrit. Le relevé repart de zéro à chaque
            // nouvelle vague, donc la position dans les résultats est toujours
            // celle qu'on a vue.
            entree={rangs?.[String(item.id)]}
          />
        )}
        contentContainerStyle={[
          styles.liste,
          { paddingBottom: placeSansBarre(insets.bottom, mini) },
        ]}
        ListHeaderComponent={
          // Le repli se joue sur deux vues imbriquées, pour un seul driver par
          // vue : l'extérieure replie la HAUTEUR (fil JS, hauteurEntete → 0),
          // l'intérieure fait disparaître le contenu (fil natif : fondu + petite
          // montée). La hauteur est remesurée à chaque layout, jamais figée : le
          // résumé chiffré arrive après les données et change la taille du bloc,
          // et une hauteur verrouillée sur sa valeur d'avant laisserait un trou
          // vide sous la pochette au retour du filtre.
          <Animated.View
            style={{
              height:
                hauteurEntete > 0
                  ? repliJs.interpolate({
                      inputRange: [0, 1],
                      outputRange: [hauteurEntete, 0],
                    })
                  : undefined,
              overflow: "hidden",
            }}
          >
            <Animated.View
              onLayout={(e) => {
                // On ne mesure que le bloc déployé : une hauteur déjà en train
                // de se replier ne doit pas devenir la nouvelle référence.
                if (!repli) setHauteurEntete(e.nativeEvent.layout.height);
              }}
              style={{
                opacity: repliNatif.interpolate({
                  inputRange: [0, 1],
                  outputRange: [1, 0],
                }),
                transform: [
                  {
                    translateY: repliNatif.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0, -14],
                    }),
                  },
                ],
              }}
            >
          <View style={styles.enteteBloc}>
              {/* L'œuvre est l'identité de la playlist : grande et centrée,
                  sans autre signe dessus — l'objet se suffit. L'état des
                  titres est dans chaque ligne, pas sur la vignette d'en-tête. */}
              <View style={styles.pochette}>
                <Vignette
                  // La même image que l'icône de la liste : la pochette de la
                  // playlist, sinon celle de son premier titre (« Sans
                  // playlist » n'a pas de playlist pour la lui donner).
                  pochette={couverture ?? pistes.find((piste) => piste.pochette)?.pochette ?? null}
                  titre={nom || "…"}
                  taille={220}
                  rayon={radius.lg}
                  tailleInitiale={40}
                />
              </View>

              <Text style={[styles.titre, styles.centre]} numberOfLines={2}>
                {nom || "…"}
              </Text>
              <Text style={[styles.resume, styles.centre]}>
                {pistes.length > 0
                  ? resumeDePlaylist(pistes.length)
                  : "Playlist vide"}
              </Text>

              <View style={styles.actions}>
                {possedees.length > 0 ? (
                  <>
                    <Bouton
                      titre="Tout lire"
                      onPress={async () => {
                        await jouer(fileDeLaPlaylist(), 0);
                        router.push("/player");
                      }}
                      icone={<IconPlay size={18} color={colors.onPrimary} rempli />}
                    />
                    <Bouton
                      titre="Aléatoire"
                      onPress={async () => {
                        await jouerAleatoirement(fileDeLaPlaylist());
                        router.push("/player");
                      }}
                      icone={<IconAleatoire size={18} color={colors.onPrimary} />}
                    />
                  </>
                ) : null}
                {/* Une playlist scannée se complète en rescanant son code ; une
                    née sur le téléphone reprend ses téléchargements directs — le
                    lien des titres manquants est déjà connu. */}
                {locale === 0 && manquants > 0 ? (
                  <Bouton
                    titre={`Récupérer ${pluraliser(manquants, "titre")}`}
                    variante="fantome"
                    onPress={() => router.push("/scan")}
                    icone={<IconCodeQr size={18} color={colors.ink} />}
                  />
                ) : null}
                {locale === 1 && manquants > 0 ? (
                  <Bouton
                    titre="Reprendre le téléchargement"
                    variante="fantome"
                    onPress={() => void reprendreLesManquants()}
                    icone={<IconCloudDown size={18} color={colors.ink} />}
                  />
                ) : null}
              </View>

              {locale === 0 && manquants > 0 ? (
                <Text style={[styles.note, styles.centre]}>
                  Scanne le code de cette playlist pour récupérer les titres manquants.
                </Text>
              ) : null}
              {locale === 1 && manquants > 0 ? (
                <Text style={[styles.note, styles.centre]}>
                  Reprends le téléchargement des titres manquants.
                </Text>
              ) : null}
            </View>
            </Animated.View>
          </Animated.View>
        }
        ListEmptyComponent={
          recherchePropre ? (
            <EcranVide
              titre="Aucun titre trouvé"
              explication="Aucun titre de cette playlist ne correspond à cette recherche."
            />
          ) : chargé ? (
            <EcranVide
              titre="Aucun titre ici"
              explication={
                locale === 1
                  ? "Cette playlist est vide pour l'instant. Télécharge un titre depuis le navigateur pour la remplir."
                  : "Cette playlist ne contient rien pour l'instant. Transfère-la depuis ton ordinateur pour la remplir."
              }
              action={
                <Bouton
                  titre={locale === 1 ? "Ouvrir le navigateur" : "Scanner un code"}
                  variante="fantome"
                  onPress={() => (locale === 1 ? router.push("/navigateur") : router.push("/scan"))}
                  icone={
                    locale === 1 ? (
                      <IconNavigateur size={18} color={colors.ink} />
                    ) : (
                      <IconCodeQr size={18} color={colors.ink} />
                    )
                  }
                />
              }
            />
          ) : null
        }
        ListFooterComponent={
          !sansPlaylist ? (
            <View style={styles.pied}>
              {/* Le retrait des titres vit dans la sélection (long appui),
                  où il peut se décliner : retirer du téléphone seul, ou
                  supprimer définitivement — pas de bouton bas. */}
              <Bouton
                titre="Supprimer la playlist"
                variante="danger"
                onPress={supprimer}
                icone={<IconTrash size={18} color={colors.danger} />}
              />
              <Text style={styles.note}>
                {locale === 1
                  ? "Fichiers compris : la suppression est définitive."
                  : "Fichiers compris. Un scan du code la ramènera."}
              </Text>
            </View>
          ) : null
        }
      />

      {/* Le mini-lecteur vit ici aussi : la vue d'une playlist est un contenu
          comme la bibliothèque, et perdre le titre en cours en changeant
          d'écran est exactement ce que le mini-lecteur existe pour éviter. */}
      <MiniLecteur onOuvrir={() => router.push("/player")} auDessusDeLaBarre={false} />
      <FeuilleNouvellePlaylist
        visible={renommer}
        onFermer={() => setRenommer(false)}
        titre="Renommer la playlist"
        valeurInitiale={nom}
        libelleBouton="Renommer"
        valider={async (nouveauNom) => useApp.getState().renommerPlaylist(id, nouveauNom)}
        apresValidation={() => {
          setRenommer(false);
          void recharger();
        }}
      />
      {dialogue}
      </FondClavier>
    </KeyboardAvoidingView>
  );
}

function Retour({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Revenir à la bibliothèque"
      onPress={onPress}
      style={({ pressed }) => [styles.retour, pressed && styles.retourPresse]}
    >
      <IconChevronLeft size={24} color={colors.ink} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  porte: { flex: 1, backgroundColor: colors.canvas },
  entete: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingBottom: space.sm,
  },
  retour: {
    width: touch.min,
    height: touch.min,
    alignItems: "center",
    justifyContent: "center",
  },
  iconeEntete: {
    width: touch.min,
    height: touch.min,
    marginLeft: "auto",
    alignItems: "center",
    justifyContent: "center",
  },
  retourPresse: { opacity: 0.6 },
  compteSelection: {
    flex: 1,
    ...typo.body,
    fontWeight: "700",
    color: colors.ink,
    textAlign: "center",
    marginHorizontal: space.sm,
  },
  actionsSelection: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  enteteBloc: { paddingHorizontal: 18, paddingBottom: space.md, gap: 10 },
  pochette: {
    alignSelf: "center",
    width: 220,
    height: 220,
    borderRadius: radius.lg,
    overflow: "hidden",
    ...ombre.pochette,
  },
  centre: { textAlign: "center" },
  // La zone du champ est un bloc à part entière : elle porte les marges
  // latérales de l'écran et l'espace qui sépare le champ de l'en-tête. C'est
  // cette séparation, et non le champ lui-même, qui garantit qu'il occupe
  // toujours la même place, quels que soient les résultats listés en dessous.
  zoneRecherche: { paddingHorizontal: space.lg, flexShrink: 0 },
  recherche: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: space.sm,
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
  titre: { ...typo.ecran, color: colors.ink },
  resume: { ...typo.caption, color: colors.ink2 },
  actions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: space.sm, marginTop: 6 },
  note: { ...typo.note, color: colors.ink2 },
  liste: { paddingTop: space.sm },
  pied: {
    padding: space.lg,
    gap: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    marginTop: space.md,
  },
});