// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * ESLint for the NestJS API (#30).
 *
 * Two deliberate choices, both about making the first linter one that can
 * actually block.
 *
 * **Not the type-checked preset.** `recommendedTypeChecked` needs a TypeScript
 * program, which here means a generated Prisma client — so `npm run lint`
 * would fail on a fresh clone until `prisma:generate` had run, and the CI lint
 * job would need the client before it could lint. That is a real cost for
 * rules that largely restate what `tsc --noEmit` already reports in the
 * typecheck job.
 *
 * **Every rule is `error` or `off`, never `warn`.** A warning that does not
 * fail the build is a finding nobody acts on, and #30's complaint about the
 * old stub — "a script that prints a message and exits 0 is worse than no
 * script" — applies just as well to a script that prints forty warnings and
 * exits 0. Rules that are off are off explicitly, with the reason next to
 * them.
 *
 * `eslint-config-prettier` goes last and only removes rules: formatting is
 * Prettier's job, and two tools with opinions about the same character
 * produce a fight that ends with someone disabling one of them.
 */
export default tseslint.config(
  {
    ignores: ['dist', 'coverage', 'node_modules', 'generated', 'prisma/migrations'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],

      // Off, not absent: there are ~30 pre-existing `any`s in src/, most of
      // them around Prisma's JSON columns and decorator plumbing. Typing them
      // is a change to runtime-adjacent code, which #30 explicitly does not
      // want bundled with the linter that found them ("do not include
      // unrelated refactors"). Tracked separately — turn this on with that
      // work, not before, so it lands green.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // These are CommonJS by design — they run as plain `node scripts/x.js`
    // from npm scripts, before any build step exists to transpile them.
    files: ['scripts/**/*.js', '**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // Specs assert against mocks and fixtures, where a deliberate `any` or a
    // non-null assertion is often the clearest statement of what is under
    // test. `require()` appears here for a real reason too: re-requiring a
    // module inside `jest.isolateModules` is how module-level side effects
    // get retested, and an ESM import cannot do it.
    files: ['**/*.spec.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  prettier,
);
