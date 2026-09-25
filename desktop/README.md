# NeuroBeats — App desktop (conteneur Electron)

L'application desktop embarque **backend** (FastAPI + moteur mpv) et **interface**
(Next.js) dans un seul processus Electron : le backend ne vit que pendant
l'exécution de l'app, aucun service à installer à côté.

`web/` est un périmètre **read-only** : aucun fichier de `web/` n'est modifié ni
par le build ni au runtime.

## Concepts

| Brique | Rôle |
| --- | --- |
| `src/main/` | Orchestration Electron : backend, frontend, splash, tray, arrêt |
| `src/preload/` | Pont minimal + panneau local IA (l'UI web/ reste inchangée) |
| `backend/` | Moteur FastAPI + mpv + worker de téléchargement (enfant isolé) |
| `web/` | Interface Next.js ; servie en dev par `next dev`, en prod par le build standalone |

### Ports — et coexistence avec le backend de dev

L'app a des **ports dédiés** : elle ne touche jamais à ceux du workflow de dev.
Vous pouvez donc garder votre backend dev (qui joue) ouvert ET lancer l'app à
côté — chacun son moteur, chacun son daemon mpv (socket mpv scopé par port).

| | App desktop (conteneur) | Workflow dev (dev.sh) |
| --- | --- | --- |
| Backend | **8041** (dédié) | 8040 (`web/.env.local`) |
| Interface | **3150** | 3100 |
| Socket mpv | `/tmp/neurobeats-mpv-8041.sock` | `/tmp/neurobeats-mpv-8040.sock` |

Surcharges : `NEUROBEATS_PORT` (backend), `NEUROBEATS_FRONTEND_PORT` (page). Si
vous changez le port backend, le build standalone doit être fait avec
`NEUROBEATS_API_URL=http://localhost:<port> npm run standalone` (l'URL API est
inlinée au build).

L'URL API est injectée automatiquement par l'app : en dev (`next dev`), la page
reçoit `NEXT_PUBLIC_API_URL` pointant sur le port de l'app (prioritaire sur
`web/.env.local`, sans modifier le fichier) ; en prod, le build standalone la
contient en dur à la construction.

Si un port est néanmoins occupé par un process externe → message clair, et
l'app refuse de démarrer (isolation). Le `/api/health` porte en plus un
`instance_id` propre au `userData` et au port ; Electron n'accepte que l'enfant
qu'il a lancé, même si un autre NeuroBeats répond sur le même port.

## Isolation des données

Les trois modes ne partagent ni base SQLite, ni JSON, ni historique, ni
statistiques, ni profil, ni réglages IA, ni caches, ni modèles, ni manifeste, ni
socket mpv :

| Mode | Volume principal | Modèles |
| --- | --- | --- |
| Web via `dev.sh` | `~/.local/share/neurobeats/web` | `.../web/models` |
| Electron développement | `~/.config/NeuroBeats-dev` | `~/.config/NeuroBeats-dev/models` |
| AppImage installée | `~/.config/NeuroBeats` | `~/.config/NeuroBeats/models` |

Sous Linux, le volume web suit `XDG_DATA_HOME`. Pour tester une instance
Electron isolée, `NEUROBEATS_USER_DATA_DIR=/tmp/...` remplace le volume
`userData`. Un backend lancé directement sans `NEUROBEATS_DATA_DIR` utilise son
profil `web` et ne retombe plus dans `backend/neurobeats.db`. Les anciennes
données placées directement dans `backend/` ne sont jamais fusionnées
automatiquement.

## Démarrage

```bash
# Mode développement (backend .venv local + next dev)
cd desktop && npm install && npm run dev

# Mode production locale du front (build standalone dans une COPIE de web/)
cd desktop && npm run standalone   # produit .runtime/web-standalone (~5-10 min)
npm run start                      # bascule automatiquement sur le standalone
```

`NEUROBEATS_STANDALONE_DIR` force le répertoire standalone ; sinon l'app bascule
sur `next dev` (mode dev) ou `resources/web` (packagé).

## Comportement & raccourcis

