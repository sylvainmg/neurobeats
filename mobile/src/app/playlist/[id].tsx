/**
 * Détail d'une playlist : titres, lecture, import de fichiers.
 *
 * Affiche les pistes de la playlist (celles qui sont "chez toi"), permet de
 * jouer, de supprimer, et d'importer des fichiers MP3 depuis le stockage
 * (seulement pour les playlists locales, locale === 1).
 */
import { useEffect, useState } from "react";
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import * as repo from "@/db/repos";
import type { Piste } from "@/db/repos";
import { importerFichiers } from "@/library/import-mp3";
import { pluraliser } from "@/transfer/format";
import { jouer } from "@/playback/lecteur";
import { IconCloudDown, IconImport, IconPlay, IconTrash } from "@/ui/icons";
import { EcranVide, EnTeteEcran } from "@/ui/kit";
import { useDialogue } from "@/ui/dialog";
import { LigneTitre } from "@/ui/track-row";
import { colors, radius, space, type as typo } from "@/theme/tokens";

export default function PlaylistDetail(props: { route: { params: { playlist_id: string } } }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [playlist, setPlaylist] = useState<repo.Playlist | null>(null);
  const [pistes, setPistes] = useState<Piste[]>([]);
  const { ouvrir: ouvrirDialogue, element: dialogue } = useDialogue();
  const [importEnCours, setImportEnCours] = useState(false);

  const { playlist_id } = props.route.params;

  // Charger la playlist et ses pistes
  useEffect(() => {
    let actif = true;
    void (async () => {
      const p = await repo.playlistParId(playlist_id);
      if (!actif) return;
      setPlaylist(p);

      if (p) {
        const ps = await repo.listerPistesParPlaylist(playlist_id);
        if (actif) setPistes(ps);
      }
    })();
    return () => {
      actif = false;
    };
  }, [playlist_id]);

  const recharger = async () => {
    const p = await repo.playlistParId(playlist_id);
    if (p) {
      setPlaylist(p);
      const ps = await repo.listerPistesParPlaylist(playlist_id);
      setPistes(ps);
    }
  };

  /** Jouer toutes les pistes de la playlist. */
  const jouerTout = async () => {
    const file = pistes
      .filter((p) => p.etat === "chez_toi")
      .map((p) => ({
        id: p.video_id,
        titre: p.titre,
        chaine: p.chaine,
        album: p.album,
        fichier: p.fichier ?? "",
        pochette: p.pochette,
        duree: p.duree,
      }));

    if (file.length === 0) {
      ouvrirDialogue({
        titre: "Rien à écouter",
        message: "Aucun titre n'est encore sur le téléphone.",
        icone: <IconCloudDown size={26} color="#04121f" />,
      });
      return;
    }

    await jouer(file, 0);
    router.push("/player");
  };

  /** Importer des fichiers MP3 depuis le stockage. */
  const importer = async () => {
    if (!playlist) return;
    setImportEnCours(true);
    try {
      const count = await importerFichiers(playlist.playlist_id);
      await recharger();
      if (count > 0) {
        ouvrirDialogue({
          titre: "Import réussi",
          message: `${count} titre(s) importé(s).`,
        });
      }
    } catch {
      ouvrirDialogue({
        titre: "Import échoué",
        message: "Impossible d'importer les fichiers.",
      });
    } finally {
      setImportEnCours(false);
    }
  };

  /** Supprimer une piste de la playlist (et son fichier). */
  const supprimerPiste = (piste: Piste) => {
    ouvrirDialogue({
      ton: "danger",
      titre: piste.titre,
      message: "Le titre sera retiré de la playlist et du téléphone.",
      icone: <IconTrash size={26} color={colors.danger} />,
      annuler: "Annuler",
      confirmer: "Supprimer",
      surConfirmer: async () => {
        await repo.oublierLigne(piste.id);
        await recharger();
      },
    });
  };

  if (!playlist) {
    return (
      <View style={styles.porte}>
        <EnTeteEcran titre="Playlist" />
        <Text style={styles.vide}>Chargement…</Text>
      </View>
    );
  }

  const titresChezToi = pistes.filter((p) => p.etat === "chez_toi");
  const estLocale = playlist.locale === 1;

  return (
    <View style={styles.porte}>
      <EnTeteEcran
        titre={playlist.nom}
        meta={pluraliser(titresChezToi.length, "titre")}
        action={
          <>
            {/* Bouton "Tout lire" si des titres sont disponibles */}
            {titresChezToi.length > 0 && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Tout lire"
                onPress={jouerTout}
                style={styles.pill}
              >
                <IconPlay size={15} color={colors.accent} rempli />
                <Text style={styles.pillTexte}>Tout lire</Text>
              </Pressable>
            )}

            {/* Bouton "Importer" seulement pour les playlists locales */}
            {estLocale && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Importer des fichiers"
                onPress={importer}
                disabled={importEnCours}
                style={[styles.pill, styles.pillImport, importEnCours && styles.pillDisabled]}
              >
                <IconImport size={15} color={colors.accent} />
                <Text style={styles.pillTexte}>Importer</Text>
              </Pressable>
            )}
          </>
        }
      />

      <FlatList
        data={pistes}
        keyExtractor={(piste) => `${piste.playlist_id ?? "sans"}-${piste.video_id}`}
        renderItem={({ item }) => (
          <LigneTitre
            piste={item}
            onPress={() => {
              // Jouer ce titre
              const file = pistes
                .filter((p) => p.etat === "chez_toi")
                .map((p) => ({
                  id: p.video_id,
                  titre: p.titre,
                  chaine: p.chaine,
                  album: p.album,
                  fichier: p.fichier ?? "",
                  pochette: p.pochette,
                  duree: p.duree,
                }));
              const index = file.findIndex((f) => f.id === item.video_id);
              if (index >= 0) {
                void jouer(file, index);
                router.push("/player");
              }
            }}
            onLongPress={() => item.etat === "chez_toi" && supprimerPiste(item)}
          />
        )}
        contentContainerStyle={[
          styles.liste,
          { paddingBottom: space.xl + (insets.bottom || 0) },
        ]}
        ListEmptyComponent={
          <EcranVide
            titre="Playlist vide"
            explication={
              estLocale
                ? "Importe des fichiers MP3 depuis ton stockage pour commencer."
                : "Scanne le code d'une playlist de ton ordinateur pour la remplir."
            }
          />
        }
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
  vide: {
    ...typo.body,
    color: colors.ink2,
    textAlign: "center",
    marginTop: space.xl,
  },
  liste: {
    paddingHorizontal: space.md,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: 34,
    paddingHorizontal: 11,
    borderRadius: radius.pill,
    backgroundColor: colors.surface2,
  },
  pillImport: {
    backgroundColor: colors.surface2,
  },
  pillDisabled: {
    opacity: 0.5,
  },
  pillTexte: {
    ...typo.label,
    color: colors.ink,
    fontWeight: "600",
  },
});
