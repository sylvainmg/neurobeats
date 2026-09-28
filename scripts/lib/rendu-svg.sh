#!/usr/bin/env bash
# Rendu d'un SVG a une taille EXACTE, pour les icones des differentes plateformes.
#
# ## Pourquoi Chrome, et pas ImageMagick
#
# Le moteur SVG d'ImageMagick ignore les `linearGradient`. Le disque sortait
# noir, sans qu'aucune erreur ne le signale : le fichier etait produit, le
# build etait vert, et l'icone etait mauvaise. Chrome rend la marque telle
# qu'elle est concue.
#
# ## Pourquoi un rendu par taille, et pas un redimensionnement
#
# Un bitmap passe par une succession d'interpolations, et chaque passage
# arrondit le contour du disque. Un lanceur, un explorateur de fichiers et une
# barre des taches redimensionnent tous ce qu'ils recoivent, donc un bitmap
# s'adoucit encore apres la livraison. Un SVG est trace a la taille demandee :
# 16 px est dessine en 16 px. C'est ce qui rend le 16 px du .ico lisible.
#
# ## Source : cette fonction
#
#   rend <taille_px> <sortie.png> <chemin.svg>
#
# Exemple :
#   rend 512 build/icon.png assets/brand/logo-neurobeats.svg

# Les sources de la marque, et le moteur qui les rend. Un seul endroit a
# changer si la marque bouge, et les deux plateformes ne peuvent pas diverger.
# Racine du depot, deduite de l'emplacement de CE fichier.
#
# `BASH_SOURCE` n'existe que dans bash. Sous zsh, un `source` laisse le tableau
# vide, `dirname` rend alors « . », et la racine tombe sur le grandparent du
# repertoire courant — `/home` au lieu du depot. Les chemins de marque sont
# alors introuvables, avec un message qui accuse le fichier de manquant alors
# qu'il est la. D'ou la detection explicite du shell.
if [ -n "${BASH_SOURCE[0]:-}" ]; then
  _source_rendu="${BASH_SOURCE[0]}"
elif [ -n "${ZSH_VERSION:-}" ]; then
  # zsh : `%x` est le chemin du fichier en cours de sourcer.
  _source_rendu="${(%):-%x}"
else
  _source_rendu="$0"
fi
RACINE_LIB="$(cd "$(dirname "$_source_rendu")/../.." && pwd)"
unset _source_rendu

SVG_MARQUE="$RACINE_LIB/assets/brand/logo-neurobeats.svg"
SVG_BARRES="$RACINE_LIB/assets/brand/logo-neurobeats-mono.svg"
SVG_FOND="$RACINE_LIB/assets/brand/logo-neurobeats-fond.svg"

# Emplacement du moteur de rendu, verifie une fois.
MOTEUR_SVG=""
moteur_svg() {
  [ -n "$MOTEUR_SVG" ] && return 0
  MOTEUR_SVG="$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)"
  if [ -z "$MOTEUR_SVG" ]; then
    echo "  ✗ aucun moteur de rendu SVG (google-chrome, chromium)" >&2
    echo "    ImageMagick ne sait pas rendre les degrades de la marque." >&2
    return 1
  fi
  return 0
}

# Dossier de travail du rendu, a nettoyer par l'appelant.
RENDU_TRAVAIL=""
rendu_preparer() {
  RENDU_TRAVAIL="$(mktemp -d)"
  trap 'rm -rf "$RENDU_TRAVAIL"' EXIT
}

# rend <taille_px> <sortie.png> <svg>
#
# Sort en erreur si le rendu n'a pas la taille demandee : un fichier vide ou
# tronque seistage ensuite tres loin de sa cause.
rend() {
  local t="$1" out="$2" svg="$3"
  local page="$RENDU_TRAVAIL/page-$t-$(basename "$svg")"

  [ -n "$RENDU_TRAVAIL" ] || rendu_preparer
  moteur_svg || return 1
  [ -f "$svg" ] || { echo "  ✗ source introuvable : $svg" >&2; return 1; }

  # Chrome affiche le SVG a la taille de la fenetre et rogne le reste. On
  # l'encapsule donc dans une page qui impose la taille, sans marge ni defilement,
  # et on laisse le fond transparent pour ne pas perdre les bords arrondis.
  #
  # La sortie porte toujours l'extension .png : Chrome deduit le format du
  # fichier de son extension, et refuse d'ecrire une image sans extension.
  {
    printf '<!doctype html><meta charset="utf-8">'
    printf '<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}'
    printf 'img{display:block;width:%spx;height:%spx}</style>' "$t" "$t"
    printf '<img src="file://%s">' "$svg"
  } > "$page.html"

  "$MOTEUR_SVG" --headless --disable-gpu --no-sandbox --hide-scrollbars \
    --screenshot="$out" --window-size="$t,$t" \
    --default-background-color=00000000 "file://$page.html" >/dev/null 2>&1

  local lu
  lu="$(identify -format "%wx%h" "$out" 2>/dev/null || true)"
  [ "$lu" = "${t}x${t}" ] || {
    echo "  ✗ rendu ${t}px echoue (obtenu : ${lu:-rien})" >&2
    return 1
  }
}
