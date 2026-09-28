#!/usr/bin/env bash
# Reconstruit les icones du lanceur Android a partir du VECTEUR de la marque.
#
# ## Pourquoi ce script existe
#
# Les PNG de `mobile/assets/images/` ne sont PAS ce qu'Android lit. Expo les
# convertit en WebP et les repartit dans
# `mobile/android/app/src/main/res/mipmap-*/` — mais **au moment du
# `prebuild`**, pas du build. Sans `prebuild`, remplacer les PNG ne change rien :
# gradle recompile, l'APK sort, et il porte encore l'ancien logo. C'est
# exactement ce qui s'est passe une premiere fois, et rien ne le signale : le
# build est vert, l'APK s'installe, et son icone est ancienne.
#
# On ne lance pas `expo prebuild` pour autant : le dossier `android/` est
# genere ET contient des correctifs locaux (la declaration `mavenLocal()` de
# l'AAR yt-dlp, qui n'existe que dans le `~/.m2` de cette machine). Un prebuild
# les effacerait, et le build echouerait sur une dependance introuvable.
#
# ## Pourquoi un SVG, et pas le PNG de 512 px
#
# Le lanceur ne se contente pas d'afficher l'image tel quel : Android la
# redimensionne a la densite de l'ecran, et beaucoup de lanceurs l'agrandissent
# encore ensuite. Un bitmap passe donc par une succession d'interpolations, et
# chaque passage redonde le contour du disque : ce qui etait net a 512 s'adoucit
# a 48, puis s'adoucit encore quand l'icone est reagrandie. Aucun encodage ne
# rattrape ca : encoder moins fort ne restaure pas des pixels deja adoucis.
#
# Un SVG, lui, est dessine a la taille demandee : 48 px est trace en 48 px, sans
# jamais passer par un echantillonnage. La meme source sert toutes les densites.
#
# Chrome fait le rendu, et non ImageMagick : le moteur SVG d'ImageMagick ignore
# les `linearGradient`, et le disque sortait noir.
#
# ## Les trois couches, et pourquoi elles ne sont pas la meme image
#
#   background    le degrade bleu PLEIN, sur tout le canevas. Elle ne peut pas
#                 etre vide : le systeme comble alors le masque avec un carre
#                 arrondi noir, et l'icone paraissait enchassee dans un cadre
#                 sombre sur n'importe quel fond clair. Elle ne peut pas non
#                 plus etre le disque : le masque est un carre arrondi, le
#                 disque est rond, et les quatre coins seraient transparents.
#                 Un aplat plein ne laisse rien a voir — c'est le lanceur qui
#                 donne la forme, en rognant.
#   foreground    les BARRES SEULES, a 66 % — la zone sure, celle que le
#                 lanceur ne rogne pas. Peintes en bleu nuit : sur le site un
#                 trou laissait voir le fond de la page, sur un lanceur il
#                 laisserait voir le fond d'ecran, et l'icone deviendrait
#                 imprevisible — bleu vif barree de beige sur un fond beige.
#   monochrome    les memes barres, pour Android 13+ qui teinte les icones a la
#                 palette de l'utilisateur : sur une image a deux tons, la
#                 teinte l'aplatit arbitrairement et il n'en reste rien. La
#                 forme seule est ce qui survit a la teinte.
#
# Usage : bash scripts/icones-android.sh
set -uo pipefail

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# La source de verite, le moteur de rendu et la verification de taille vivent
# dans la lib partagee avec le desktop : une seule definition, deux platforms.
# shellcheck source=scripts/lib/rendu-svg.sh
source "$RACINE/scripts/lib/rendu-svg.sh"

SVG="$SVG_MARQUE"
SVG_MONO="$SVG_BARRES"
SVG_FOND="$SVG_FOND"
RES="$RACINE/mobile/android/app/src/main/res"
TRAVAIL="$(mktemp -d)"
trap 'rm -rf "$TRAVAIL"' EXIT

for f in "$SVG" "$SVG_MONO" "$SVG_FOND"; do
  [ -f "$f" ] || { echo "  ✗ source introuvable : $f" >&2; exit 1; }
done
[ -d "$RES" ] || {
  echo "  ✗ projet Android absent : $RES" >&2
  echo "    Lance d'abord un prebuild, ou verifie le chemin." >&2
  exit 1
}
command -v convert >/dev/null || { echo "  ✗ ImageMagick requis" >&2; exit 1; }
moteur_svg || exit 1
rendu_preparer

