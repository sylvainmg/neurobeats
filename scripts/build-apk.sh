#!/usr/bin/env bash
#
# Construit l'APK Android signe en cle de distribution, et VERIFIE la signature.
#
# Pourquoi ce script plutot que la ligne gradle directe :
# `NEUROBEATS_REQUIRE_RELEASE_SIGNING=1` fait echouer le build si une variable
# manque, ce qui est deja une garde. Mais sans verification d'apres, un build
# reussi ne prouve rien — le controle porte sur la PRESENCE des variables, pas
# sur le certificat obtenu. Un `assembleRelease` sans keystore configure produit
# un APK instalable, signe en cle de debug, qu'aucune mise a jour ulterieure ne
# pourra remplacer. C'est exactement le piege qu'on a franchi.
#
# Le script compare donc l'empreinte du certificat de l'APK produit a celle de
# la cle de distribution. Une empreinte de certificat est publique : la comparer
# ne revele rien du mot de passe, qui n'est jamais lu ni affiche ici.
#
# Les acces viennent de `~/.neurobeats-signing.env` (hors depot, mode 600). Ils
# ne sont jamais echoes.
#
# Usage : bash scripts/build-apk.sh [--sans-controle]
set -uo pipefail

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACCES="${NEUROBEATS_SIGNING_ENV:-$HOME/.neurobeats-signing.env}"
GRADLE="$RACINE/mobile/android"
APK="$GRADLE/app/build/outputs/apk/release/app-release.apk"
BUILD_TOOLS="$HOME/Android/Sdk/build-tools"
# Chemin ABSOLU : le script se place dans le dossier gradle avant d'appeler
# apksigner, et un chemin relatif (`36.1.0/apksigner`) y designait le vide —
# l'echec paraissait alors etre une signature illisible.
APKSIGNER="$BUILD_TOOLS/$(ls "$BUILD_TOOLS" 2>/dev/null | sort -r | head -1)/apksigner"

if [ ! -f "$ACCES" ]; then
  cat >&2 <<EOF
  Fichier d'acces introuvable : $ACCES

  Il doit contenir quatre lignes :
    ANDROID_KEYSTORE_PATH=/chemin/vers/cle.jks
    ANDROID_KEYSTORE_PASSWORD=...
    ANDROID_KEY_ALIAS=...
    ANDROID_KEY_PASSWORD=...

  Gardez-le hors du depot, en chmod 600. Les mots de passe ne doivent jamais
  transiter par un script, un commit ou une conversation.
EOF
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$ACCES"
set +a

for var in ANDROID_KEYSTORE_PATH ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD; do
  if [ -z "${!var:-}" ]; then
    echo "  ✗ $var est vide dans $ACCES" >&2
    exit 1
  fi
done

if [ ! -f "$ANDROID_KEYSTORE_PATH" ]; then
  echo "  ✗ cle introuvable : $ANDROID_KEYSTORE_PATH" >&2
  exit 1
fi

# --- Version : les deux sources de verite doivent concorder ---------------------
#
# `mobile/app.json` porte la version et le `versionCode` — c'est la source
# versionnee, celle qui survit a un `expo prebuild`. Mais `android/app/build.gradle`
# est genere, et ses `versionCode` / `versionName` sont ecrits en dur par le
# plugin. Les deux peuvent diverger en silence : l'APK est alors construit avec
# une version, le depot en annonce une autre, et l'application dit a l'utilisateur
# qu'il est a jour alors que la release publiee est plus recente.
#
# Le `versionCode` merite une attention particuliere : Android refuse d'installer
# une mise a jour dont le `versionCode` n'est pas STRICTEMENT superieur. Deux
# versions comme 0.1.0 et 1.0.0 produisent toutes deux 1 par derivation — la
# premiere mise a jour publiee echouerait donc silencieusement. D'ou un code
# explicite avec de la marge.
APP_JSON="$RACINE/mobile/app.json"
BUILD_GRADLE="$RACINE/mobile/android/app/build.gradle"

