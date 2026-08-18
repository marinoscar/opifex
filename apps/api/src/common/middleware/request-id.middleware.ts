import { Injectable, NestMiddleware } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { ServerResponse } from 'http';
import { trace, context } from '@opentelemetry/api';
import { randomUUID } from 'node:crypto';

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
    traceId?: string;
    spanId?: string;
  }
}

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  // NestJS middleware with Fastify receives raw Node.js objects
  use(req: FastifyRequest['raw'] & { requestId?: string; traceId?: string; spanId?: string }, res: ServerResponse, next: () => void) {
    // Get or generate request ID
    const requestId =
      (req.headers['x-request-id'] as string) || randomUUID();

    // Get trace context from OpenTelemetry
    const activeSpan = trace.getSpan(context.active());
    const spanContext = activeSpan?.spanContext();

    // Attach to request (cast to any to add custom properties)
    (req as any).requestId = requestId;
    if (spanContext) {
      (req as any).traceId = spanContext.traceId;
      (req as any).spanId = spanContext.spanId;
    }

    // Set response headers using Node.js API
    res.setHeader('x-request-id', requestId);
    if (spanContext) {
      res.setHeader('x-trace-id', spanContext.traceId);
    }

    next();
  }
}
