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
    // v-html is an XSS surface, so it stays an error and is disabled per-line
    // with a reason. Exactly one place does that today: MarkdownViewer, whose
    // renderer (components/modules/markdown-render.js) escapes its input BEFORE
    // any rule runs and emits only tags it wrote itself — so there is no raw
    // HTML passthrough to sanitise. Anything else needs the same argument or
    // DOMPurify.
    'vue/no-v-html': 'error',
    'vue/require-default-prop': 'off',
    'vue/max-attributes-per-line': 'off',
    'vue/singleline-html-element-content-newline': 'off',
    'vue/html-self-closing': 'off',
    'vue/no-use-v-if-with-v-for': 'warn'
  },
  ignorePatterns: ['node_modules/', 'dist/']
};
