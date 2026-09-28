/**
 * Point d'entrée du cœur de mise à jour, partagé par Electron et React Native.
 *
 * Ce dossier vit à la racine du dépôt et non dans `mobile/` ou `desktop/` :
 * la règle qui décide de proposer une mise à jour ne doit pas pouvoir diverger
 * entre les deux plateformes. Le mobile y accède par l'alias
 * `@neurobeats/shared/*` (voir `mobile/metro.config.js` et
 * `mobile/tsconfig.json`), le desktop par un chemin relatif.
 */

export * from "./version";
export * from "./manifest";
export * from "./policy";
export * from "./integrite";
export * from "./sha256";
