#!/usr/bin/env bash
# Reconstruit les icones du desktop a partir du VECTEUR de la marque.
#
# ## Ce que couvre ce script
#
#   build/icon.png   l'AppImage et le .deb Linux
#   build/icon.ico   l'installeur Windows (NSIS) et l'executable
#
# ## Pourquoi il existe
#
# La config electron-builder ne declarait aucun `.ico`. Elle laissait donc
# electron-builder convertir `build/icon.png` tout seul, a partir d'un bitmap
# 1024 recopie depuis l'ancien logo. Deux defauts, tous deux invisibles a la
# lecture du code :
#
#   - le 16 px du .ico, lui, sortait d'un redimensionnement. C'est pourtant la
#     taille que Windows affiche dans la barre des taches et dans l'explorateur,
#     donc la seule que l'utilisateur regarde vraiment.
#   - les barres du bitmap d'origine etaient des TROUS. Sur un fond clair
#     d'explorateur, elles laissaient passer le blanc : l'icone virait au bleu
#     barre de blanc. Sur la barre des taches, sombre, on ne voit rien. L'icone
#     changeait donc d'apparence selon ou on la regardait.
#
# Les barres sont ici PEINTES, comme sur le lanceur mobile : l'icone se lit
# pareil sur n'importe quel fond.
#
# ## Les logos DANS l'interface ne sont pas concernes
#
# La fenetre de l'application montre `web/assets/logo-mark.png`, via le composant
# `Logo` du web. Ce logo-la est le disque bleu, il est correct, et ce script ne
# le touche pas. Le travail ici est limite aux deux icones que le systeme
# affiche hors de l'application : celle du fichier et celle de l'installeur.
#
# Usage : bash scripts/icones-desktop.sh
set -uo pipefail

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/rendu-svg.sh
source "$RACINE/scripts/lib/rendu-svg.sh"

BUILD="$RACINE/desktop/build"
SVG="$SVG_MARQUE"

[ -f "$SVG" ] || { echo "  ✗ source introuvable : $SVG" >&2; exit 1; }
command -v convert >/dev/null || { echo "  ✗ ImageMagick requis" >&2; exit 1; }
moteur_svg || exit 1
mkdir -p "$BUILD"
rendu_preparer

# Le disque, a 512 px : electron-builder rogne lui-meme, et 512 laisse de la
# marge pour un fond d'ecran en 4K. Le PNG reste sans perte — c'est la source
# dont le .ico est tire, une compression avec perte se verrait au 16 px.
rend 512 "$BUILD/icon.png" "$SVG"
convert "$BUILD/icon.png" -define png:compression-level=9 "$BUILD/icon.png"

# Le .ico, a sept tailles. Windows choisit selon le contexte : 16 dans la barre
# des taches, 32 dans l'explorateur, 256 dans les grandes vues. Chaque taille
# est un rendu VECTORIEL a part, pas un redimensionnement du 512 — sans quoi le
# 16 serait un 512 echantillonne 32 fois, et c'est exactement la taille qui ne
# se lit plus.
TAILLES="16 24 32 48 64 128 256"
declare -a TRAMES=()
for t in $TAILLES; do
  rend "$t" "$RENDU_TRAVAIL/ico-$t.png" "$SVG"
  TRAMES+=("$RENDU_TRAVAIL/ico-$t.png")
done
convert "${TRAMES[@]}" "$BUILD/icon.ico"

echo
printf "  ✓ %-22s %sx%s  %s octets\n" "build/icon.png" \
  "$(identify -format '%w' "$BUILD/icon.png")" \
  "$(identify -format '%h' "$BUILD/icon.png")" \
  "$(stat -c%s "$BUILD/icon.png")"
printf "  ✓ %-22s %s cadres  %s octets\n" "build/icon.ico" \
  "$(identify -format '%n' "$BUILD/icon.ico[0]")" \
  "$(stat -c%s "$BUILD/icon.ico")"
echo
echo "  Tailles du .ico : $(identify -format '%wx%h ' "$BUILD/icon.ico")"
