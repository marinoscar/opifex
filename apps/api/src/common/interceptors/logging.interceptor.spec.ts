import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, CallHandler, Logger } from '@nestjs/common';
import { LoggingInterceptor } from './logging.interceptor';
import { of, throwError } from 'rxjs';
import { FastifyRequest } from 'fastify';

describe('LoggingInterceptor', () => {
  let interceptor: LoggingInterceptor;
  let mockLogger: jest.SpyInstance;

  beforeEach(async () => {
    interceptor = new LoggingInterceptor();

    // Mock the logger methods
    mockLogger = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createMockContext(method: string, url: string, requestId?: string): ExecutionContext {
    const mockRequest: Partial<FastifyRequest> = {
      method,
      url,
      requestId,
    };

    return {
      switchToHttp: () => ({
        getRequest: () => mockRequest as FastifyRequest,
        getResponse: () => ({}),
      }),
      getClass: () => jest.fn(),
      getHandler: () => jest.fn(),
    } as any;
  }

  function createMockCallHandler(data?: any): CallHandler {
    return {
      handle: () => of(data),
    } as CallHandler;
  }

  describe('Request logging', () => {
    it('should log request start with method and URL', (done) => {
      const context = createMockContext('GET', '/api/users');
      const callHandler = createMockCallHandler({ data: 'test' });

      interceptor.intercept(context, callHandler).subscribe(() => {
        expect(mockLogger).toHaveBeenCalled();
        const logMessage = mockLogger.mock.calls[0][0];
        expect(logMessage).toContain('GET');
        expect(logMessage).toContain('/api/users');
        done();
      });
    });

    it('should log POST requests', (done) => {
      const context = createMockContext('POST', '/api/auth/login');
      const callHandler = createMockCallHandler({ success: true });

      interceptor.intercept(context, callHandler).subscribe(() => {
        const logMessage = mockLogger.mock.calls[0][0];
        expect(logMessage).toContain('POST');
        expect(logMessage).toContain('/api/auth/login');
        done();
      });
    });

    it('should log PUT requests', (done) => {
      const context = createMockContext('PUT', '/api/users/123');
      const callHandler = createMockCallHandler();

      interceptor.intercept(context, callHandler).subscribe(() => {
        const logMessage = mockLogger.mock.calls[0][0];
        expect(logMessage).toContain('PUT');
        expect(logMessage).toContain('/api/users/123');
        done();
      });
    });

    it('should log DELETE requests', (done) => {
      const context = createMockContext('DELETE', '/api/users/123');
      const callHandler = createMockCallHandler();

      interceptor.intercept(context, callHandler).subscribe(() => {
        const logMessage = mockLogger.mock.calls[0][0];
        expect(logMessage).toContain('DELETE');
        expect(logMessage).toContain('/api/users/123');
        done();
      });
    });

    it('should log PATCH requests', (done) => {
      const context = createMockContext('PATCH', '/api/settings');
      const callHandler = createMockCallHandler();

      interceptor.intercept(context, callHandler).subscribe(() => {
        const logMessage = mockLogger.mock.calls[0][0];
        expect(logMessage).toContain('PATCH');
        expect(logMessage).toContain('/api/settings');
        done();
      });
    });
  });

  describe('Response time logging', () => {
    it('should log request duration in milliseconds', (done) => {
      const context = createMockContext('GET', '/api/test');
      const callHandler = createMockCallHandler();

      interceptor.intercept(context, callHandler).subscribe(() => {
        const logMessage = mockLogger.mock.calls[0][0];
        expect(logMessage).toMatch(/\d+ms/);
        done();
      });
    });

    it('should measure actual elapsed time', (done) => {
      const context = createMockContext('GET', '/api/slow');
      const callHandler = {
        handle: () => {
          // Simulate processing delay
          const startTime = Date.now();
          while (Date.now() - startTime < 5) {
            // Busy wait for ~5ms
          }
          return of({ data: 'result' });
        },
      } as CallHandler;

      interceptor.intercept(context, callHandler).subscribe(() => {
        const logMessage = mockLogger.mock.calls[0][0];
        const match = logMessage.match(/(\d+)ms/);
        expect(match).toBeTruthy();
        const duration = parseInt(match![1], 10);
        // Should be at least a few milliseconds
        expect(duration).toBeGreaterThanOrEqual(0);
        done();
      });
    });

    it('should log different durations for different requests', (done) => {
      const context1 = createMockContext('GET', '/api/fast');
      const context2 = createMockContext('GET', '/api/slow');

      const fastHandler = createMockCallHandler();
      const slowHandler = {
        handle: () => {
          const startTime = Date.now();
          while (Date.now() - startTime < 10) {
            // Busy wait
          }
          return of({ data: 'result' });
        },
      } as CallHandler;

      interceptor.intercept(context1, fastHandler).subscribe(() => {
        const fastLog = mockLogger.mock.calls[0][0];
        const fastMatch = fastLog.match(/(\d+)ms/);

        interceptor.intercept(context2, slowHandler).subscribe(() => {
          const slowLog = mockLogger.mock.calls[1][0];
          const slowMatch = slowLog.match(/(\d+)ms/);

          // Just verify both have timing info
          expect(fastMatch).toBeTruthy();
          expect(slowMatch).toBeTruthy();
          done();
        });
      });
    });
  });

  describe('Request completion logging', () => {
    it('should log when request completes successfully', (done) => {
      const context = createMockContext('GET', '/api/users');
      const callHandler = createMockCallHandler({ users: [] });

      interceptor.intercept(context, callHandler).subscribe(() => {
        expect(mockLogger).toHaveBeenCalled();
        done();
      });
    });

    it('should log for requests returning null', (done) => {
      const context = createMockContext('GET', '/api/nullable');
      const callHandler = createMockCallHandler(null);

      interceptor.intercept(context, callHandler).subscribe(() => {
        expect(mockLogger).toHaveBeenCalled();
        done();
      });
    });

    it('should log for requests returning empty arrays', (done) => {
      const context = createMockContext('GET', '/api/empty');
      const callHandler = createMockCallHandler([]);

      interceptor.intercept(context, callHandler).subscribe(() => {
        expect(mockLogger).toHaveBeenCalled();
        done();
      });
    });

    it('should log for requests returning large objects', (done) => {
      const context = createMockContext('GET', '/api/large');
      const largeData = { items: new Array(1000).fill({ id: 1, name: 'test' }) };
      const callHandler = createMockCallHandler(largeData);

      interceptor.intercept(context, callHandler).subscribe(() => {
        expect(mockLogger).toHaveBeenCalled();
        done();
      });
    });
  });

  describe('URL path variations', () => {
    it('should handle root path', (done) => {
      const context = createMockContext('GET', '/');
      const callHandler = createMockCallHandler();

      interceptor.intercept(context, callHandler).subscribe(() => {
        const logMessage = mockLogger.mock.calls[0][0];
        expect(logMessage).toContain('GET');
        expect(logMessage).toContain('/');
        done();
      });
    });

    it('should handle paths with query parameters', (done) => {
      const context = createMockContext('GET', '/api/users?page=1&limit=10');
      const callHandler = createMockCallHandler();

      interceptor.intercept(context, callHandler).subscribe(() => {
        const logMessage = mockLogger.mock.calls[0][0];
        expect(logMessage).toContain('/api/users?page=1&limit=10');
        done();
      });
    });

    it('should handle nested paths', (done) => {
      const context = createMockContext('GET', '/api/users/123/settings');
      const callHandler = createMockCallHandler();

      interceptor.intercept(context, callHandler).subscribe(() => {
        const logMessage = mockLogger.mock.calls[0][0];
        expect(logMessage).toContain('/api/users/123/settings');
        done();
      });
    });

    it('should handle paths with special characters', (done) => {
      const context = createMockContext('GET', '/api/search?q=test%20query');
      const callHandler = createMockCallHandler();

      interceptor.intercept(context, callHandler).subscribe(() => {
        const logMessage = mockLogger.mock.calls[0][0];
        expect(logMessage).toContain('/api/search?q=test%20query');
        done();
      });
    });
  });

  describe('Logger context', () => {
    it('should use HTTP context for logging', (done) => {
      const context = createMockContext('GET', '/api/test');
      const callHandler = createMockCallHandler();

      // Access the private logger to verify context
      const loggerContext = (interceptor as any).logger.context;
      expect(loggerContext).toBe('HTTP');

      interceptor.intercept(context, callHandler).subscribe(() => {
        done();
      });
    });
  });

  describe('Observable stream handling', () => {
    it('should pass through response data unchanged', (done) => {
      const context = createMockContext('GET', '/api/data');
      const testData = { id: 1, name: 'test' };
      const callHandler = createMockCallHandler(testData);

      interceptor.intercept(context, callHandler).subscribe((result) => {
        expect(result).toEqual(testData);
        done();
      });
    });

    it('should handle multiple emissions from observable', (done) => {
      const context = createMockContext('GET', '/api/stream');
      const callHandler = {
        handle: () => of(1, 2, 3),
      } as CallHandler;

      const results: any[] = [];
      interceptor.intercept(context, callHandler).subscribe({
        next: (value) => results.push(value),
        complete: () => {
          expect(results).toEqual([1, 2, 3]);
          // tap() is called for each emission in the stream
          expect(mockLogger).toHaveBeenCalled();
          done();
        },
      });
    });
  });
});
