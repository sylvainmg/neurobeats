# À publier

Ce dossier accueille les trois artefacts prêts à être téléversés, plus le
manifeste `versions.json` que l'application va interroger.

## Où

Dépôt dédié : **`sylvainmg/neurobeats-releases`** (public), via les **GitHub
Releases** — pas des fichiers dans une branche. Le `.exe` pèse 389 Mo et
l'AppImage 352 Mo ; GitHub refuse tout fichier de plus de 100 Mo dans un dépôt,
alors que les Releases acceptent 2 Go par asset. Même raisonnement que
`pioneer-releases`.

| Clé de manifeste | Fichier | Plate-forme |
|---|---|---|
| `android` | `NeuroBeats-1.0.0.apk` | Android 10+ |
| `linux-x64` | `NeuroBeats-1.0.0-x86_64.AppImage` | Linux (toutes distros, sans installation) |
| `win32-x64` | `NeuroBeats-1.0.0-win-setup.exe` | Windows x64 |

## L'URL que l'application interroge

```
https://github.com/sylvainmg/neurobeats-releases/releases/latest/download/versions.json
```

Le mot `latest` est un alias que GitHub recalcule à chaque version. C'est
indispensable : l'URL est **compilée dans les artefacts**, donc une version en
dur ne fonctionnerait que pour les applications construites *après* cette
version — c'est-à-dire jamais, puisque le contrôle sert justement à mettre à
jour celles qui la précèdent. Une fois cette constante gravée, elle est valable
pour toutes les versions futures.

Les URL **d'artefacts** contenues dans le manifeste pointent en revanche vers le
tag (`releases/download/v1.0.0/…`) : elles sont immuables, donc l'empreinte
annoncée correspond toujours au fichier servi.

## L'ordre compte

1. téléverser les trois artefacts ;
2. **puis** `versions.json` en dernier.

L'application ne vérifie qu'une fois par 24 h, et seulement au lancement. Si le
manifeste est publié avant les fichiers, un utilisateur peut lire « mise à jour
disponible » et tomber sur un 404 au téléchargement. C'est le seul ordre qui
l'évite.

## Publier

Un seul script fait le travail, dans le bon ordre, et reconstruit le manifeste
à partir des fichiers réellement présents — donc une empreinte ne peut pas
diverger du fichier qu'elle annonce.

```bash
# les trois artefacts doivent être dans public/
bash scripts/publier.sh "Première version publique."
```

Il téléverse les trois fichiers, puis `versions.json` **en dernier**, puis
affiche le nombre d'octets et le début de l'empreinte de chacun.

## Remplacer les fichiers d'un tag déjà publié

`--clobber` écrase l'asset existant : `scripts/publier.sh` s'en sert. C'est
voulant — tant que personne n'a téléchargé, corriger une icône ne justifie pas
de publier une 1.0.1 cosmétique. Cela **change le sha256** pour qui avait déjà
pris le fichier ; vérifiez le compteur de téléchargements avant.

Le jour où une version est réellement partie chez des utilisateurs, on n'écrase
plus : on change `version` dans `public/versions.json`, on reconstruit les trois
artefacts avec cette version, et on crée un tag neuf.

## Vérifier après téléversement

```bash
node scripts/verifier-publication.mjs
```

Le script interroge l'hébergement public et contrôle 21 points : le manifeste
répond, chaque URL répond 200, les tailles servies correspondent à celles
annoncées, la politique de mise à jour n'est jamais modale et n'interrompt pas
la lecture.

Pour un contrôle manuel, sans le script :

```bash
B=https://github.com/sylvainmg/neurobeats-releases/releases/latest/download

# 1. le manifeste répond, sans authentification
curl -sL "$B/versions.json" | python3 -m json.tool

# 2. chaque URL du manifeste répond 200
curl -s "$B/versions.json" | python3 -c "
import json,sys
for k,a in json.load(sys.stdin)['artifacts'].items(): print(a['url'])
" | while read -r u; do
  printf '  %-42s HTTP %s\n' "$(basename "$u")" "$(curl -sILo /dev/null -w '%{http_code}' "$u")"
done

# 3. l'empreinte correspond au fichier réellement téléchargé
curl -sL "$B/versions.json" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['artifacts']['linux-x64']['sha256'])" \
  | tr 'a-f' 'A-F' > /tmp/attendu.txt
curl -sL "$B/NeuroBeats-1.0.0-x86_64.AppImage" | sha256sum | cut -d' ' -f1 | tr 'a-f' 'A-F' \
  | diff - /tmp/attendu.txt && echo "  empreinte conforme"
```

L'application refuse d'installer un fichier dont l'empreinte ne correspond pas :
c'est une garantie, pas une contrainte de publication. Si le transport altère un
octet, l'utilisateur verra un message d'échec clair plutôt qu'un installeur
inconnu.

## Changer d'hébergement sans reconstruire

L'URL est une constante, mais elle reste surchargeable à l'exécution :

```bash
# desktop, au lancement
NEUROBEATS_UPDATE_MANIFEST=https://…/versions.json <lancement>

# ou, durablement, sur l'installation d'un utilisateur
~/.config/NeuroBeats/update-manifest.json   {"url": "https://…/versions.json"}
```

Pour une correction définitive dans les artefacts, change la constante
(`desktop/src/shared/constants.ts` et `mobile/src/update/service.ts` — les deux
doivent rester identiques) et reconstruis les trois cibles.

## Réserves connues

- **L'avertissement SmartScreen** apparaîtra sur le `.exe` tant qu'il n'est pas
  signé avec un certificat de signature de code. Un double-clic suffit à passer.
- **La première installation de l'APK est le vrai test du schéma v3.** Il est
  signé v3 seul, ce qui convient à `minSdk 29` — mais il n'a jamais été installé
  sur un appareil. Un refus serait immédiat et visible, jamais silencieux. En cas
  de refus : `enableV3Signing false` dans
  `mobile/plugins/withAndroidReleaseSigning.js`, puis rebuild.
- **Le contrôle de mise à jour n'a jamais été observé de bout en bout.** La
  logique est prouvée par des tests, et la chaîne a été vérifiée sur un vrai
  serveur HTTP, mais personne n'a vu la pastille apparaître. Le premier
  lancement après publication est le vrai test.
