#!/usr/bin/env bash
#
# Réapplique les correctifs NeuroBeats dans `node_modules`.
#
# Certains bugs n'ont pas de correctif en amont : on ne peut pas attendre qu'un
# `npm install` les efface. Ce script les rejoue, et il est appelé en
# `post-install` pour que le dépôt reste buildable par n'importe qui.
#
# Chaque patch est idempotent et STRICT : si le fichier ne contient ni le motif
# d'origine, ni la marque du correctif déjà posé, le script échoue. Un patch
# appliqué de travers sur une version différente est pire qu'un échec franc —
# il produirait un binaire qui semble compilable et ne marche pas.
#
# Usage : bash scripts/patch-expo-audio.sh   (ou via `npm install`)
set -euo pipefail

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CIBLE="$RACINE/node_modules/expo-audio/android/src/main/java/expo/modules/audio/service/MetadataInjectingPlayer.kt"

if [ ! -f "$CIBLE" ]; then
  printf '%s\n' "  ⚠ expo-audio absent (pas encore installé) — patch ignoré"
  exit 0
fi

# --- Correctif : la session média doit vivre même en pause ------------------
#
# Android supprime la notification d'un service de lecture qu'il juge inerte, et
# il juge sur l'absence d'événements. Ce wrapper ne synthétisait aucun
# événement : il ne répliquait QUE les changements de métadonnées. Conséquence
# sur un titre en pause (et lui seul) : plus rien ne se passe, la notification
# disparaît au bout de quelques minutes, et la progress bar reste figée au
# retour dans l'application — où redevenir devient impossible à piloter.
#
# On relaie donc l'état de lecture, qui porte la vie de la session.
if grep -q 'NEUROBEATS' "$CIBLE"; then
  printf '%s\n' "  ✓ expo-audio : relais de l'état déjà en place"
  exit 0
fi

python3 - "$CIBLE" <<'PY'
import sys

chemin = sys.argv[1]
texte = open(chemin, encoding="utf-8").read()

# On s'insère à la fin de MetadataForwardingListener : c'est le seul endroit
# qui doit relayer l'état au lecteur de session.
ancre = """    override fun onEvents(player: Player, events: Player.Events) {
      listener.onEvents(this@MetadataInjectingPlayer, events)
    }
  }
}"""
relais = """    override fun onEvents(player: Player, events: Player.Events) {
      listener.onEvents(this@MetadataInjectingPlayer, events)
    }

    // --- NEUROBEATS -------------------------------------------------------
    // Android supprime la notification d'un service de lecture qu'il juge
    // inerte, et il juge sur l'absence d'evenements. Ce wrapper n'en
    // synthetisait aucun : il ne reliait QUE les changements de metadonnees.
    // Consequence sur un titre en pause (et lui seul) : plus rien ne se
    // passe, la notification disparait au bout de quelques minutes, et la
    // progress bar reste figee au retour dans l'application.
    //
    // On relaie donc l'etat de lecture, qui porte la vie de la session.
    override fun onIsPlayingChanged(isPlaying: Boolean) {
      listener.onIsPlayingChanged(isPlaying)
    }
  }
}"""

if texte.count(ancre) != 1:
    raise SystemExit(
        "patch expo-audio : ancre introuvable ou ambiguë "
        f"({texte.count(ancre)} occurrence(s)) — version différente ?"
    )

open(chemin, "w", encoding="utf-8").write(texte.replace(ancre, relais))
print("  ✓ expo-audio : relais de l'état appliqué")
PY
