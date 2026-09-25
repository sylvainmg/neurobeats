#!/usr/bin/env bash
# Prépare les ressources embarquées par electron-builder.
#
# Le bundle desktop ne contient pas le venv de développement (torch/NVIDIA
# dépasse plusieurs gigaoctets). On embarque un runtime Python autonome et
# minimal : FastAPI + clients LLM + téléchargement Hugging Face + fallback
# TF-IDF. `resources/backend` reste en lecture seule ; les données mutables sont
# redirigées vers userData/data par config.ts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DESKTOP="$ROOT/desktop"
STAGE="$DESKTOP/.runtime/backend-package"
PYTHON="${NEUROBEATS_PYTHON:-$HOME/python/bin/python3.13}"

if [[ ! -x "$PYTHON" ]]; then
  if command -v python3 >/dev/null 2>&1; then
    PYTHON="$(command -v python3)"
  else
    echo "Python 3 introuvable. Definissez NEUROBEATS_PYTHON avec un interpreteur 3.11+." >&2
    exit 1
  fi
fi

printf '→ Runtime Python : %s\n' "$PYTHON"
PYTHON="$(readlink -f "$PYTHON")"
PYTHON_ROOT="$(cd "$(dirname "$PYTHON")/.." && pwd)"
if [[ ! -d "$PYTHON_ROOT/lib" ]]; then
  echo "Le runtime Python doit etre autonome (python-build-standalone)." >&2
  echo "Definissez NEUROBEATS_PYTHON avec une distribution autonome." >&2
  exit 1
fi

rm -rf "$STAGE"
mkdir -p "$STAGE"

printf '→ Copie du runtime Python autonome\n'
cp -a "$PYTHON_ROOT/." "$STAGE/python/"

printf '→ Copie du backend (hors donnees et venv de dev)\n'
rsync -a \
  --exclude='.venv/' \
  --exclude='__pycache__/' \
  --exclude='*.pyc' \
  --exclude='*.log' \
  --exclude='*.db' \
  --exclude='*.db-*' \
  --exclude='tests/' \
  --exclude='neurobeats.db' \
  --exclude='stream_cache.json' \
  --exclude='music_history.json*' \
  --exclude='user_profile.json*' \
  --exclude='*.bak' \
  --exclude='covers/' \
  --exclude='prepared/' \
  "$ROOT/backend/" "$STAGE/"

printf '→ Installation des dependances desktop\n'
SITE_PACKAGES="$("$STAGE/python/bin/python" -c 'import sysconfig; print(sysconfig.get_path("purelib"))')"
PIP_ROOT_USER_ACTION=ignore "$STAGE/python/bin/python" -m pip install \
  --disable-pip-version-check --no-input --no-warn-script-location \
  --target="$SITE_PACKAGES" \
  -r "$DESKTOP/scripts/requirements-desktop.txt"

printf '→ Preparation des binaires multimedia\n'
mkdir -p "$DESKTOP/bin" "$DESKTOP/runtime"
copy_binary() {
  local name="$1"
  local source="${NEUROBEATS_BIN_DIR:-}/$name"
  if [[ ! -x "$source" ]]; then
    source="$(command -v "$name" || true)"
  fi
  if [[ -n "$source" && -x "$source" ]]; then
    cp -L "$source" "$DESKTOP/bin/$name"
    chmod 0755 "$DESKTOP/bin/$name"
  else
    printf '  ⚠ %s introuvable (package multimedia incomplet)\n' "$name" >&2
  fi
}
copy_binary mpv
copy_binary ffmpeg
copy_binary ffprobe

printf '→ Preparation du runtime llama.cpp\n'
llama_name="llama-server"
[[ "$(uname -s)" == "MINGW"* || "$(uname -s)" == "CYGWIN"* ]] && llama_name="llama-server.exe"
llama_source="${NEUROBEATS_LLAMA_SERVER:-}"
if [[ -z "$llama_source" && ! -x "$DESKTOP/runtime/$llama_name" ]] && command -v "$llama_name" >/dev/null 2>&1; then
  llama_source="$(command -v "$llama_name")"
fi
if [[ -z "$llama_source" && -x "$DESKTOP/runtime/$llama_name" ]]; then
  llama_source="$DESKTOP/runtime/$llama_name"
fi
if [[ -z "$llama_source" && -x "$DESKTOP/scripts/fetch-llama.sh" ]]; then
  "$DESKTOP/scripts/fetch-llama.sh" || true
  llama_source="$DESKTOP/runtime/$llama_name"
fi
if [[ -n "$llama_source" && -x "$llama_source" ]]; then
  if [[ "$llama_source" != "$DESKTOP/runtime/$llama_name" ]]; then
    cp -L "$llama_source" "$DESKTOP/runtime/$llama_name"
  fi
  chmod 0755 "$DESKTOP/runtime/$llama_name"
else
  printf '  ⚠ llama-server absent : le gestionnaire reste visible, mais le moteur local sera indisponible.\n' >&2
  printf '%s\n' "Placez le binaire dans desktop/runtime/$llama_name ou definissez NEUROBEATS_LLAMA_SERVER." > "$DESKTOP/runtime/README.txt"
fi

printf '→ Verification des imports du runtime\n'
"$STAGE/python/bin/python" - <<'PY'
import fastapi, huggingface_hub, numpy, sklearn, uvicorn, yt_dlp
print("  ✓ imports Python desktop")
PY

printf '→ Verification du catalogue de modeles embarque\n'
STAGE_DIR="$STAGE" "$STAGE/python/bin/python" - <<'PY'
import json, os
catalog = os.path.join(os.environ["STAGE_DIR"], "services", "curated_models.json")
entries = json.load(open(catalog, encoding="utf-8")).get("models", [])
assert entries, "catalogue de modeles vide"
for entry in entries:
    for key in ("id", "repo", "size_gb", "min_ram_gb", "ctx"):
        assert key in entry, f"{entry.get('id')}: champ {key} manquant"
print(f"  ✓ catalogue : {len(entries)} modeles cures")
PY

du -sh "$STAGE" "$DESKTOP/bin" "$DESKTOP/runtime"
printf '✓ Runtime staged dans %s\n' "$STAGE"