- **Fermer la fenêtre = quitter réellement.** La croix, `Ctrl/Cmd+Q`,
  `SUPER+Q`/Hyprland, le menu ou le tray, les signaux et la fermeture de session
  convergent tous vers le même nettoyage idempotent.
- L'arrêt attend la fin du frontend et du backend, coupe les descendants
  (`mpv`, `llama-server`, workers), puis escalade vers `SIGKILL` après le délai
  de grâce. Aucun processus web ou aucune autre instance n'est tué.
- **Reprise après un `SIGKILL`** : les enfants détachés survivent au main (ppid 1)
  et occuperaient les ports au relancement. Le reaper Linux ne récolte que les
  processus marqués avec le **même `userData`, profil et port** (backend, mpv,
  `llama-server`, workers de modèles, `next dev` et son leader `npm`) ; un
  occupant non NeuroBeats, ou le backend web, reste intact et le refus de
  démarrage s'applique normalement.
- **Splash** : progression réelle (backend → interface).
- **Moteur arrêté** (crash interne) : dialog + relance automatique (max 3 en 60 s).
- **Interface arrêtée** : relance automatique limitée (2 en 60 s), puis dialog.
- **Modèle IA local** : recommandations matérielles, téléchargement durable avec
  pause/reprise/annulation, puis démarrage de `llama-server` et activation du
  provider `embedded`. Un job interrompu par le redémarrage revient en erreur et
  n'est jamais relancé automatiquement (« Réessayer » reprend le même staging).
  Le `.incomplete` est conservé après une pause **et** après un échec :
  « Réessayer » et « Reprendre » relancent le même job dans le même staging
  (un seul staging par modèle), « Supprimer le partiel » annule un job en échec
  et nettoie son staging. Le staging disparaît après succès ou annulation.
  « Supprimer » sur un modèle installé purge le `.gguf` et nettoie le manifeste
  (le moteur est arrêté s'il l'utilisait). Les logs de `llama-server` sont dans
  `userData/models/llama-<id>.log`.

## Modèles IA : téléchargement au premier usage (pas d'offline total)

L'installateur ne contient **aucun `.gguf`** : il embarque le moteur
(`llama.cpp` dans `resources/runtime`), le catalogue curé
(`backend/services/curated_models.json`, 7 modèles vérifiés) et le worker de
téléchargement. Le premier usage nécessite donc du réseau : le panneau IA
(Profil → IA locale) télécharge le modèle choisi dans `userData/models`, puis
`llama-server` démarre en local (port dynamique, API OpenAI-compatible) — le
chat tourne ensuite 100 % hors-ligne.

Tailles indicatives (disque) : qwen3-4b ~2,3 Go · qwen3-8b ~4,7 Go ·
granite-4.1-8b ~5 Go · llama-3.1-8b ~4,6 Go · gemma-4-12b ~6,7 Go ·
qwen3-14b ~8,4 Go · gpt-oss-20b ~11,3 Go. Prévoir ~2× pendant le transfert
(staging + fichier final sur deux volumes).

### Choix IA : une seule source de vérité

Le choix du modèle est **un enregistrement unique**, persisté sous
`ai.selection` (`{"kind": "embedded", "model": "qwen3-8b"}` ou
`{"kind": "ollama"}`). Une seule fonction l'écrit (`llm.set_selection`) et une
seule le lit (`llm.active_selection`) ; `provider` dans les réponses n'en est
qu'un dérivé. Conséquences, valables partout (onglet IA, panneau local, chat,
habillages) :

- un seul modèle est actif : choisir un modèle local **ou** enregistrer un
  fournisseur externe désélectionne tout le reste — les autres entrées sont
  marquées « Inactif » ;
