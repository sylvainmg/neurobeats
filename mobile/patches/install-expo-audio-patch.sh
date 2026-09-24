#!/usr/bin/env bash
# Applique le patch expo-audio (boutons précédent/suivant sur la notification
# de lecture et l'écran verrouillé) sur node_modules.
#
# Pré-requis :
#   - expo-audio 57.0.5 installé (npm install) ;
#   - package.json contient "expo.autolinking.buildFromSource": ["expo-audio"]
#     (obligatoire : sinon le module précompilé [📦] est utilisé à la place
#     des sources patchées — déclaration faite dans mobile/package.json).
#
# Usage : depuis mobile/  →  bash patches/install-expo-audio-patch.sh

set -euo pipefail

AUDAUDIO="node_modules/expo-audio"
PATCH_DIR="mobile/patches"
PATCH_FILE="${PATCH_DIR}/expo-audio.patch"
VERSION_ATTENDUE="57.0.5"

if [ ! -f "$PATCH_FILE" ]; then
  echo "✗ $PATCH_FILE introuvable — lancer depuis la racine du dépôt." >&2
  exit 1
fi

if [ ! -d "$AUDAUDIO" ]; then
  echo "✗ $AUDAUDIO absent — expo-audio est-il installé ?" >&2
  exit 1
fi

VERSION="$(node -p "require('./node_modules/expo-audio/package.json').version" 2>/dev/null || true)"
if [ "$VERSION" != "$VERSION_ATTENDUE" ]; then
  echo "✗ expo-audio $VERSION installé, patch conçu pour $VERSION_ATTENDUE." >&2
  exit 1
fi

# Le patch est contre la version pristine : un node_modules déjà patché échouerait.
# On teste donc une application à sec ; si elle échoue, on suppose qu'il est
# déjà en place (les fichiers cibles diffèrent de l'original).
if ! git apply --check "$PATCH_FILE" 2>/dev/null; then
  if grep -q "sessionNavigation" "$AUDAUDIO/android/src/main/java/expo/modules/audio/AudioPlayer.kt"; then
    echo "· Le patch expo-audio semble déjà appliqué, rien à faire."
    exit 0
  fi
  echo "✗ Application impossible (fichiers modifiés ?) — voir mobile/patches/expo-audio.patch." >&2
  exit 1
fi

git apply "$PATCH_FILE"
echo "✓ Patch expo-audio appliqué (5 fichiers Kotlin + 3 TS)."
echo "  Pense à reconstruire : cd mobile/android && ./gradlew assembleDebug"