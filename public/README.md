# Publication

Ce dossier accueille les fichiers **réellement publiés**, que
`scripts/mkversions.mjs` hache ensuite pour produire `versions.json`. Rien n'y
est versionné : ce sont des fichiers de plusieurs centaines de mégaoctets, et
GitHub refuse au-delà de 100 Mo dans un dépôt.

## Ce qui doit s'y trouver

| Clé de manifeste | Fichier | Construit par |
|---|---|---|
| `linux-x64` | `NeuroBeats-0.1.0-x86_64.AppImage` | `cd desktop && npm run package:linux` |
| `win32-x64` | `NeuroBeats-0.1.0-win-setup.exe` | `cd desktop && npm run package:win` |
| `android` | `NeuroBeats-0.1.0.apk` | `bash scripts/build-apk.sh` |

Puis :

```bash
node scripts/mkversions.mjs 0.1.0 \
  --sortie public/versions.json \
  --base "https://github.com/sylvainmg/neurobeats-releases/releases/download/v0.1.0/" \
  --note "Ce que change cette version" \
  --artefact linux-x64=public/NeuroBeats-0.1.0-x86_64.AppImage \
  --artefact win32-x64=public/NeuroBeats-0.1.0-win-setup.exe \
  --artefact android=public/NeuroBeats-0.1.0.apk
```

`--base` est **obligatoire**, et doit être en HTTPS. Ce n'est pas de la
redondance : l'URL du manifeste est compilée dans les artefacts, donc un
manifeste publié avec une racine fausse produirait des applications qui
interrogent un domaine inexistant — en silence, puisque l'échec d'une
vérification ne se signale pas. Le script refuse de deviner à votre place.

`--base` désigne le tag, pas `latest` : les URL d'artefacts doivent être
immuables, pour que l'empreinte annoncée corresponde au fichier servi même si
une version plus récente est publiée entre-temps.

## Les trois cibles se construisent ici, sur cette machine

Le macOS est abandonné. Les deux autres se construisent sous Linux :

- **AppImage** : `npm run package:linux`.
- **`.exe`** : `npm run package:win`, via wine. Le runtime Python embarqué est
  celui de la **cible** — `pip` y installe des wheels `win_amd64` — donc c'est le
  Python Windows qui fait le travail, sous wine. Vérifié : CPython 3.13.15 et les
  38 dépendances s'installent, et les extensions natives sont bien
  `PE32+ ... win_amd64`. L'installateur a été testé sur une machine Windows
  réelle.
- **APK** : `bash scripts/build-apk.sh`, qui lit `~/.neurobeats-signing.env` et
  refuse de démarrer si la clé est inaccessible.

Les dossiers de staging (`bin/`, `runtime/`, `.runtime/backend-package/`) sont
**partagés** entre les cibles : construire l'une après l'autre écrase le runtime
de la précédente. Un marqueur `.cible` les purge quand la cible change, mais
l'ordre reste à respecter. Copiez les artefacts dans `public/` entre deux builds.

## L'APK est signé en clé de distribution

C'est la condition qui rend l'auto-mise à jour possible : Android refuse
d'installer un paquet signé par une autre clé que celle de l'application
installée. La première version publiée engage la clé — au-delà, changer de
signature oblige les utilisateurs à réinstaller et perd leurs données.

La clé est créée par `bash scripts/creer-cle-android.sh`, qui demande le mot de
passe une seule fois et l'écrit aux deux endroits nécessaires. **Sauvegardez
l'archive `.jks` hors de cette machine.** Elle n'est dans aucun dépôt : la
reconstruire est impossible.

Depuis `minSdk 29` et le schéma v3, l'APK se met à jour tout seul. Sans v3, la
perte de la clé condamnerait l'application définitivement.

## Un build de test se fait sans ces variables

Sans clé, l'APK retombe en signature debug et l'application doit refuser de
proposer une mise à jour qu'Android refuserait d'appliquer : buildsez alors avec
`EXPO_PUBLIC_MAJ_AUTO_INSTALLABLE=0`. `scripts/build-apk.sh` fait l'inverse, et
échoue si l'une des deux conditions est fausse.