VERSION_APPUI="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$APP_JSON" | head -1)"
VERSION_CODE="$(sed -n 's/.*"versionCode"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$APP_JSON" | head -1)"
VERSION_GRADLE="$(sed -n 's/.*versionName[[:space:]]*"\([^"]*\)".*/\1/p' "$BUILD_GRADLE" | head -1)"
CODE_GRADLE="$(sed -n 's/.*versionCode[[:space:]]*\([0-9]*\).*/\1/p' "$BUILD_GRADLE" | head -1)"

if [ -z "$VERSION_APPUI" ] || [ -z "$VERSION_CODE" ]; then
  echo "  ✗ version ou versionCode introuvable dans $APP_JSON" >&2
  echo "    Les deux sont explicites : une version derivee donne le meme" >&2
  echo "    versionCode a 0.1.0 et 1.0.0, et Android refuse alors la mise a jour." >&2
  exit 1
fi

if [ "$VERSION_APPUI" != "$VERSION_GRADLE" ] || [ "$VERSION_CODE" != "$CODE_GRADLE" ]; then
  echo "  ✗ la version diverge entre app.json et build.gradle" >&2
  echo "      app.json      : $VERSION_APPUI (versionCode $VERSION_CODE)" >&2
  echo "      build.gradle  : $VERSION_GRADLE (versionCode $CODE_GRADLE)" >&2
  echo "    Corrige les deux, ou relance un prebuild pour regenerer build.gradle." >&2
  exit 1
fi
echo "  ✓ version $VERSION_APPUI (versionCode $VERSION_CODE), coherente dans les deux sources"

# Verifie l'acces AVANT de lancer un build de plusieurs minutes : une erreur de
# mot de passe ne doit etre decouverte qu'a la verification finale.
if ! keytool -list -keystore "$ANDROID_KEYSTORE_PATH" \
     -storepass "$ANDROID_KEYSTORE_PASSWORD" >/dev/null 2>&1; then
  echo "  ✗ ANDROID_KEYSTORE_PASSWORD ne correspond pas a $ANDROID_KEYSTORE_PATH" >&2
  echo "    Verifiez avec :" >&2
  echo "      . $ACCES && keytool -list -keystore \"\$ANDROID_KEYSTORE_PATH\" -storepass \"\$ANDROID_KEYSTORE_PASSWORD\"" >&2
  exit 1
fi
ATTENDUE="$(keytool -list -v -keystore "$ANDROID_KEYSTORE_PATH" \
  -alias "$ANDROID_KEY_ALIAS" -storepass "$ANDROID_KEYSTORE_PASSWORD" 2>/dev/null \
  | grep -E "^[[:space:]]*SHA[-[:space:]]?256:" \
  | grep -oE '[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){31}' | head -1 | tr -d '[:space:]:')"
if [ -z "$ATTENDUE" ]; then
  echo "  ✗ alias '$ANDROID_KEY_ALIAS' absent de la cle, ou cle illisible" >&2
  exit 1
fi
echo "  ✓ cle accessible, alias '$ANDROID_KEY_ALIAS'"

# `EXPO_PUBLIC_MAJ_AUTO_INSTALLABLE` reste a 1 : c'est justement parce que la
# signature est desormais celle de la distribution que l'application peut
# proposer une auto-mise a jour. A 0, elle se refuserait a le faire.
export NEUROBEATS_REQUIRE_RELEASE_SIGNING=1
export ANDROID_KEYSTORE_PATH ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD
export EXPO_PUBLIC_MAJ_AUTO_INSTALLABLE=1

# Les icones du lanceur ne viennent PAS des PNG de `assets/images/`. Expo les
# convertit en WebP et les repartit dans `android/.../res/mipmap-*` — au
# moment du `prebuild` SEULEMENT. Sans cette etape, remplacer les PNG laisse le
# build vert et l'APK porte l'ancien logo : rien ne le signale, et l'icone
# n'apparait qu'une fois l'application installee sur un telephone. C'est
# exactement ce qui s'est passe une premiere fois.
if ! bash "$RACINE/scripts/icones-mobile.sh"; then
  echo "  ✗ generation des images de marque echouee" >&2
  exit 1
fi
if ! bash "$RACINE/scripts/icones-android.sh"; then
  echo "  ✗ generation des icones du lanceur echouee" >&2
  exit 1
fi

# Le bundle JS doit etre REFAIT, sinon la variable d'environnement est ignoree.
#
# La tache `createBundleReleaseJsAndAssets` ne declare pas les variables
# `EXPO_PUBLIC_*` parmi ses entrees : gradle ne peut donc pas savoir qu'elles ont
# change, la tache ressort UP-TO-DATE, et le bundle emis contient l'ancienne
# valeur. Concretement, un build avec `EXPO_PUBLIC_MAJ_AUTO_INSTALLABLE=1`
# produisait un APK strictement identique a celui construit avec `0` — compare
# octet a octet, bundles de 2,9 Mo compris. Sans cette purge, le controle de
# signature passe, l'APK est signe comme il faut, et la seule difference
# attendue n'y est pas.
BUNDLE_GENERE="$GRADLE/app/build/generated/assets/react/release/index.android.bundle"
if [ -f "$BUNDLE_GENERE" ]; then
  rm -f "$BUNDLE_GENERE"
  echo "  ✓ bundle JS purge — les variables EXPO_PUBLIC_* seront reappliquées"
fi

cd "$GRADLE" || exit 1
./gradlew assembleRelease --no-daemon -x test -x lint "$@"
CODE=$?
if [ $CODE -ne 0 ]; then
  echo "  ✗ gradle a echoue (code $CODE)"
  exit $CODE
fi

[ -f "$APK" ] || { echo "  ✗ APK absent : $APK" >&2; exit 1; }
echo "  ✓ APK : $(du -h "$APK" | cut -f1)"

# La valeur de la variable doit etre INCOLEE dans le bundle : si son nom y
# figure encore, c'est que le bundle a ete reutilise tel quel et le drapeau n'a
# pas ete applique.
BUNDLE_FINAL="$GRADLE/app/build/generated/assets/react/release/index.android.bundle"
if [ -f "$BUNDLE_FINAL" ] && grep -aq "EXPO_PUBLIC_MAJ_AUTO_INSTALLABLE" "$BUNDLE_FINAL"; then
  echo "  ✗ le bundle contient encore le NOM de la variable : sa valeur n'a pas" >&2
  echo "    ete appliquee. L'auto-mise a jour resterait desactivee." >&2
  exit 1
fi

OBTENUE="$("$APKSIGNER" verify --print-certs "$APK" 2>/dev/null | grep -i "SHA-256 digest" | head -1 | cut -d: -f2 | tr -d ' ')"
if [ -z "$OBTENUE" ]; then
  echo "  ✗ signature illisible" >&2
  exit 1
fi

# Comparaison insensible a la casse et au formatage : keytool et apksigner
# n'ecrivent pas les deux la meme.
# keytool ecrit l'empreinte avec des deux-points ("9C:CB:1A:..."), apksigner
# sans ("9ccb1a..."). Les deux formes doivent devenir la meme chaine, sinon la
# comparaison echoue alors que les certificats sont identiques.
norm() { echo "$1" | tr -d '[:space:]:' | tr 'A-F' 'a-f'; }
if [ "$(norm "$OBTENUE")" = "$(norm "$ATTENDUE")" ]; then
  echo "  ✓ signe avec la cle de distribution : $(norm "$OBTENUE" | cut -c1-23)…"
  echo
  echo "  L'APK peut desormais se mettre a jour tout seul, et Android refusera"
  echo "  toute version ulterieure signee avec une autre cle."
  exit 0
fi

echo "  ✗ ATTENTION : l'APK n'est PAS signe avec ta cle de distribution." >&2
echo "    cle attendue : $(norm "$ATTENDUE" | cut -c1-23)…" >&2
echo "    cle obtenue  : $(norm "$OBTENUE" | cut -c1-23)…" >&2
echo "    L'artefact reste utilisable, mais aucune mise a jour ne pourra" >&2
echo "    le remplacer un jour. Ne le publie pas." >&2
exit 1
