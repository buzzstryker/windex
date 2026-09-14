// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const globals = require('globals');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', 'scripts/history-chart/build/*'],
  },
  {
    // Node-run scripts. eslint-config-expo lints every .js with browser globals
    // and grants Node's only to metro.config.js.
    files: ['scripts/**/*.js'],
    languageOptions: { globals: globals.node },
  },
]);