# Les cinq densites Android, et la taille de leur couche adaptative.
# Expo produit 432 px pour xxxhdpi ; les autres suivent le meme ratio.
declare -A COCHE=(
  [mdpi]=48 [hdpi]=72 [xhdpi]=96 [xxhdpi]=144 [xxxhdpi]=192
)
declare -A AVANT=(
  [mdpi]=108 [hdpi]=162 [xhdpi]=216 [xxhdpi]=324 [xxxhdpi]=432
)

# L'icone « plate » (pre-Android 8) : le meme dessin que l'adaptative, posee a
# plat. Le lanceur la masque ensuite a la forme de son choix.
#
# Elle etait le disque, alors que l'adaptative est un aplat — deux dessins
# differents pour la meme marque. `minSdk 29` rend ces deux fichiers invisibles
# sur tout appareil supporte, donc l'incoherence ne se verrait jamais. Elle est
# corrigee quand meme : le jour ou `minSdk` baisse, ou si un lanceur ancien
# lit l'icone plate, ce n'est pas une deuxieme marque qui apparait.
#
# Les barres sont a 66 %, comme dans l'adaptative, pour que les deux versions
# du dessin soit le meme dessin.
plate() { # taille, sortie_png
  local t="$1" out="$2"
  local barres="$TRAVAIL/plate-barres-$t.png"
  local d=$((t*66/100))
  rend "$t" "$TRAVAIL/plate-fond-$t.png" "$SVG_FOND"
  rend "$d" "$barres.png" "$SVG_MONO"
  convert "$TRAVAIL/plate-fond-$t.png" "$barres.png" -compose Over -composite "$out"
}

# La couche adaptative : un glyphe centre dans la zone sure, sur un canevas
# transparent de la taille de la couche.
#
# La zone sure vaut 66 % du canevas : le lanceur peut rogner le reste. On s'y
# tient exactement, et les deux couches (couleur et monochrome) sont rendues a la
# MEME taille, pour que la forme teintee se superpose a la forme en couleur.
adaptative() { # taille_canevas, svg, sortie_png
  local a="$1" svg="$2" out="$3"
  local d=$((a*66/100))
  local tmp="$TRAVAIL/d-$a-$(basename "$svg")"
  rend "$d" "$tmp.png" "$svg"
  convert "$tmp.png" -background none -gravity center -extent "${a}x${a}" "$out"
}

# WebP **sans perte**, et une seule fois.
#
# Sur une icone aussi petite que 48 px, l'encodage AVEC perte par defaut
# d'ImageMagick se voit des que le lanceur agrandit l'image. Le sans perte rend
# ici un fichier PLUS PETIT que la version avec perte, et plus net : il n'y a
# aucun compromis a faire.
#
# La source est toujours le PNG rendu, jamais un WebP deja encode. Reencoder un
# WebP avec perte pour le repasser en sans perte ne rattrape rien : ca conserve
# les artefacts du premier passage, avec le poids du deuxieme en plus.
webp() { # png, dossier, nom
  convert "$1" -define webp:lossless=true -quality 100 "$2/$3"
}

declare -i poses=0
for densite in mdpi hdpi xhdpi xxhdpi xxxhdpi; do
  dossier="$RES/mipmap-$densite"
  [ -d "$dossier" ] || { echo "  – $densite absent, ignore" >&2; continue; }
  c="${COCHE[$densite]}"
  a="${AVANT[$densite]}"
  pose="$TRAVAIL/$densite"
  mkdir -p "$pose"

  plate      "$c"             "$pose/plate.png"
  adaptative "$a" "$SVG_MONO" "$pose/avance.png"
  adaptative "$a" "$SVG_MONO" "$pose/mono.png"
  rend       "$a" "$pose/fond.png" "$SVG_FOND"

  webp "$pose/plate.png"  "$dossier" ic_launcher.webp
  webp "$pose/plate.png"  "$dossier" ic_launcher_round.webp
  webp "$pose/avance.png" "$dossier" ic_launcher_foreground.webp
  webp "$pose/mono.png"   "$dossier" ic_launcher_monochrome.webp
  webp "$pose/fond.png"   "$dossier" ic_launcher_background.webp

  poses=$((poses+1))
  printf "  ✓ mipmap-%-8s plate %3spx  adaptatif %3spx\n" "$densite" "$c" "$a"
done

echo
echo "  $poses densite(s) reecrite(s)."
echo
echo "  Ces fichiers sont GENERES : ils seront ecroutes par un prebuild."
echo "  La source de verite est assets/brand/logo-neurobeats.svg."
