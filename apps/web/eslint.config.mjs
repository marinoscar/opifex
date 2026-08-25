// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * ESLint for the React app (#30).
 *
 * Same two choices as apps/api — no type-checked preset, and every rule is
 * `error` or `off` rather than `warn`. See that file for the reasoning.
 *
 * The hooks rules are named individually instead of spreading a preset.
 * `eslint-plugin-react-hooks` v7 ships the React Compiler rule family
 * (`set-state-in-effect`, `refs`, `immutability`,
 * `preserve-manual-memoization`) in its recommended set, and those found 18
 * genuine issues here. Every one of them is a behavioural refactor of a
 * component, not a lint fix, so enabling them all at once would mean either a
 * red build or a large unreviewed change riding along with a tooling PR. #185
 * turns them on one at a time, smallest blast radius first, each with its
 * findings cleared in the same commit. `rules-of-hooks` and `exhaustive-deps`
 * — the classic contract, and the two that catch real bugs cheaply — have been
 * on and blocking since #30.
 */
export default tseslint.config(
  {
    ignores: ['dist', 'coverage', 'node_modules'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    plugins: {
      react,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...react.configs.flat.recommended.rules,

      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',

      // React Compiler family (#185), enabled one rule at a time.
      // Zero findings in the app: the memoization we write by hand is already
      // the memoization the compiler would keep. On, so it stays that way.
      'react-hooks/preserve-manual-memoization': 'error',

      // The automatic JSX runtime (React 19 + Vite) means importing React to
      // use JSX is exactly the unused import the rest of this config flags.
      'react/react-in-jsx-scope': 'off',

      // TypeScript checks props. propTypes would be a second, weaker
      // declaration of the same thing, kept in sync by hand.
      'react/prop-types': 'off',

      // Off, not absent: a Vite fast-refresh ergonomics rule, and the 23 files
      // it flags export a helper or a type alongside their component. Fixing
      // it means moving exports between modules across the app — a refactor
      // #30 does not want bundled with the linter.
      'react-refresh/only-export-components': 'off',

      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // The push service worker runs in a ServiceWorkerGlobalScope: `self`,
    // `clients` and the fetch/push event types are not browser globals.
    files: ['public/**/*.js'],
    languageOptions: {
      globals: { ...globals.serviceworker },
      sourceType: 'script',
    },
  },
  {
    files: [
      '**/*.test.{ts,tsx}',
      'src/__tests__/**/*.{ts,tsx}',
      'src/test/**/*.{ts,tsx}',
    ],
    languageOptions: { globals: { ...globals.vitest } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  prettier,
);
