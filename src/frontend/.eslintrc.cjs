/* eslint-env node */
module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    node: true
  },
  extends: [
    'eslint:recommended',
    'plugin:vue/vue3-recommended'
  ],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module'
  },
  rules: {
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    'vue/multi-word-component-names': 'off',
    // The codebase has zero v-html; keep it that way (XSS surface). If a
    // genuine need appears, sanitize with DOMPurify and disable per-line.
    'vue/no-v-html': 'error',
    'vue/require-default-prop': 'off',
    'vue/max-attributes-per-line': 'off',
    'vue/singleline-html-element-content-newline': 'off',
    'vue/html-self-closing': 'off',
    'vue/no-use-v-if-with-v-for': 'warn'
  },
  ignorePatterns: ['node_modules/', 'dist/']
};
