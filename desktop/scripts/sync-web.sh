#!/usr/bin/env bash
#
# Build standalone de l'interface web/ → desktop/.runtime/web-standalone.
#
# web/ est un périmètre READ-ONLY pour l'agent : on ne le modifie JAMAIS.
# Le build se fait dans une copie de travail (.runtime/web-src), où l'on
# ajoute `output: "standalone"` (option qui ne s'active pas par env var), puis
# le résultat (server.js + node_modules minimal + .next) est copié dans
# .runtime/web-standalone, servi par Electron via ELECTRON_RUN_AS_NODE=1.
#
# Usage :  npm run standalone   (depuis desktop/)
#          NEUROBEATS_API_URL=http://localhost:8040 npm run standalone
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DESKTOP="$ROOT/desktop"
SRC="$DESKTOP/.runtime/web-src"
DIST="$DESKTOP/.runtime/web-standalone"

# L'URL du backend est INLINÉE dans le bundle client au build. Port dédié de
# l'app : 8041 (distinct du backend de dev sur 8040). On le force ici pour une
# reproductibilité totale — le shell peut le surcharger (NEUROBEATS_API_URL)
# pour tester sur un autre port.
API_URL="${NEUROBEATS_API_URL:-http://localhost:8041}"

say() { printf '%s\n' "$*"; }

say "→ Copie de web/ (lecture seule) vers $SRC"
rm -rf "$SRC" "$DIST"
mkdir -p "$(dirname "$SRC")"
rsync -a \
  --exclude node_modules --exclude .next --exclude out --exclude build \
  --exclude '.env*' --exclude '*.tsbuildinfo' --exclude next-env.d.ts \
  "$ROOT/web/" "$SRC/"

say "→ Patch du build standalone dans la COPIE uniquement"
python3 - "$SRC/next.config.ts" <<'PY'
import re, sys
path = sys.argv[1]
src = open(path, encoding="utf-8").read()
lines = src.splitlines()
for index, line in enumerate(lines):
    match = re.fullmatch(r"export default (\w+);", line.strip())
    if not match:
        continue
    name = match.group(1)
    injected = []
    if "output" not in src:
        injected.append(f"{name}.output = 'standalone';")
    # L'AppImage est un squashfs en lecture seule : le cache d'images de Next y
    # echoue (ENOENT a chaque requete, avec un unhandledRejection dans le
    # journal). Le conteneur desktop sert les jaquettes en direct — l'optimiseur
    # Node n'apporte rien ici et coute du CPU sur chaque image.
    injected.append(
        f"{name}.images = {{ ...({name}.images ?? {{}}), unoptimized: true }};"
    )
    lines[index:index + 1] = injected + [f"export default {name};"]
    break
else:
    raise SystemExit("Erreur : next.config.ts sans « export default <nom>; » exploitable")
open(path, "w", encoding="utf-8").write("\n".join(lines) + "\n")
PY

say "→ Installation des dépendances (copie)"
# Les devDependencies sont indispensables au build (Turbopack, PostCSS,
# Tailwind) : un NODE_ENV=production hérité du shell les fait sauter, et le
# build échoue ensuite sur « Cannot find module '@tailwindcss/postcss' ».
( cd "$SRC" && NODE_ENV=development npm ci --include=dev --no-audit --no-fund --loglevel=error )

say "→ Build Next (NEXT_PUBLIC_API_URL=$API_URL)"
# NODE_ENV explicite : le build doit être celui de PRODUCTION quoi qu'il arrive.
# Hérité du shell appelant, un NODE_ENV=development fait échouer le prerender
# (React résout deux copies de lui-même et `useContext` tombe sur null) — un
# échec qui n'a rien à voir avec le code de la copie de travail.
( cd "$SRC" && NODE_ENV=production NEXT_PUBLIC_API_URL="$API_URL" npm run build )

say "→ Assemblage du runtime standalone"
if [ ! -d "$SRC/.next/standalone" ]; then
  echo "Erreur : pas de .next/standalone produit (output standalone non appliqué ?)" >&2
  exit 1
fi
cp -r "$SRC/.next/standalone" "$DIST"
cp -r "$SRC/.next/static" "$DIST/.next/static"
[ -d "$SRC/public" ] && cp -r "$SRC/public" "$DIST/public"

# electron-builder exclut par defaut tout dossier nomme node_modules, meme
# lorsqu'il se trouve dans extraResources. Le runtime standalone Next a besoin
# de ses modules ; on lui donne donc un nom neutre et frontend.ts injecte ce
# chemin via NODE_PATH au lancement du server.js.
if [ -d "$DIST/node_modules" ]; then
  mv "$DIST/node_modules" "$DIST/web-node-modules"
fi

# Next grave dans ses metadonnees de build les chemins absolus de la machine
# (`outputFileTracingRoot`, `repoRoot`, `appDir`, `turbopack.root`). Ils ne sont
# jamais lus a l'execution, mais ils partent dans l'artefact public avec le nom
# d'utilisateur et l'arborescence du poste de dev. On les remplace par un
# chemin neutre : neutre car l'app sert ses fichiers via NODE_PATH, pas via ces
# champs, qui ne servent qu'au tracing de build.
say "→ Neutralisation des chemins de build dans le runtime standalone"
python3 - "$DIST" "$DESKTOP" <<'PY'
import os, sys

dist, desktop = sys.argv[1], sys.argv[2]
neutral = "/app"
targets = [
    os.path.join(dist, "server.js"),
    os.path.join(dist, ".next", "required-server-files.json"),
]
replaced = 0
for path in targets:
    if not os.path.isfile(path):
        continue
    with open(path, encoding="utf-8") as handle:
        text = handle.read()
    if desktop not in text:
        continue
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text.replace(desktop, neutral))
    replaced += 1
print(f"  {replaced} fichier(s) neutralise(s)")
PY

say "✓ Standalone prêt : $DIST"
say "  Lancer : npm run build && NEUROBEATS_STANDALONE_DIR=\"$DIST\" npm run start"