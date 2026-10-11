// ESLint flat config (ESLint 9) — SmallClaw minimal set.
// Philosophy: small-model friendly gateway; keep rules that catch real bugs,
// silence style noise. Prettier stays a separate formatter (format scripts),
// not an ESLint error, so existing code is never blocked by whitespace.
const tseslint = require('typescript-eslint');
const prettier = require('eslint-config-prettier');

module.exports = tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'workspace/**',
      'web-ui/**',
      'knowledge/**',
      '.backup/**',
      '.workbuddy/**',
      '*.config.js',
      '*.config.ts',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // The gateway is deliberately typed loosely (small local models + many
      // free-form tool args); explicit any is a project-wide idiom.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Recommended set flags some things that are intentional here.
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
  prettier,
);
