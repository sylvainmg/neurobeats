# Mise à jour — contrat partagé

Ce dossier est la **source de vérité unique** de la vérification de mise à jour.
Il est compilé tel quel dans les deux applications :

| Plateforme | Accès | Build |
|---|---|---|
| React Native (`mobile/`) | alias `@neurobeats/shared/update` | `mobile/metro.config.js` déclare `watchFolders` + `extraNodeModules` |
| Electron (`desktop/`) | chemin relatif `../../../shared/update` | esbuild le bundle dans `dist/main/index.js` |

La règle qui décide de parler à l'utilisateur ne peut donc pas diverger entre les
deux plateformes : elle n'est écrite qu'une fois, dans `policy.ts`, et testée une
seule fois.

Aucune dépendance, aucun import natif : ces modules doivent rester compilables
dans un bundle Hermes comme dans un processus Node.

## Le manifeste

Un `versions.json` statique, publié à côté des artefacts :

```json
{
  "version": "0.2.0",
  "released_at": "2026-09-27T18:00:00Z",
  "mandatory": false,
  "notes": "Ce que change cette version",
  "artifacts": {
    "linux-x64": {
      "file": "NeuroBeats-0.2.0-x86_64.AppImage",
      "url": "https://github.com/sylvainmg/neurobeats-releases/releases/download/v0.2.0/NeuroBeats-0.2.0-x86_64.AppImage",
      "sha256": "…64 caractères hexadécimaux…",
      "size": 385351680
    }
  }
}
```

Les clés reprennent la convention de `desktop/scripts/*.json` : `linux-x64`,
`linux-arm64`, `win32-x64`, `darwin-x64`, `darwin-arm64`, `android`.

Il est produit par `scripts/mkversions.mjs`, qui hache les fichiers **réellement
publiés** — jamais une empreinte recopiée d'un build :

```bash
node scripts/mkversions.mjs 0.2.0 \
  --sortie public/versions.json \
  --base "https://github.com/sylvainmg/neurobeats-releases/releases/download/v0.2.0/" \
  --note "Ce que change cette version" \
  --artefact linux-x64=public/NeuroBeats-0.2.0-x86_64.AppImage \
  --artefact win32-x64="public/NeuroBeats Setup 0.2.0.exe" \
  --artefact darwin-arm64=public/NeuroBeats-0.2.0-arm64.dmg \
  --artefact android=public/app-release.apk
```

### Pourquoi un manifeste et pas l'API GitHub Releases

1. il porte le `sha256` — on ne lance jamais un installateur sans vérifier ;
2. pas de limite de débit ni de jeton : le téléphone d'un utilisateur n'a pas de
   compte GitHub et ne doit pas se faire refuser une vérification ;
3. servable en statique n'importe où, donc hébergement gratuit et remplaçable.

## La règle : ne pas harceler

`policy.ts` est l'unique arbitre. Il rend un **bruit**, jamais une décision
d'affichage :

| Bruit | Ce que l'utilisateur voit |
|---|---|
| `rien` | rien |
| `silencieux` | une pastille discrète, rien d'autre |
| `information` | un toast qui s'efface seul (5 s) |
| `proposition` | un bandeau actionnable, qui se replie seul |
| `obligatoire` | un bandeau qui attend une décision |

L'ordre des filtres, du moins coûteux au plus engageant :

1. pas de manifeste, pas de version plus récente → `rien` ;
2. **pas d'artefact pour la plateforme** → `rien`. On n'annonce pas ce qu'on ne
   peut pas livrer ;
3. version explicitement ignorée → `rien`, définitivement ;
4. version obligatoire → court-circuite le report et la cadence ;
5. report en cours → `silencieux` ;
6. déjà signalée 2 fois → `silencieux` ;
7. **lecture en cours** → `silencieux`. On n'interrompt jamais une piste ;
8. première mention → `information`, sinon `proposition`.

Trois garanties vérifiables :

- **Jamais deux fois de suite le même signal.** Le compteur part de zéro à chaque
  nouvelle version : on ne punit pas l'utilisateur d'avoir ignoré la précédente.
