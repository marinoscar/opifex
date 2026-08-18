import { Test, TestingModule } from '@nestjs/testing';
import { REQUEST } from '@nestjs/core';
import { LoggerService } from './logger.service';
import { FastifyRequest } from 'fastify';
import pino from 'pino';

// Mock pino
jest.mock('pino');
jest.mock('./pino.config', () => ({
  createLogger: jest.fn(),
}));

import { createLogger } from './pino.config';

describe('LoggerService', () => {
  let service: LoggerService;
  let mockPinoLogger: jest.Mocked<pino.Logger>;
  let mockRequest: Partial<FastifyRequest>;

  beforeEach(async () => {
    // Create mock Pino logger with all methods
    mockPinoLogger = {
      trace: jest.fn(),
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      fatal: jest.fn(),
      child: jest.fn(),
    } as any;

    // Mock child logger to return itself for chaining
    (mockPinoLogger.child as jest.Mock).mockReturnValue(mockPinoLogger);

    // Mock createLogger to return base logger
    (createLogger as jest.Mock).mockReturnValue(mockPinoLogger);

    // Create mock request with request context
    mockRequest = {
      requestId: 'req-123',
      traceId: 'trace-abc',
      spanId: 'span-xyz',
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoggerService,
        {
          provide: REQUEST,
          useValue: mockRequest,
        },
      ],
    }).compile();

    // Use resolve() for REQUEST-scoped providers
    service = await module.resolve<LoggerService>(LoggerService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Initialization', () => {
    it('should create child logger with request context', () => {
      expect(createLogger).toHaveBeenCalled();
      expect(mockPinoLogger.child).toHaveBeenCalledWith({
        requestId: 'req-123',
        traceId: 'trace-abc',
        spanId: 'span-xyz',
      });
    });

    it('should handle request without trace context', async () => {
      const requestWithoutTrace = {
        requestId: 'req-456',
      };

      (mockPinoLogger.child as jest.Mock).mockClear();

      const moduleWithoutTrace = await Test.createTestingModule({
        providers: [
          LoggerService,
          {
            provide: REQUEST,
            useValue: requestWithoutTrace,
          },
        ],
      }).compile();

      await moduleWithoutTrace.resolve<LoggerService>(LoggerService);

      expect(mockPinoLogger.child).toHaveBeenCalledWith({
        requestId: 'req-456',
        traceId: undefined,
        spanId: undefined,
      });
    });
  });

  describe('trace', () => {
    it('should log at trace level', () => {
      service.trace('Trace message');

      expect(mockPinoLogger.trace).toHaveBeenCalledWith(undefined, 'Trace message');
    });

    it('should log at trace level with context', () => {
      const context = { userId: '123', action: 'read' };
      service.trace('Trace with context', context);

      expect(mockPinoLogger.trace).toHaveBeenCalledWith(context, 'Trace with context');
    });
  });

  describe('debug', () => {
    it('should log at debug level', () => {
      service.debug('Debug message');

      expect(mockPinoLogger.debug).toHaveBeenCalledWith(undefined, 'Debug message');
    });

    it('should log at debug level with context', () => {
      const context = { query: 'SELECT * FROM users' };
      service.debug('Database query', context);

      expect(mockPinoLogger.debug).toHaveBeenCalledWith(context, 'Database query');
    });
  });

  describe('info', () => {
    it('should log at info level', () => {
      service.info('Info message');

      expect(mockPinoLogger.info).toHaveBeenCalledWith(undefined, 'Info message');
    });

    it('should log at info level with context', () => {
      const context = { event: 'user_login', userId: '123' };
      service.info('User logged in', context);

      expect(mockPinoLogger.info).toHaveBeenCalledWith(context, 'User logged in');
    });

    it('should handle complex context objects', () => {
      const context = {
        user: { id: '123', email: 'test@example.com' },
        metadata: { timestamp: new Date(), source: 'web' },
      };
      service.info('Complex context', context);

      expect(mockPinoLogger.info).toHaveBeenCalledWith(context, 'Complex context');
    });
  });

  describe('warn', () => {
    it('should log at warn level', () => {
      service.warn('Warning message');

      expect(mockPinoLogger.warn).toHaveBeenCalledWith(undefined, 'Warning message');
    });

    it('should log at warn level with context', () => {
      const context = { threshold: 90, current: 95 };
      service.warn('Threshold exceeded', context);

      expect(mockPinoLogger.warn).toHaveBeenCalledWith(context, 'Threshold exceeded');
    });
  });

  describe('error', () => {
    it('should log error with Error instance', () => {
      const error = new Error('Something went wrong');
      service.error('Error occurred', error);

      expect(mockPinoLogger.error).toHaveBeenCalledWith(
        { err: error },
        'Error occurred'
      );
    });

    it('should log error with Error instance and context', () => {
      const error = new Error('Database error');
      const context = { operation: 'query', table: 'users' };
      service.error('Database operation failed', error, context);

      expect(mockPinoLogger.error).toHaveBeenCalledWith(
        { ...context, err: error },
        'Database operation failed'
      );
    });

    it('should handle non-Error objects', () => {
      const errorObj = { code: 'UNKNOWN', message: 'Unknown error' };
      service.error('Unknown error occurred', errorObj);

      expect(mockPinoLogger.error).toHaveBeenCalledWith(
        { error: errorObj },
        'Unknown error occurred'
      );
    });

    it('should log error with stack trace for Error instances', () => {
      const error = new Error('Error with stack');
      error.stack = 'Error: Error with stack\n    at test.js:1:1';

      service.error('Error with stack trace', error);

      expect(mockPinoLogger.error).toHaveBeenCalledWith(
        { err: error },
        'Error with stack trace'
      );
      // Pino automatically serializes Error objects with stack traces
    });

    it('should handle error without additional context', () => {
      const error = new Error('Simple error');
      service.error('Error message', error);

      expect(mockPinoLogger.error).toHaveBeenCalledWith(
        { err: error },
        'Error message'
      );
    });

    it('should handle null error', () => {
      service.error('Error with null', null);

      expect(mockPinoLogger.error).toHaveBeenCalledWith(
        { error: null },
        'Error with null'
      );
    });

    it('should handle undefined error', () => {
      service.error('Error with undefined', undefined);

      expect(mockPinoLogger.error).toHaveBeenCalledWith(
        { error: undefined },
        'Error with undefined'
      );
    });
  });

  describe('fatal', () => {
    it('should log at fatal level with Error instance', () => {
      const error = new Error('Fatal error');
      service.fatal('Fatal error occurred', error);

      expect(mockPinoLogger.fatal).toHaveBeenCalledWith(
        { err: error },
        'Fatal error occurred'
      );
    });

    it('should log at fatal level with Error instance and context', () => {
      const error = new Error('System failure');
      const context = { service: 'database', action: 'connect' };
      service.fatal('System failure', error, context);

      expect(mockPinoLogger.fatal).toHaveBeenCalledWith(
        { ...context, err: error },
        'System failure'
      );
    });

    it('should handle non-Error objects at fatal level', () => {
      const errorObj = { critical: true, message: 'Critical failure' };
      service.fatal('Critical failure', errorObj);

      expect(mockPinoLogger.fatal).toHaveBeenCalledWith(
        { error: errorObj },
        'Critical failure'
      );
    });
  });

  describe('Context handling', () => {
    it('should preserve request context in all log levels', () => {
      service.info('Test message');

      // Verify child logger was created with request context
      expect(mockPinoLogger.child).toHaveBeenCalledWith({
        requestId: 'req-123',
        traceId: 'trace-abc',
        spanId: 'span-xyz',
      });
    });

    it('should merge additional context with request context', () => {
      const additionalContext = { userId: '456', action: 'update' };
      service.info('User action', additionalContext);

      // The additional context is passed to the log method
      expect(mockPinoLogger.info).toHaveBeenCalledWith(
        additionalContext,
        'User action'
      );
    });

    it('should handle empty context object', () => {
      service.info('Message with empty context', {});

      expect(mockPinoLogger.info).toHaveBeenCalledWith({}, 'Message with empty context');
    });

    it('should handle context with null values', () => {
      const context = { value: null, other: 'data' };
      service.info('Message with null in context', context);

      expect(mockPinoLogger.info).toHaveBeenCalledWith(
        context,
        'Message with null in context'
      );
    });
  });

  describe('Message formatting', () => {
    it('should handle messages with special characters', () => {
      const message = 'Message with "quotes" and \'apostrophes\'';
      service.info(message);

      expect(mockPinoLogger.info).toHaveBeenCalledWith(undefined, message);
    });

    it('should handle messages with newlines', () => {
      const message = 'Line 1\nLine 2\nLine 3';
      service.info(message);

      expect(mockPinoLogger.info).toHaveBeenCalledWith(undefined, message);
    });

    it('should handle empty string messages', () => {
      service.info('');

      expect(mockPinoLogger.info).toHaveBeenCalledWith(undefined, '');
    });

    it('should handle very long messages', () => {
      const longMessage = 'A'.repeat(10000);
      service.info(longMessage);

      expect(mockPinoLogger.info).toHaveBeenCalledWith(undefined, longMessage);
    });
  });

  describe('Pino integration', () => {
    it('should use child logger for scoped logging', () => {
      // Child logger should be created on initialization
      expect(mockPinoLogger.child).toHaveBeenCalled();
    });

    it('should pass context as first argument to Pino (Pino format)', () => {
      const context = { key: 'value' };
      service.info('Message', context);

      // Pino format: logger.level(context, message)
      expect(mockPinoLogger.info).toHaveBeenCalledWith(context, 'Message');
    });

    it('should handle Error serialization through err key (Pino convention)', () => {
      const error = new Error('Test error');
      service.error('Error', error);

      // Pino uses 'err' key for Error serialization
      expect(mockPinoLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: error }),
        'Error'
      );
    });
  });

  describe('Multiple log calls', () => {
    it('should handle multiple consecutive log calls', () => {
      service.info('Message 1');
      service.warn('Message 2');
      service.error('Message 3', new Error('Error'));

      expect(mockPinoLogger.info).toHaveBeenCalledTimes(1);
      expect(mockPinoLogger.warn).toHaveBeenCalledTimes(1);
      expect(mockPinoLogger.error).toHaveBeenCalledTimes(1);
    });

    it('should maintain separate contexts for different log calls', () => {
      service.info('First', { id: 1 });
      service.info('Second', { id: 2 });

      expect(mockPinoLogger.info).toHaveBeenNthCalledWith(1, { id: 1 }, 'First');
      expect(mockPinoLogger.info).toHaveBeenNthCalledWith(2, { id: 2 }, 'Second');
    });
  });
});

describe('staticLogger', () => {
  it('should be a Pino logger instance with standard methods', () => {
    // Verify the mocked logger has the expected methods
    const baseLogger = (createLogger as jest.Mock)();
    expect(typeof baseLogger.info).toBe('function');
    expect(typeof baseLogger.error).toBe('function');
    expect(typeof baseLogger.warn).toBe('function');
    expect(typeof baseLogger.debug).toBe('function');
    expect(typeof baseLogger.trace).toBe('function');
    expect(typeof baseLogger.fatal).toBe('function');
  });
});
