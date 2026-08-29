/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '..',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.json',
        // TS151002: ts-jest warns that the NodeNext ("hybrid") module kind
        // wants isolatedModules. It does not apply here: apps/api has no
        // "type": "module", so NodeNext resolves unambiguously to CommonJS.
        // isolatedModules cannot be enabled anyway - it conflicts with
        // emitDecoratorMetadata, which NestJS requires (TS1272).
        diagnostics: { ignoreCodes: [151002] },
      },
    ],
  },
  // scripts/ is plain, already-valid CommonJS (no TS, no ESM syntax) that
  // test/scripts/resolve-compose-env.spec.ts requires directly (#322). Left
  // to the default transform, ts-jest warns on every run because `allowJs`
  // is unset for the app's own tsconfig; skipping the transform here lets
  // Jest's module loader require it as plain CJS instead, with no warning
  // and no behaviour change.
  transformIgnorePatterns: ['/node_modules/', '<rootDir>/scripts/'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.module.ts',
    '!src/**/*.dto.ts',
    '!src/main.ts',
    '!src/**/*.spec.ts',
  ],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/', '<rootDir>/test/'],
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  globalTeardown: '<rootDir>/test/teardown.ts',
  testTimeout: 30000,
  verbose: true,
};
