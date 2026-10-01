import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'drizzle/**', 'coverage/**'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'scripts/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      complexity: ['warn', 10],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
];