- **« Ignorer » est définitif** pour la version visée, et survit au redémarrage
  (état sur disque).
- **Un contrôle automatique par 24 h minimum**, avec un doublement de l'attente à
  chaque échec, plafonné à 7 jours. Un réseau en panne ne produit pas une
  requête par lancement.

## Sécurité de l'installation

L'artefact téléchargé n'est **jamais** exécuté avant vérification :

1. URL résolue puis refusée si le transport n'est pas HTTPS ;
2. condensat calculé **pendant** l'écriture (le fichier dépasse 300 Mo : le
   relire ensuite le chargerait en mémoire) ;
3. comparaison à temps constant (`integrite.ts`) ;
4. en cas d'écart, le fichier est supprimé et rien n'est lancé.

`sha256.ts` est une implémentation TypeScript pure, car `node:crypto` n'existe
pas sur React Native et le projet n'a pas de dépendance native de hachage. Elle
est validée contre les vecteurs FIPS 180-4 **et** contre `node:crypto` sur une
charge réelle — c'est cette comparaison croisée qui garantit que le mobile et le
desktop ne divergent pas. Le desktop, lui, garde `node:crypto` : plus rapide, et
sans raison de s'en priver.

## Contrainte propre à Android

Android refuse d'installer un paquet signé par une autre clé que celle de
l'application installée. Deux conséquences, à connaître avant toute publication :

1. la **première** version distribuée doit être signée en clé de distribution ;
   depuis une clé de debug, aucune auto-mise à jour ne sera jamais possible ;
2. `mobile/src/update/service.ts` détecte un build de développement et ne promet
   alors rien, plutôt que de faire télécharger 40 Mo qui échoueront à
   l'installation.

## Deux pièges de build trouvés en tentant de publier Windows

Ils sont consignés parce qu'ils sont invisibles sur un build natif, et que le
symptôme (un produit qui s'installe sans audio) ne désigne pas sa cause.

1. **Cible ≠ machine.** Tous les scripts de preparation lisaient
   `process.platform` : un `.exe` assemblé sur Linux embarquait donc `mpv`,
   `ffmpeg` et `ffprobe` **du systeme**, en ELF et sans extension `.exe`. La
   variable `NEUROBEATS_TARGET_PLATFORM` distingue desormais la cible, et
   `formatAttendu()` compare la charge utile a cette cible — un binaire present
   mais de la mauvaise plate-forme echoue désormais le build au lieu de
   disparaitre.

2. **`pip` doit tourner sur la cible.** Les dependances backend ne peuvent etre
   installees que par l'interpreteur de la cible, puisque ce sont des wheels
   `win_amd64`. Depuis Linux ou macOS, ce runtime passe par wine. Deux details
   ont casse l'operation avant que ca ne marche :
   - le runtime Windows de python-build-standalone place `python.exe` et ses DLL
     **a la racine**, alors que `config.ts` attend `python/bin/python.exe`. La
     normalisation copiait l'executable seul, et il sortait en code 53 : sous
     Linux le deplacement fonctionne grace au `RPATH $ORIGIN/../lib`, sous
     Windows le chargeur ne cherche les DLL qu'a cote de l'executable. Les DLL
     de la racine sont donc desormais copiees avec lui ;
   - le cache Python etait marque par un `.ready` unique, si bien qu'un build
     Windows relisait le chemin du runtime **Linux**. Le marqueur est indexe par
     plate-forme.

## Régler l'hébergement

Une seule constante par plateforme :

- desktop : `URL_MANIFSTE_MAJ` dans `desktop/src/shared/constants.ts`
- mobile : `URL_MANIFESTE_MAJ` dans `mobile/src/update/service.ts`

Surchargées sans reconstruire par `NEUROBEATS_UPDATE_MANIFEST` (desktop),
`EXPO_PUBLIC_UPDATE_MANIFEST` (mobile), ou par un fichier
`update-manifest.json` dans le dossier de données utilisateur du desktop.
