// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
  },
  {
    rules: {
      // La copie de l'app est en français : les apostrophes s'y écrivent « ' ».
      // Les entités HTML ne sont pas une option ici — React Native ne les
      // interprète pas, et « l&apos;app » s'afficherait tel quel à l'écran.
      "react/no-unescaped-entities": "off",
    },
  },
]);
