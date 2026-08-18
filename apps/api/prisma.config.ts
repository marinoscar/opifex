import { defineConfig } from '@prisma/config';

/**
 * Prisma configuration for v7+.
 *
 * The DATABASE_URL is constructed by scripts/prisma-env.js from individual
 * environment variables (POSTGRES_HOST, POSTGRES_PORT, etc.) and injected
 * before the Prisma CLI is invoked.
 *
 * For runtime use, apps/api/src/config/configuration.ts does the same.
 */
export default defineConfig({
  datasource: {
    url: process.env.DATABASE_URL as string,
  },
  migrations: {
    seed: 'ts-node --project prisma/tsconfig.json prisma/seed.ts',
  },
});
