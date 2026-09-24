# Patch expo-audio — boutons précédent / suivant (notification + verrou)

Ajoute `showSkipPrevious` / `showSkipNext` aux options de session de lecture,
et relaie l'appui vers `sessionNavigation` (direction `previous` / `next`).
La file n'existant que côté JavaScript (mobile/src/playback/lecteur.ts),
le module n'implémente pas de navigation native : il émet la direction,
et `lecteur.ts` la traduit en `precedent()` / `suivant()`.

## Fichiers patchés (expo-audio 57.0.5)

| Fichier | Changement |
| --- | --- |
| `android/.../audio/AudioRecords.kt` | `AudioLockScreenOptions` + `showSkipPrevious` / `showSkipNext` |
| `android/.../service/AudioControlsService.kt` | Actions `ACTION_NAV_PREVIOUS`/`ACTION_NAV_NEXT` ; boutons prev/next dans `buildNotification` (pré-S_V2) et `updateSessionCustomLayout` (écran de contrôle media3) ; dispatch `onNavigate` |
| `android/.../service/AudioMediaSessionCallback.kt` | Session commands `SESSION_COMMAND_NAV_PREVIOUS/NEXT` + callback `onNavigate` |
| `android/.../audio/AudioPlayer.kt` | `envoyerNavigation(direction)` → événement `sessionNavigation` |
| `src/AudioModule.types.ts` + `build/AudioModule.types.d.ts` | `AudioEvents.sessionNavigation` |
| `src/AudioConstants.ts` + `build/AudioConstants.d.ts` | Doc des options prev/next |

## ⚠️ Points non évidents

1. **`expo-audio` est un module précompilé (`[📦] expo-audio`)** : il expire un
   AAR dans `android/local-maven-repo/`, et le build Gradle ne compile PAS
   `android/src`. Pour que les patches Kotlin comptent, `package.json` force la
   compilation depuis les sources :
   ```json
   "expo": { "autolinking": { "buildFromSource": ["expo-audio"] } }
   ```
2. En media3 1.9.0, `CommandButton` expose `ICON_PREVIOUS` / `ICON_NEXT`
   (pas `ICON_SKIP_TO_PREVIOUS` / `ICON_SKIP_TO_NEXT`).
3. La camelCase des actions custom vient de media3 (les action strings sont
   normalisées en CamelCase) : les `SessionCommand(ACTION_NAV_PREVIOUS, ...)`
   arrivent bien dans `onCustomCommand`.
4. `groupeDe`/fichiers de la notif de téléchargement : sans rapport, voir
   `mobile/modules/downloader`.

## Ré-appliquer après un `npm install`

```bash
cd mobile && bash patches/install-expo-audio-patch.sh
```

## Régénérer le patch (après modification de mobile/node_modules/expo-audio)

```bash
# depuis la racine du dépôt
npm pack expo-audio@57.0.5 --silent && mv expo-audio-57.0.5.tgz /tmp/opencode/
cd /tmp/opencode && tar -xzf expo-audio-57.0.5.tgz -C expo-audio-pristine
# puis reconstruire le diff comme indiqué dans install-expo-audio-patch.sh
```