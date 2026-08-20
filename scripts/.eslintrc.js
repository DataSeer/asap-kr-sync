/**
 * Lint for the scripts, which had none.
 *
 * `src/backend/.eslintrc.js` does not reach outside its own directory, so
 * `scripts/` — 34 files, several of them touching the database and the LM
 * services — was checked by nothing but `node --check`. That is syntax only: it
 * would not have caught the `require` of a module that had been renamed away,
 * which is exactly what had happened in `dev/benchmark-detections.js`.
 *
 * Same rules as the backend, with two differences that reflect what these files
 * are: they are CommonJS command-line tools, so `process.exit` and top-level
 * `console` are the interface, not a smell.
 */

module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true
  },
  extends: ['eslint:recommended'],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'script'
  },
  rules: {
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    'no-console': 'off',
    'no-control-regex': 'off',
    'semi': ['error', 'always'],
    'quotes': ['error', 'single', { avoidEscape: true }]
  },
  ignorePatterns: ['node_modules/']
};
