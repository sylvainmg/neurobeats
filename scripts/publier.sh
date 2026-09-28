#!/usr/bin/env bash
# Publie les trois artefacts, puis le manifeste.
#
# ## Pourquoi un script
#
# L'ordre et les empreintes sont le point delicat. Le manifeste doit etre
# televerse EN DERNIER : il est ce que l'application interroge, et une
# application qui le lit avant que les fichiers soient en ligne annonce une mise
# a jour qui tombe sur un 404. Les URL qu'il contient pointent vers le TAG, donc
# elles sont immuables et l'empreinte annoncee correspond toujours au fichier
# servi — a condition que le sha256 du manifeste soit bien celui du fichier
# qu'on vient de televerser.
#
# Ressaisir ces commandes a la main, c'est l'occasion de inverser l'ordre ou de
# publier un sha256 perime. D'ou le script, et d'ou le controle
# final : chaque artefact televerse est relu et compare a son empreinte.
#
# ## Remplacer les assets d'un tag deja publie
#
# `--clobber` ecrase l'asset existant. C'est deliberement possible : tant que
# personne n'a telecharge, corriger une icone ne justifie pas de publier une
# 1.0.1 cosmetique. Cela change en revanche le sha256 pour qui avait deja pris
# le fichier. Le script affiche l'ancien et le nouveau, pour qu'on le sache.
#
# Usage :
#   bash scripts/publier.sh                      # publie, notes par defaut
#   bash scripts/publier.sh "Notes de version."  # notes de la publication
set -euo pipefail

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUB="$RACINE/public"
DEPOT="${NEUROBEATS_RELEASES_REPO:-sylvainmg/neurobeats-releases}"
NOTES="${1:-Version publique.}"

MANIFESTE="$PUB/versions.json"
[ -f "$MANIFESTE" ] || { echo "  ✗ manifeste absent : $MANIFESTE" >&2; exit 1; }
command -v gh >/dev/null || { echo "  ✗ gh (GitHub CLI) requis" >&2; exit 1; }

VERSION="$(python3 -c "import json;print(json.load(open('$MANIFESTE'))['version'])")"
TAG="v$VERSION"
BASE="https://github.com/$DEPOT/releases/download/$TAG"

echo
echo "  Depot   : $DEPOT"
echo "  Tag     : $TAG"
echo

# Les trois couples (cle de manifeste, nom de fichier). L'ordre est celui du
# manifeste : il ne determine rien, mais il rend la sortie lisible.
ARTEFACTS=(
  "android:NeuroBeats-$VERSION.apk"
  "linux-x64:NeuroBeats-$VERSION-x86_64.AppImage"
  "win32-x64:NeuroBeats-$VERSION-win-setup.exe"
)

manquants=0
for entree in "${ARTEFACTS[@]}"; do
  fichier="${entree#*:}"
  if [ ! -f "$PUB/$fichier" ]; then
    echo "  ✗ absent : public/$fichier" >&2
    manquants=$((manquants+1))
  fi
done
if [ "$manquants" -gt 0 ]; then
  echo >&2
  echo "  $manquants artefact(s) absent(s). Construits, mais pas places dans public/." >&2
  exit 1
fi

# Le manifeste est reconstruit par `mkversions.mjs`, qui relit les fichiers et
# calcule l'empreinte au moment de la publication. Lui faire le travail ici
# serait en ecrire une deuxieme version, qui divergerait de la premiere au
# premier changement de schema.
ARGS=()
for entree in "${ARTEFACTS[@]}"; do
  cle="${entree%%:*}"
  fichier="${entree#*:}"
  # Le chemin est donne tel qu'il est resolu depuis la racine du depot, et
  # `mkversions.mjs` n'en garde que le nom pour le champ `file` du manifeste.
  ARGS+=(--artefact "$cle=public/$fichier")
done

node "$RACINE/scripts/mkversions.mjs" "$VERSION" \
  --sortie "$MANIFESTE" \
  --base "$BASE/" \
  --note "$NOTES" \
  "${ARGS[@]}"

echo
echo "  Televersement des artefacts (le manifeste passe en dernier)…"
for entree in "${ARTEFACTS[@]}"; do
  fichier="${entree#*:}"
  printf "  → %s\n" "$fichier"
  gh release upload "$TAG" "$PUB/$fichier" --repo "$DEPOT" --clobber
done

printf "  → versions.json\n"
gh release upload "$TAG" "$MANIFESTE" --repo "$DEPOT" --clobber

echo
echo "  Publie. Verification en ligne :"
echo "    bash scripts/verifier-publication.mjs"
