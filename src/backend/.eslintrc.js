module.exports = {
  env: {
    node: true,
    es2022: true,
    jest: true
  },
  extends: ['eslint:recommended'],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module'
  },
  rules: {
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    'no-console': 'off',
    'no-control-regex': 'off', // Allow control characters in regex for file validation
    'semi': ['error', 'always'],
    'quotes': ['error', 'single', { avoidEscape: true }]
  },
  ignorePatterns: ['node_modules/', 'coverage/']
};
