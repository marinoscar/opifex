import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    env: {
      VITE_API_BASE_URL: 'http://localhost:3000/api',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules',
        'src/__tests__',
        '**/*.d.ts',
        '**/*.config.*',
        'src/main.tsx',
      ],
      thresholds: {
        lines: 70,
        branches: 70,
        functions: 70,
        statements: 70,
      },
    },
    // Raised from 10s for the DataTable suites. Their slowest cases legitimately
    // take ~5.5s locally: each renders a full MUI X DataGrid (or card list)
    // under the jsdom layout stubs, and the conformance suite additionally runs
    // an axe-core pass across two renderers x two themes. 10s left under 2x
    // headroom, which is the shape of a suite that is green locally and flakes
    // on a loaded CI runner. The cost of the higher ceiling is only that a
    // genuinely hung test takes longer to be declared dead.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
});
