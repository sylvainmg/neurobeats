const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// expo-sqlite (web) importe statiquement son moteur wa-sqlite en .wasm :
// sans cette extension dans les assets, Metro ne résout pas la dépendance et
// le bundle web casse au démarrage.
config.resolver.assetExts.push("wasm");

module.exports = config;