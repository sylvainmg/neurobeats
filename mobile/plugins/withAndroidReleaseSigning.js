/**
 * Plugin Expo : configure la signature Android de distribution.
 *
 * Pourquoi un plugin, et pas un patch de `android/app/build.gradle` :
 * le dossier `android/` est genere par `expo prebuild` et gitignore
 * (`mobile/.gitignore:45`). Un patch direct serait donc ecrase a chaque
 * build CI — la signature reviendrait silencieusement a celle de debug.
 * Un plugin s'applique a chaque `prebuild`, depuis une source versionnee.
 *
 * La cle n'est jamais dans le depot : elle arrive par variable d'environnement
 * (GitHub Secrets en CI). Sans elle, le build garde la cle de debug, qui
 * produit un APK installable mais non publiable sur le Play Store.
 */
const { withAppBuildGradle, withDangerousMod } = require("expo/config-plugins");

const STORE_ENV = "ANDROID_KEYSTORE_PATH";

/** Bloc signingConfigs.release, insere dans `android { }`. */
function releaseSigningBlock(alias) {
  return `        release {
            def storePath = System.getenv("${STORE_ENV}")
            if (storePath && System.getenv("ANDROID_KEY_ALIAS")) {
                storeFile file(storePath)
                storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias System.getenv("${alias}")
                keyPassword System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
`;
}

module.exports = function withAndroidReleaseSigning(config) {
  // 1. Déclarer le signingConfig release.
  config = withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== "groovy") {
      // Le projet est en Groovy ; un build Kotlin demanderait une autre
      // implementation. On echoue plutot que de produire un build muet.
      throw new Error(
        "withAndroidReleaseSigning ne gere que build.gradle Groovy.",
      );
    }

    const contents = cfg.modResults.contents;

    if (contents.includes("ANDROID_KEYSTORE_PATH")) {
      // Deja patche (rebuild sans prebuild) : ne rien faire.
      return cfg;
    }

    if (!/signingConfigs\s*\{/.test(contents)) {
      throw new Error("android/app/build.gradle sans bloc signingConfigs.");
    }

    cfg.modResults.contents = contents.replace(
      /(\n\s*signingConfigs\s*\{)/,
      `$1\n${releaseSigningBlock("ANDROID_KEY_ALIAS")}`,
    );

    // 2. Faire pointer le buildType release dessus si la cle est presente.
    cfg.modResults.contents = cfg.modResults.contents.replace(
      /release\s*\{\s*\n(\s*)signingConfig signingConfigs\.debug/,
      (match, indent) =>
        `release {\n${indent}signingConfig System.getenv("${STORE_ENV}")\n` +
        `${indent}    ? signingConfigs.release\n` +
        `${indent}    : signingConfigs.debug`,
    );

    return cfg;
  });

  // 3. Échouer tot si la CI attend une vraie signature mais n'en fournit pas.
  // Un secret manquant ne doit pas produire un APK « release » en clé debug
  // publié sous un nom qui laisse croire à une distribution.
  config = withDangerousMod(config, [
    "android",
    (cfg) => {
      const required = process.env.NEUROBEATS_REQUIRE_RELEASE_SIGNING;
      if (required !== "1") return cfg;
      if (!process.env[STORE_ENV] || !process.env.ANDROID_KEY_ALIAS) {
        throw new Error(
          "NEUROBEATS_REQUIRE_RELEASE_SIGNING=1 mais les variables " +
            `${STORE_ENV} / ANDROID_KEY_ALIAS sont absentes. ` +
            "Configure les secrets GitHub, ou retire l'variable pour " +
            "accepter un build en cle de debug.",
        );
      }
      return cfg;
    },
  ]);

  return config;
};
