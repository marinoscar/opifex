// =============================================================================
// Dump the OpenAPI document to a file (issue #53)
// =============================================================================
//
// Used by CI to lint the spec with Spectral, so a spec regression is visible in
// review rather than discovered by a client.
//
// Run with:  npm run openapi:dump --workspace=api -- [outfile]
//
// NOTE ON PREVIEW MODE
// -----------------------------------------------------------------------------
// The app is created with `preview: true`, which loads every module and reads
// every controller's metadata WITHOUT instantiating providers. That is what lets
// this run on a bare CI checkout: no database, no object storage, no OAuth
// credentials, no cron or worker loops started, nothing to tear down. The
// document is produced from decorator metadata, which preview mode has in full.
//
// `NODE_ENV` is forced to production so the dumped spec is the one a deployment
// publishes — in particular, without the non-production `Test Authentication`
// routes, which `app.module.ts` registers only outside production.
// =============================================================================

process.env.NODE_ENV = 'production';

// A DOCUMENT GENERATOR, NOT A SERVER (#278).
//
// Since #278, `ConfigModule.forRoot({ validate })` refuses to build without a
// JWT_SECRET of at least 32 characters, and that check runs when `AppModule`
// is imported — which is why this assignment has to be here, above the
// imports, alongside the NODE_ENV one, rather than inside `main()`.
//
// CI runs this on a bare checkout with no environment at all, so without this
// the OpenAPI job would fail on a secret it has no use for: preview mode
// instantiates no providers, so no strategy is constructed, no token is ever
// signed or verified, and nothing listens on a port.
//
// RANDOM PER RUN, and never a literal, which is the whole distinction from the
// `'fallback-secret'` this issue removed. A value nobody can predict and that
// dies with the process cannot be forged against even if some future change
// did make this script serve traffic. `??=` so a real environment still wins.
import { randomBytes } from 'crypto';

process.env.JWT_SECRET ??= randomBytes(32).toString('hex');

// AND A DATABASE PASSWORD, for the same reason and by the same trap (#299).
//
// Since #299, `validateEnv` also refuses to build when `NODE_ENV=production`
// and `POSTGRES_PASSWORD` is unset or still the shipped default — and this
// script forces `NODE_ENV=production` twenty lines above, deliberately, so
// that the dumped spec is the one a deployment publishes. That makes this the
// ONLY script in the repository that meets the new check on a bare CI checkout
// with no environment at all, and without this line the OpenAPI job would go
// red on a credential it has no use for.
//
// Preview mode instantiates no providers, so `PrismaService` is never
// constructed and nothing ever opens a connection: the value is never sent
// anywhere. Random per run and never a literal, for the same reason as the
// secret above — a value nobody can predict and that dies with the process
// cannot become the credential some future change accidentally connects with.
// `??=` so a real environment still wins.
process.env.POSTGRES_PASSWORD ??= randomBytes(16).toString('hex');

import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { createOpenApiDocument } from '../src/openapi/document';

async function main(): Promise<void> {
  const outfile = resolve(process.argv[2] ?? 'openapi.json');

  // The adapter has to be supplied explicitly: this app runs on Fastify, and
  // without it Nest falls back to looking for @nestjs/platform-express.
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { preview: true, logger: false },
  );

  // NOT optional. `main.ts` calls `setGlobalPrefix('api')` before building the
  // document, and the introspection reads the prefix off the application — so
  // without this line every path in the dumped file would be missing its `/api`
  // segment, and CI would lint a document that differs from the served one on
  // every single route.
  app.setGlobalPrefix('api');

  const document = createOpenApiDocument(app);
  await app.close();

  mkdirSync(dirname(outfile), { recursive: true });
  // Two-space indentation and a trailing newline so a `git diff` between two
  // dumps is line-oriented and readable, rather than one enormous line.
  writeFileSync(outfile, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  const operations = Object.values(document.paths ?? {}).reduce(
    (total, pathItem) => total + Object.keys(pathItem ?? {}).length,
    0,
  );
  process.stdout.write(`Wrote ${outfile} (${operations} operations)\n`);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
