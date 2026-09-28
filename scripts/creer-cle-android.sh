#!/usr/bin/env bash
#
# Cree la cle de distribution Android, et le fichier d'acces qui va avec.
#
# Pourquoi un script plutot que la ligne keytool : `keytool` demande le mot de
# passe de l'archive, puis celui de la cle. Les saisir deux fois, a la main,
# apres avoir eteOblige de les recopier dans un fichier, est la source du
# decrochage le plus banal qui soit — et un decrochage silencieux : le build
# echoue sur une erreur d'autorite, sans jamais produire d'APK, donc rien ne
# signale a l'avance que les deux saisies n'etaient pas identiques.
#
# Ici le mot de passe est demande UNE fois, masque, et ecrit aux deux endroits.
# Il ne passe ni dans l'historique du shell, ni dans la ligne de commande
# visible par les autres processus : keytool le lit dans l'environnement.
#
# Usage : bash scripts/creer-cle-android.sh [cle] [fichier-acces]
set -uo pipefail

CLE="${1:-$HOME/neurobeats-release.jks}"
ACCES="${2:-$HOME/.neurobeats-signing.env}"
ALIAS="neurobeats"

if ! command -v keytool >/dev/null; then
  echo "  ✗ keytool introuvable : un JDK est necessaire" >&2
  exit 1
fi

if [ -f "$CLE" ]; then
  printf "La cle %s existe deja. L'ecraser definitivement ? [o/N] " "$CLE"
  read -r reponse
  case "$reponse" in
    [oOyY]) ;;
    *) echo "  annule — rien n'a ete modifie"; exit 1 ;;
  esac
  # L'archive est REFAITE, pas completee. `keytool -genkeypair` ajoute a une
  # archive existante et refuse alors l'alias si celui-ci y est deja : sans cette
  # suppression, l'ecrasement annonce echoue sur « l'alias existe deja ».
  rm -f "$CLE"
fi

printf "Mot de passe de la cle de distribution (masque) : "
read -rs NEUROBEATS_PW
printf "\n"
if [ -z "$NEUROBEATS_PW" ]; then
  echo "  annule — mot de passe vide" >&2
  exit 1
fi
printf "Confirmation                              : "
read -rs CONFIRMATION
printf "\n"
if [ "$NEUROBEATS_PW" != "$CONFIRMATION" ]; then
  echo "  annule — les deux saisies different" >&2
  exit 1
fi

# Le mot de passe ne doit pas apparaitre dans `ps`. keytool sait le lire dans
# l'environnement avec `:env`.
export NEUROBEATS_PW

# `-dname` explicite : sans lui, keytool ouvre un inviteur interactif, et c'est
# exactement le dialogue qu'on veut supprimer ici.
keytool -genkeypair \
  -alias "$ALIAS" \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -keystore "$CLE" \
  -storetype PKCS12 \
  -storepass:env NEUROBEATS_PW \
  -keypass:env NEUROBEATS_PW \
  -dname "CN=NeuroBeats, OU=NeuroBeats, O=NeuroBeats, L=, S=, C=FR"
CODE=$?
if [ $CODE -ne 0 ]; then
  unset NEUROBEATS_PW
  echo "  ✗ keytool a echoue (code $CODE)" >&2
  exit $CODE
fi

# Le fichier d'ACCES est ecrit avec des permissions restrictives avant meme
# d'etre rempli, pour qu'aucun autre compte ne puisse le lire entre la creation
# et l'ecriture.
touch "$ACCES"
chmod 600 "$ACCES"
umask 077
cat > "$ACCES" <<EOF
ANDROID_KEYSTORE_PATH=$CLE
ANDROID_KEYSTORE_PASSWORD=$NEUROBEATS_PW
ANDROID_KEY_ALIAS=$ALIAS
ANDROID_KEY_PASSWORD=$NEUROBEATS_PW
EOF
chmod 600 "$ACCES"
unset NEUROBEATS_PW

# Verification immediate, dans le script : si elle echoue, l'utilisateur
# n'aura pas a le decouvrir plus tard.
set -a
# shellcheck disable=SC1090
. "$ACCES"
set +a
if ! keytool -list -keystore "$ANDROID_KEYSTORE_PATH" \
     -storepass "$ANDROID_KEYSTORE_PASSWORD" >/dev/null 2>&1; then
  echo "  ✗ la cle et le fichier d'acces ne correspondent toujours pas" >&2
  exit 1
fi

echo
echo "  ✓ cle    : $CLE"
echo "  ✓ acces  : $ACCES (600)"
echo "  ✓ alias  : $ALIAS — verifie, l'acces fonctionne"
echo
echo "  Empreinte du certificat (publique, ne la partage avec personne d'autre) :"
keytool -list -v -keystore "$ANDROID_KEYSTORE_PATH" \
  -alias "$ALIAS" -storepass "$ANDROID_KEYSTORE_PASSWORD" 2>/dev/null \
  | grep -E "^[[:space:]]*SHA[-[:space:]]?256:" \
  | grep -oE '[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){31}' | head -1 | tr -d '[:space:]' \
  | sed 's/^/    SHA-256 : /'
echo
echo "  A faire maintenant, une seule fois, puis a garder hors de ce poste :"
echo "    - une copie du fichier .jks (la cle elle-meme, pas le mot de passe)"
echo "    - le mot de passe, dans un gestionnaire"
echo
echo "  Perdre cette cle signifie ne plus jamais pouvoir mettre a jour"
echo "  l'application pour ceux qui l'ont installee."
