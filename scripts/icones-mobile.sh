#!/usr/bin/env bash
# Reconstruit les images de marque du projet mobile a partir du VECTEUR.
#
# ## Ce que couvre ce script — et ce qu'il ne couvre pas
#
# Il regenere les images que Expo DECLARE dans `app.json` :
#
#   icon.png                     l'icone d'application
#   android-icon-foreground.png  la couche d'avant-plan de l'icone adaptative
#   android-icon-background.png  la couche de fond
#   android-icon-monochrome.png  la couche monochrome (teinte Android 13+)
#   logo-mark.png                le logo DANS l'interface, l'en-tete
#
# Il ne regenere PAS les `mipmap-*` du dossier `android/` : ce sont les seules
# images qu'Expo ecrase au moment du `prebuild`, donc les seules qu'il faut
# ecrire soi-meme. C'est le travail de `scripts/icones-android.sh`.
#
# ## Pourquoi les regenerer malgre tout
#
# Parce que le `prebuild` n'est jamais lance ici — le dossier `android/` est
# genere ET porte des correctifs locaux, dont la declaration `mavenLocal()` de
# l'AAR yt-dlp, qui n'existe que dans le `~/.m2` de la machine qui l'a compile.
# Un `prebuild` les effacerait et le build echouerait.
#
# Ces images-la ne sont donc pas lues par le build d'aujourd'hui. Elles le
# seraient demain, si le prebuild revenait, et elles seraient alors revenues au
# logo d'avant. Les regenerer coute cinq rendus ; les oublier coute une
# regression qui ne se verrait qu'au moment de la decouvrir.
#
# ## Le logo-mark, lui, se voit immediatement
#
# C'est le seul de ces fichiers qui s'affiche dans l'application : 28 px en
# haut de chaque ecran. Il portait encore le disque blanc d'avant, sur une
# interface sombre — la seule trace de l'ancienne marque qui restait visible.
#
# Usage : bash scripts/icones-mobile.sh
set -uo pipefail

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/rendu-svg.sh
source "$RACINE/scripts/lib/rendu-svg.sh"

IMG="$RACINE/mobile/assets/images"

for f in "$SVG_MARQUE" "$SVG_BARRES" "$SVG_FOND"; do
  [ -f "$f" ] || { echo "  ✗ source introuvable : $f" >&2; exit 1; }
done
[ -d "$IMG" ] || { echo "  ✗ dossier introuvable : $IMG" >&2; exit 1; }
command -v convert >/dev/null || { echo "  ✗ ImageMagick requis" >&2; exit 1; }
moteur_svg || exit 1
rendu_preparer

# `icone <taille> <fichier> <svg>` : rendu puis ecriture sans perte.
icone() { # taille, sortie, svg
  local t="$1" out="$2" svg="$3"
  local tmp="$RENDU_TRAVAIL/mobile-$t-$(basename "$svg")"
  rend "$t" "$tmp.png" "$svg" || return 1
  # `-strip` rend l'ecriture reproductible. Chrome inscrit un `date:timestamp`
  # dans le PNG : deux rendus identiques différaient alors sur cinq octets, et
  # relancer le script salissait l'arbre de travail pour rien.
  convert "$tmp.png" -strip -define png:compression-level=9 "$out"
  printf "  ✓ %-30s %3spx  %6s octets\n" "$(basename "$out")" "$t" \
    "$(stat -c%s "$out")"
}

# 1024 : la taille qu'Expo attend d'une icone d'application.
icone 1024 "$IMG/icon.png"                     "$SVG_MARQUE"

# 432 : la couche adaptative, le canevas que le lanceur rogne.
icone  432 "$IMG/android-icon-foreground.png"  "$SVG_BARRES"
icone  432 "$IMG/android-icon-background.png"  "$SVG_FOND"
icone  432 "$IMG/android-icon-monochrome.png"  "$SVG_BARRES"

# 128 : le logo d'interface, affiche a 28 dp. Sur un ecran a 4x cela fait 112 px
# de large ; 128 laisse la marge sans alourdir le bundle pour rien.
icone  128 "$IMG/logo-mark.png"                "$SVG_MARQUE"

echo
echo "  Ces fichiers sont GENERES : un prebuild les reecrirait a partir de"
echo "  mobile/assets/images/, ce qui est exactement la source ci-dessus."
