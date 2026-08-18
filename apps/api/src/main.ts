// IMPORTANT: Load instrumentation before anything else
import './instrumentation';

import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Logger } from '@nestjs/common';
import fastifyCookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { AppModule } from './app.module';
import { createOpenApiDocument } from './openapi/document';
import { registerDocsRoutesOrDegrade } from './openapi/register-docs-routes';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // Safety check: prevent test auth module in production
  if (process.env.NODE_ENV === 'production' && process.env.TEST_AUTH_ENABLED === 'true') {
    throw new Error('TEST_AUTH_ENABLED must not be true in production');
  }

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: true }),
  );

  // Register cookie plugin
  await app.register(fastifyCookie, {
    secret: process.env.COOKIE_SECRET || process.env.JWT_SECRET,
  });

  // Register multipart plugin for file uploads
  await app.register(multipart, {
    limits: {
      fileSize: 100 * 1024 * 1024, // 100MB for simple upload
      files: 1,
    },
  });

  // Global prefix for all routes
  app.setGlobalPrefix('api');

  // Enable CORS (same-origin by default, configurable)
  app.enableCors({
    origin: process.env.CORS_ORIGIN || true,
    credentials: true,
  });

  // OpenAPI: the document and the two routes that serve it. Everything that
  // shapes them lives in `src/openapi/` rather than here, so the same pure
  // functions are callable from the test suite and from `scripts/dump-openapi.ts`
  // — which is what makes the document CI lints the document users get.
  //
  // Registered AFTER `setGlobalPrefix('api')` above, because the introspection
  // reads the prefix off the application; the dump script sets the same prefix
  // for the same reason.
  //
  // `…OrDegrade` rather than a bare call: generation is the widest failure
  // surface in this function, and it runs before the port is bound, so an
  // unguarded throw makes a documentation defect a total outage. It logs at
  // `error` and serves 503s on both docs paths instead. See the function's own
  // comment for why that is not gated on NODE_ENV, and note that `openapi:dump`
  // in CI still fails the build on a document that cannot be generated.
  const docsReady = registerDocsRoutesOrDegrade(
    app,
    () => createOpenApiDocument(app),
    logger,
  );

  const port = process.env.PORT || 3000;
  await app.listen(port, '0.0.0.0');

  logger.log(`Application running on port ${port}`);
  logger.log(
    docsReady
      ? 'API reference available at /api/docs'
      : 'API reference DEGRADED: /api/docs and /api/openapi.json return 503 (see error above)',
  );
}

bootstrap();
