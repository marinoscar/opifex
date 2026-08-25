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
 * genuine issues here. Every one of them was a behavioural refactor of a
 * component, not a lint fix, so enabling them all at once would have meant
 * either a red build or a large unreviewed change riding along with a tooling
 * PR. #185 turned them on one at a time, smallest blast radius first, each
 * with its findings cleared in the same commit; all four are now on.
 *
 * The rest of that recommended set (`static-components`, `use-memo`,
 * `purity`, `set-state-in-render`, `globals`, `error-boundaries`, …) is still
 * unnamed here and therefore off, which is why the rules stay listed one by
 * one rather than spread from the preset.
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

      // One finding, in ActivateDevicePage: an effect that called a handler
      // declared below it. Fixed by declaring the handler first (#185).
      'react-hooks/immutability': 'error',

      // Five findings, all the same shape: a "latest value" ref assigned
      // during render. Each now syncs in a layout effect instead, so a render
      // React discards cannot publish its props to the tree that stayed on
      // screen (#185).
      'react-hooks/refs': 'error',

      // Thirteen findings. Seven were state derived from props through an
      // effect and are now adjusted during render; six are "fetch on mount",
      // where the fetch clears its own error state before its first await —
      // those carry an inline suppression with the reason at the call site
      // (#185).
      'react-hooks/set-state-in-effect': 'error',

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
