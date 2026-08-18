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

import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
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
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
