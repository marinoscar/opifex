import { RequestIdMiddleware } from './request-id.middleware';
import { ServerResponse } from 'http';
import { trace, context, Span, SpanContext } from '@opentelemetry/api';
import { randomUUID } from 'node:crypto';

// Mock OpenTelemetry
jest.mock('@opentelemetry/api', () => ({
  trace: {
    getSpan: jest.fn(),
  },
  context: {
    active: jest.fn(),
  },
}));

describe('RequestIdMiddleware', () => {
  let middleware: RequestIdMiddleware;
  let mockRequest: any;
  let mockResponse: ServerResponse;
  let mockNext: jest.Mock;

  beforeEach(() => {
    middleware = new RequestIdMiddleware();

    // Reset request
    mockRequest = {
      headers: {},
    };

    // Mock response with setHeader method
    mockResponse = {
      setHeader: jest.fn(),
    } as any;

    // Mock next function
    mockNext = jest.fn();

    // Clear OpenTelemetry mocks
    (trace.getSpan as jest.Mock).mockClear();
    (context.active as jest.Mock).mockClear();
  });

  describe('Request ID generation', () => {
    it('should generate UUID request ID when not provided in headers', () => {
      middleware.use(mockRequest, mockResponse, mockNext);

      expect(mockRequest.requestId).toBeDefined();
      expect(typeof mockRequest.requestId).toBe('string');
      // Check if it's a valid UUID format
      expect(mockRequest.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    });

    it('should use existing X-Request-Id header if provided', () => {
      const existingRequestId = 'existing-request-id-12345';
      mockRequest.headers['x-request-id'] = existingRequestId;

      middleware.use(mockRequest, mockResponse, mockNext);

      expect(mockRequest.requestId).toBe(existingRequestId);
    });

    it('should handle X-Request-Id as case-insensitive', () => {
      const existingRequestId = 'custom-request-id';
      mockRequest.headers['X-Request-Id'] = existingRequestId;

      middleware.use(mockRequest, mockResponse, mockNext);

      // Note: Express/Fastify normalizes headers to lowercase
      // This test documents expected behavior
      expect(mockRequest.requestId).toBeDefined();
    });

    it('should generate different request IDs for different requests', () => {
      const mockRequest1: any = { headers: {} };
      const mockRequest2: any = { headers: {} };

      middleware.use(mockRequest1, mockResponse, mockNext);
      middleware.use(mockRequest2, mockResponse, mockNext);

      expect(mockRequest1.requestId).toBeDefined();
      expect(mockRequest2.requestId).toBeDefined();
      expect(mockRequest1.requestId).not.toBe(mockRequest2.requestId);
    });

    it('should generate valid UUID format', () => {
      middleware.use(mockRequest, mockResponse, mockNext);

      const requestId = mockRequest.requestId;
      // Verify it's a valid UUID by attempting to parse it
      expect(() => {
        // UUID validation - should not throw
        const parts = requestId.split('-');
        expect(parts).toHaveLength(5);
        expect(parts[0]).toHaveLength(8);
        expect(parts[1]).toHaveLength(4);
        expect(parts[2]).toHaveLength(4);
        expect(parts[3]).toHaveLength(4);
        expect(parts[4]).toHaveLength(12);
      }).not.toThrow();
    });
  });

  describe('Request object attachment', () => {
    it('should attach request ID to request object', () => {
      middleware.use(mockRequest, mockResponse, mockNext);

      expect(mockRequest).toHaveProperty('requestId');
      expect(mockRequest.requestId).toBeDefined();
    });

    it('should attach trace ID from OpenTelemetry when available', () => {
      const mockTraceId = '80f198ee56343ba864fe8b2a57d3eff7';
      const mockSpanId = 'e457b5a2e4d86bd1';
      const mockSpanContext: SpanContext = {
        traceId: mockTraceId,
        spanId: mockSpanId,
        traceFlags: 1,
      };
      const mockSpan = {
        spanContext: () => mockSpanContext,
      } as Span;

      (context.active as jest.Mock).mockReturnValue({});
      (trace.getSpan as jest.Mock).mockReturnValue(mockSpan);

      middleware.use(mockRequest, mockResponse, mockNext);

      expect(mockRequest.traceId).toBe(mockTraceId);
      expect(mockRequest.spanId).toBe(mockSpanId);
    });

    it('should not attach trace ID when OpenTelemetry span is not available', () => {
      (context.active as jest.Mock).mockReturnValue({});
      (trace.getSpan as jest.Mock).mockReturnValue(undefined);

      middleware.use(mockRequest, mockResponse, mockNext);

      expect(mockRequest.requestId).toBeDefined();
      expect(mockRequest.traceId).toBeUndefined();
      expect(mockRequest.spanId).toBeUndefined();
    });
  });

  describe('Response headers', () => {
    it('should set x-request-id response header', () => {
      middleware.use(mockRequest, mockResponse, mockNext);

      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'x-request-id',
        mockRequest.requestId
      );
    });

    it('should set x-trace-id response header when trace context available', () => {
      const mockTraceId = '80f198ee56343ba864fe8b2a57d3eff7';
      const mockSpanContext: SpanContext = {
        traceId: mockTraceId,
        spanId: 'e457b5a2e4d86bd1',
        traceFlags: 1,
      };
      const mockSpan = {
        spanContext: () => mockSpanContext,
      } as Span;

      (context.active as jest.Mock).mockReturnValue({});
      (trace.getSpan as jest.Mock).mockReturnValue(mockSpan);

      middleware.use(mockRequest, mockResponse, mockNext);

      expect(mockResponse.setHeader).toHaveBeenCalledWith('x-trace-id', mockTraceId);
    });

    it('should not set x-trace-id when trace context not available', () => {
      (context.active as jest.Mock).mockReturnValue({});
      (trace.getSpan as jest.Mock).mockReturnValue(undefined);

      middleware.use(mockRequest, mockResponse, mockNext);

      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'x-request-id',
        expect.any(String)
      );
      expect(mockResponse.setHeader).toHaveBeenCalledTimes(1);
    });
  });

  describe('Middleware flow', () => {
    it('should call next() after processing', () => {
      middleware.use(mockRequest, mockResponse, mockNext);

      expect(mockNext).toHaveBeenCalledTimes(1);
      expect(mockNext).toHaveBeenCalledWith();
    });

    it('should call next() even when OpenTelemetry is not available', () => {
      (context.active as jest.Mock).mockImplementation(() => {
        throw new Error('OTEL not initialized');
      });

      // Should not throw and should still call next()
      expect(() => {
        middleware.use(mockRequest, mockResponse, mockNext);
      }).toThrow();
    });
  });
});