- choisir un modèle local **le charge** (l'ancien est déchargé au préalable) :
  le moteur ne sert jamais un modèle qui n'est pas la sélection ;
- au démarrage, le modèle local sélectionné est chargé en arrière-plan (~1 min,
  sans bloquer l'app) : c'est le sens de « un seul modèle actif ». Pour libérer
  la mémoire, choisissez un fournisseur externe (le moteur s'arrête) ;
- le chargement est **asynchrone et observable** : `GET /api/profile/ai/embedded`
  renvoie `idle` · `loading` · `ready` · `error`, et l'interface affiche la
  progression plutôt que d'attendre une requête bloquante.

### Modèles hors catalogue (navigateur Hugging Face)

L'onglet « Télécharger » propose **« Parcourir Hugging Face »** : un modal cherche
les dépôts GGUF du Hub, liste leurs fichiers avec quantification, taille et
verdict de compatibilité avec la machine, et lance le téléchargement du fichier
choisi. Aucun choix n'est interdit — une quantification sous `Q4_K_M` est
signalée (fiabilité des appels d'outils) mais reste téléchargeable.

Un modèle du Hub suit ensuite **exactement** le même flux qu'un modèle curé : il
apparaît dans « Mes modèles », entre dans la sélection unique, se charge sur le
GPU et se supprime. C'est le **manifeste** qui porte son entrée (`repo`,
`pattern`, `ctx`), relue par `models._entry` — il n'y a donc pas de second
fichier de modèles à maintenir. Son `ctx` vaut 8192 par défaut (les métadonnées
GGUF ne sont pas lues).

**Garde-fou d'espace disque** : aucun téléchargement ne démarre si le modèle ne
tient pas sur le disque (taille **inconnue** incluse → refus, faute de pouvoir
vérifier), avec 300 Mo de marge. Le staging vivant dans le dossier des modèles,
la publication est un simple renommage : seule la partie à télécharger est
comptée (une reprise avancée reste donc possible). Si le disque se remplit
**pendant** un transfert, le job est arrêté proprement, fragment conservé et
reprenable après nettoyage.

### Synchronisation des deux interfaces

Le choix apparaît à deux endroits dans l'onglet IA : le panneau « Modèles IA
locaux » (injecté par le preload) et le formulaire « Modèle d'IA » (React). Les
deux écrivent la **même** source (`llm.set_selection`) et se préviennent par un
événement DOM partagé (`neurobeats:ai-selection`) dès qu'un choix change, doublé
d'un sondage de 10 s comme filet. Sans ce pont, chacun gardait son cache et
affichait un modèle différent.

### Moteur d'inférence : GPU si disponible

`resources/runtime` embarque le build **Vulkan** de llama.cpp (même version
épinglée que le reste) : si un GPU Vulkan est présent, les couches y sont
placées, sinon le backend CPU embarqué prend le relais. La répartition est
laissée à llama.cpp (`--n-gpu-layers` vaut `auto` par défaut) : forcer « tout en
VRAM » désactive son ajustement et fait chuter le préfill — mesuré sur une
RTX 4070, 1143 t/s en auto contre 60 t/s en forçant. Pour imposer une valeur :
`NEUROBEATS_GPU_LAYERS=<n>`.

## Bouts de backend fournis par l'app

- `backend/` : venv existant en dev ; `extraResources/backend` (python-build-
  standalone + venv) en production.
- `mpv` / `ffmpeg` : binaires de plateforme dans `resources/bin` (ou
  `desktop/runtime` en dev), injectés dans le `PATH` du backend.
- Modèles GGUF : `userData/models` (`NEUROBEATS_MODELS_DIR`).

## Packaging (electron-builder, P2/P4)

Cibles déclarées : AppImage (Linux), dmg (macOS), nsis (Windows). `extraResources` :
`backend/`, `web/` (standalone), `bin/` (mpv/ffmpeg), `runtime/` (llama-server).
L'icône `build/icon.png` est synchronisée depuis `web/assets/logo-mark.png` et
utilisée par l'AppImage, la fenêtre, le tray et le menu système.

## Limites connues

- Port 8041 occupé par un autre service non-NeuroBeats → message clair au boot.
- Le provider `embedded` nécessite un modèle téléchargé (l'écran IA gère le flux).
- Sans `llama-server` dans `resources/runtime`, le téléchargement reste possible
  mais `embedded/start` échoue avec un message explicite (panneau IA).
- Win/Mac : les modèles se rangent désormais sous `neurobeats/<profil>/models`
  (profil inclus) ; les `.gguf` de l'ancien dossier sans profil sont migrés
  automatiquement au premier démarrage.