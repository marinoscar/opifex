import { Injectable, Scope, Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { FastifyRequest } from 'fastify';
import pino from 'pino';
import { createLogger } from './pino.config';

@Injectable({ scope: Scope.REQUEST })
export class LoggerService {
  private readonly logger: pino.Logger;

  constructor(@Inject(REQUEST) private readonly request: FastifyRequest) {
    const baseLogger = createLogger();

    // Create child logger with request context
    this.logger = baseLogger.child({
      requestId: request.requestId,
      traceId: request.traceId,
      spanId: request.spanId,
    });
  }

  trace(message: string, context?: object) {
    this.logger.trace(context, message);
  }

  debug(message: string, context?: object) {
    this.logger.debug(context, message);
  }

  info(message: string, context?: object) {
    this.logger.info(context, message);
  }

  warn(message: string, context?: object) {
    this.logger.warn(context, message);
  }

  error(message: string, error?: Error | unknown, context?: object) {
    if (error instanceof Error) {
      this.logger.error(
        { ...context, err: error },
        message,
      );
    } else {
      this.logger.error({ ...context, error }, message);
    }
  }

  fatal(message: string, error?: Error | unknown, context?: object) {
    if (error instanceof Error) {
      this.logger.fatal(
        { ...context, err: error },
        message,
      );
    } else {
      this.logger.fatal({ ...context, error }, message);
    }
  }
}

// Static logger for use outside request context
export const staticLogger = createLogger();
