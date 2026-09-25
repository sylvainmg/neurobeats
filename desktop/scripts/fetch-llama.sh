#!/usr/bin/env bash
# Telecharge le binaire llama.cpp utilise par le moteur local.
# Le build est volontairement epingle : le packaging doit produire le meme
# runtime tant que la version du modele/serveur n'est pas mise a jour manuellement.
#
# Sur Linux x64 on prend le build VULKAN, pas le build CPU : meme release de
# llama.cpp, mais il sait decharger les couches sur le GPU (-ngl) — generation
# ~3x plus rapide sur une machine a GPU — et il retombe sur le CPU quand Vulkan
# est absent (le backend CPU reste embarque). Quelques Mo de plus, la ou un
# build CUDA exigerait d'embarquer ~600 Mo de cudart en plus.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DESKTOP="$ROOT/desktop"
RUNTIME="$DESKTOP/runtime"
BUILD="${NEUROBEATS_LLAMA_BUILD:-b11177}"
CACHE="${NEUROBEATS_LLAMA_CACHE:-${TMPDIR:-/tmp}/neurobeats-llama-$BUILD}"
EXPECTED_SHA256="1557dbc00d446cb21d7e9771d98106495f55d8cef4faff85ee479eef3698d0c3"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    asset="llama-${BUILD}-bin-ubuntu-vulkan-x64.tar.gz"
    ;;
  Linux-aarch64|Linux-arm64)
    asset="llama-${BUILD}-bin-ubuntu-arm64.tar.gz"
    expected_sha256=""
    ;;
  Darwin-x86_64)
    asset="llama-${BUILD}-bin-macos-x64.tar.gz"
    expected_sha256=""
    ;;
  Darwin-arm64)
    asset="llama-${BUILD}-bin-macos-arm64.tar.gz"
    expected_sha256=""
    ;;
  *)
    echo "Plateforme non geree par fetch-llama.sh : $(uname -s)/$(uname -m)" >&2
    echo "Fournissez un binaire llama-server via NEUROBEATS_LLAMA_SERVER." >&2
    exit 1
    ;;
esac

if [[ -x "$RUNTIME/llama-server" || -x "$RUNTIME/llama-server.exe" ]]; then
  echo "llama-server deja present dans $RUNTIME"
  exit 0
fi

mkdir -p "$CACHE" "$RUNTIME"
archive="$CACHE/$asset"
if [[ ! -s "$archive" ]]; then
  url="https://github.com/ggml-org/llama.cpp/releases/download/$BUILD/$asset"
  echo "→ Téléchargement $asset"
  curl -L --fail --retry 3 -o "$archive.part" "$url"
  mv "$archive.part" "$archive"
fi

if [[ -n "$EXPECTED_SHA256" ]]; then
  actual="$(sha256sum "$archive" | awk '{print $1}')"
  [[ "$actual" == "$EXPECTED_SHA256" ]] || {
    echo "Checksum llama.cpp invalide: $actual" >&2
    exit 1
  }
fi

extract="$CACHE/extract"
rm -rf "$extract"
mkdir -p "$extract"
tar -xzf "$archive" -C "$extract"
root="$(find "$extract" -mindepth 1 -maxdepth 1 -type d | head -1)"
[[ -n "$root" ]] || { echo "Archive llama.cpp vide" >&2; exit 1; }

# Le serveur est dynamically linked aux backends ggml; on embarque toutes les
# bibliothees de l'archive, pas seulement l'executable de 18 Ko.
cp -a "$root"/. "$RUNTIME"/
chmod 0755 "$RUNTIME/llama-server" 2>/dev/null || true
printf '✓ llama-server %s prêt (%s)\n' "$BUILD" "$RUNTIME"
