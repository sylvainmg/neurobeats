const path = require("node:path");

const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// expo-sqlite (web) importe statiquement son moteur wa-sqlite en .wasm :
// sans cette extension dans les assets, Metro ne résout pas la dépendance et
// le bundle web casse au démarrage.
config.resolver.assetExts.push("wasm");

// `shared/` est la source de vérité du contrat de mise à jour (voir
// shared/update/README.md) : il est consommé tel quel par le desktop ET par le
// mobile, pour que la règle « quand proposer une mise à jour » ne puisse pas
// diverger entre les deux plateformes.
//
// Le dossier vit hors de `mobile/`, donc Metro ne le surveille pas par défaut et
// ne le résout pas : sans ces deux lignes, le bundle Android échoue sur
// « Unable to resolve module ». `watchFolders` leDeclare comme racine
// surveillée, `extraNodeModules` donne la racine du dépôt comme point de
// résolution pour un `@neurobeats/*`.
config.watchFolders = [path.resolve(__dirname, "..")];
config.resolver.extraNodeModules = {
  "@neurobeats/shared": path.resolve(__dirname, "../shared"),
};

module.exports = config;
