#!/usr/bin/env bash
#
# Réapplique les correctifs NeuroBeats dans `node_modules`.
#
# Même contrat que `patch-expo-audio.sh` : idempotent, strict, et rejoué au
# `postinstall` pour que le dépôt reste buildable par n'importe qui.
#
# Usage : bash scripts/patch-ytdlp-engine.sh   (ou via `npm install`)
set -euo pipefail

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GRADLE="$RACINE/node_modules/ytdlp-react-native/android/build.gradle"
MOTEUR="$RACINE/node_modules/ytdlp-react-native/android/src/main/java/expo/modules/ytdlp/YtDlpEngine.kt"

if [ ! -f "$GRADLE" ] || [ ! -f "$MOTEUR" ]; then
  printf '%s\n' "  ⚠ ytdlp-react-native absent (pas encore installé) — patch ignoré"
  exit 0
fi

# --- Correctif 1 : viser le fork local, pas le 2.0.2 public -----------------
#
# `android/build.gradle` de la lib épingle `yt-dlp-android:2.0.2`, le build
# public de JitPack. Or le module appelle `YtDlp.updateYtDlp()` (l'auto-update
# décrit dans AGENTS.md §59) : cette API n'existe que dans le fork local
# `2.0.3-neurobeats`, déjà publié dans mavenLocal et placé en tête de
# résolution par `android/build.gradle`. Sur le 2.0.2, l'appel n'a rien sur
# quoi s'exécuter et le typecheck du projet échoue.
#
# Le garde interroge la DÉCLARATION, pas le fichier : un commentaire
# mentionnant le fork ne doit pas faire croire qu'il est ciblé.
if grep -q "implementation 'dev.ffmpegkit-maintained:yt-dlp-android:2.0.3-neurobeats'" "$GRADLE"; then
  printf '%s\n' "  ✓ ytdlp-react-native : fork local déjà ciblé"
else
  python3 - "$GRADLE" <<'PY'
import re
import sys

chemin = sys.argv[1]
texte = open(chemin, encoding="utf-8").read()

motif = r"implementation 'dev\.ffmpegkit-maintained:yt-dlp-android:[^']+'"
occ = re.findall(motif, texte)
if len(occ) != 1:
    raise SystemExit(
        "patch ytdlp : déclaration de version introuvable ou ambiguë "
        f"({occ}) — version différente ?"
    )

corrige = """implementation 'dev.ffmpegkit-maintained:yt-dlp-android:2.0.3-neurobeats'"""

open(chemin, "w", encoding="utf-8").write(re.sub(motif, lambda _m: corrige, texte, count=1))
print("  ✓ ytdlp-react-native : fork local ciblé")
PY
fi

# --- Correctif 2 : appeler `execute` comme une fonction ---------------------
#
# Le helper Python définit `execute` dans un dictionnaire d'espace de noms, et
# `downloaderFunction()` le récupère par item (`ns.asMap()[...]`) : l'objet
# rendu EST la fonction.
#
# `PyObject` propose deux Champions variadiques :
#   - callAttr(String, Object...)  → getattr(self, nom)(*args)
#   - call(Object...)              → self(*args)
#
# L'ancien code faisait `callAttr("execute", task, url, opts)` : il demandait
# à une *fonction* l'attribut `execute`, qui n'existe pas →
# `AttributeError: 'function' object has no attribute 'execute'`. Repasser le
# nom à `call` necorrige rien non plus : il deviendrait un argument
# positionnel → `TypeError: execute() takes 3 positional arguments but 4 were
# given`. Les deux formes sont fausses, et la seconde a masqué la première.
#
# La bonne forme est `call(task, url, opts)`. Tout téléchargement venu du
# navigateur (chemin `directs`, qui n'emprunte jamais DownloadManager)
# échouait là, systématiquement, requalifié en `DOWNLOAD_FAILED` par le
# `catch` générique.
if grep -q 'downloaderFunction(py).call(task, url, toPyObject(py, opts))' "$MOTEUR"; then
  printf '%s\n' "  ✓ ytdlp-react-native : appel de execute() déjà corrigé"
else
  python3 - "$MOTEUR" <<'PY'
import re
import sys

chemin = sys.argv[1]
texte = open(chemin, encoding="utf-8").read()

# On accepte l'état d'origine ET celui d'un correctif antérieur (qui repassait
# le nom), pour que le script converge vers la forme correcte quoi qu'il trouve.
motif = re.compile(
    r"[ \t]*//[^\n]*\n[ \t]*downloaderFunction\(py\)\."
    r"(?:callAttr|call)\((?:\"execute\", )?task, url, toPyObject\(py, opts\)\)"
)
occ = motif.findall(texte)
if len(occ) != 1:
    raise SystemExit(
        "patch ytdlp : site d'appel introuvable ou ambiguë "
        f"({len(occ)} occurrence(s)) — version différente ?"
    )

corrige = (
    "      // --- NEUROBEATS -------------------------------------------------------\n"
    "      // `downloaderFunction` rend l'objet fonction `execute` lui-même, pas un\n"
    "      // objet porteur d'un attribut de ce nom : on l'appelle donc\n"
    "      // directement, sans repasser le nom (ce qui le ferait compter comme un\n"
    "      // argument positionnel de plus).\n"
    "      downloaderFunction(py).call(task, url, toPyObject(py, opts))"
)

open(chemin, "w", encoding="utf-8").write(motif.sub(lambda _m: corrige, texte, count=1))
print("  ✓ ytdlp-react-native : appel de execute() corrigé")
PY
fi
