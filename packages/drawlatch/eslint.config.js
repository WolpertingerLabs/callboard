import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import prettierPlugin from 'eslint-plugin-prettier';

export default tseslint.config(
  // Base JS recommended rules
  eslint.configs.recommended,

  // TypeScript strict + stylistic rules
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  // Prettier compat — disables conflicting formatting rules
  prettier,

  // Global config
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      prettier: prettierPlugin,
    },
    rules: {
      // ── Prettier integration ──────────────────────────────────
      'prettier/prettier': 'warn',

      // ── TypeScript strictness tuning ──────────────────────────
      // Allow explicit `any` in test files and tool handlers
      '@typescript-eslint/no-explicit-any': 'warn',
      // Allow unused vars prefixed with _
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Relax for express route handlers and test assertions
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      // Allow non-null assertions sparingly (crypto KeyObject exports)
      '@typescript-eslint/no-non-null-assertion': 'warn',
      // Allow void expressions for fire-and-forget
      '@typescript-eslint/no-confusing-void-expression': 'off',
      // Permit floating promises in entry-point main() calls
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      // Allow template expressions with string/number
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],

      // ── General quality ───────────────────────────────────────
      'no-console': 'off', // Needed for server logging
      eqeqeq: ['error', 'always'],
      'no-throw-literal': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  // Ignore build output, config files, and integration test
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'eslint.config.js'],
  },
);
