/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: [
    '@typescript-eslint',
  ],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  env: {
    node: true,
    es2021: true,
  },
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    project: './tsconfig.json',
  },
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { 'argsIgnorePattern': '^_' }],
  },
  overrides: [
    {
      files: ['tests/**/*.ts'],
      // Bun's test runner is Jest-compatible. We define its globals here.
      globals: {
        'describe': 'readonly',
        'test': 'readonly',
        'expect': 'readonly',
        'beforeAll': 'readonly',
        'afterAll': 'readonly',
        'beforeEach': 'readonly',
        'afterEach': 'readonly',
        'it': 'readonly',
      },
      rules: {
        // It's common to use non-null assertions in tests where we can guarantee state.
        '@typescript-eslint/no-non-null-assertion': 'off',
      }
    }
  ],
  ignorePatterns: ['.eslintrc.cjs', 'node_modules', 'dist'],
};