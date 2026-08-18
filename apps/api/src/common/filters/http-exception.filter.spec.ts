import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

describe('HttpExceptionFilter', () => {
  let filter: HttpExceptionFilter;
  let mockResponse: any;
  let mockRequest: any;
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    filter = new HttpExceptionFilter();

    // Mock Fastify response object
    mockResponse = {
      code: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
    };

    mockRequest = {
      url: '/api/test',
      method: 'GET',
    };

    mockHost = {
      switchToHttp: () => ({
        getResponse: () => mockResponse,
        getRequest: () => mockRequest,
      }),
    } as ArgumentsHost;
  });

  describe('HttpException handling', () => {
    it('should format HttpException with proper status code and message', () => {
      const exception = new HttpException('Test error', HttpStatus.BAD_REQUEST);

      filter.catch(exception, mockHost);

      expect(mockResponse.code).toHaveBeenCalledWith(400);
      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
          code: 'BAD_REQUEST',
          message: 'Test error',
        }),
      );
    });

    it('should handle 400 Bad Request with validation errors', () => {
      const validationErrors = [
        { field: 'email', message: 'Invalid email format' },
        { field: 'password', message: 'Password too short' },
      ];
      const exception = new HttpException(
        {
          message: 'Validation failed',
          details: validationErrors,
        },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, mockHost);

      expect(mockResponse.code).toHaveBeenCalledWith(400);
      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
          code: 'BAD_REQUEST',
          message: 'Validation failed',
          details: validationErrors,
        }),
      );
    });

    it('should handle 401 Unauthorized', () => {
      const exception = new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);

      filter.catch(exception, mockHost);

      expect(mockResponse.code).toHaveBeenCalledWith(401);
      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 401,
          code: 'UNAUTHORIZED',
          message: 'Unauthorized',
        }),
      );
    });

    it('should handle 403 Forbidden', () => {
      const exception = new HttpException('Forbidden', HttpStatus.FORBIDDEN);

      filter.catch(exception, mockHost);

      expect(mockResponse.code).toHaveBeenCalledWith(403);
      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 403,
          code: 'FORBIDDEN',
          message: 'Forbidden',
        }),
      );
    });

    it('should handle 404 Not Found', () => {
      const exception = new HttpException('Resource not found', HttpStatus.NOT_FOUND);

      filter.catch(exception, mockHost);

      expect(mockResponse.code).toHaveBeenCalledWith(404);
      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 404,
          code: 'NOT_FOUND',
          message: 'Resource not found',
        }),
      );
    });

    it('should handle 409 Conflict', () => {
      const exception = new HttpException('Resource already exists', HttpStatus.CONFLICT);

      filter.catch(exception, mockHost);

      expect(mockResponse.code).toHaveBeenCalledWith(409);
      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 409,
          code: 'CONFLICT',
          message: 'Resource already exists',
        }),
      );
    });

    it('should handle 412 Precondition Failed', () => {
      const exception = new HttpException(
        'Version mismatch',
        HttpStatus.PRECONDITION_FAILED,
      );

      filter.catch(exception, mockHost);

      expect(mockResponse.code).toHaveBeenCalledWith(412);
      // Note: 412 maps to 'ERROR' since it's not in the codeMap
      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 412,
          code: 'ERROR',
          message: 'Version mismatch',
        }),
      );
    });

    it('should handle 500 Internal Server Error', () => {
      const exception = new HttpException(
        'Internal error',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );

      filter.catch(exception, mockHost);

      expect(mockResponse.code).toHaveBeenCalledWith(500);
      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 500,
          code: 'INTERNAL_ERROR',
          message: 'Internal error',
        }),
      );
    });
  });

  describe('Error response structure', () => {
    it('should include timestamp in error response', () => {
      const exception = new HttpException('Test', HttpStatus.BAD_REQUEST);
      const beforeTime = new Date().toISOString();

      filter.catch(exception, mockHost);

      const response = mockResponse.send.mock.calls[0][0];
      expect(response.timestamp).toBeDefined();
      expect(new Date(response.timestamp)).toBeInstanceOf(Date);
      expect(response.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should include request path in error response', () => {
      const exception = new HttpException('Test', HttpStatus.BAD_REQUEST);
      mockRequest.url = '/api/users/123';

      filter.catch(exception, mockHost);

      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          path: '/api/users/123',
        }),
      );
    });

    it('should handle exceptions with error array (validation errors)', () => {
      const errors = [
        { property: 'email', constraints: { isEmail: 'email must be an email' } },
        { property: 'age', constraints: { min: 'age must be >= 18' } },
      ];
      const exception = new HttpException(
        {
          message: 'Validation failed',
          details: errors,
        },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, mockHost);

      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
          message: 'Validation failed',
          details: errors,
        }),
      );
    });

    it('should not include details field when no details provided', () => {
      const exception = new HttpException('Simple error', HttpStatus.BAD_REQUEST);

      filter.catch(exception, mockHost);

      const response = mockResponse.send.mock.calls[0][0];
      expect(response.details).toBeUndefined();
    });
  });

  describe('Generic Error handling', () => {
    it('should handle generic Error objects (non-HttpException)', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      const error = new Error('Something went wrong');

      filter.catch(error, mockHost);

      expect(mockResponse.code).toHaveBeenCalledWith(500);
      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 500,
          code: 'INTERNAL_ERROR',
          message: 'Something went wrong',
          details: expect.stringContaining('Error: Something went wrong'),
        }),
      );

      process.env.NODE_ENV = originalEnv;
    });

    it('should not expose stack traces in production', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      const error = new Error('Something went wrong');

      filter.catch(error, mockHost);

      const response = mockResponse.send.mock.calls[0][0];
      expect(response.details).toBeUndefined();

      process.env.NODE_ENV = originalEnv;
    });

    it('should handle unknown exception types', () => {
      const unknownError = { some: 'unknown error' };

      filter.catch(unknownError, mockHost);

      expect(mockResponse.code).toHaveBeenCalledWith(500);
      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 500,
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred',
        }),
      );
    });
  });

  describe('Error code mapping', () => {
    it('should map 422 to UNPROCESSABLE_ENTITY', () => {
      const exception = new HttpException('Invalid data', HttpStatus.UNPROCESSABLE_ENTITY);

      filter.catch(exception, mockHost);

      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'UNPROCESSABLE_ENTITY',
        }),
      );
    });

    it('should map 429 to TOO_MANY_REQUESTS', () => {
      const exception = new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS);

      filter.catch(exception, mockHost);

      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'TOO_MANY_REQUESTS',
        }),
      );
    });

    it('should default to ERROR for unmapped status codes', () => {
      const exception = new HttpException('Service unavailable', HttpStatus.SERVICE_UNAVAILABLE);

      filter.catch(exception, mockHost);

      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 503,
          code: 'ERROR',
        }),
      );
    });
  });

  describe('String vs Object response handling', () => {
    it('should handle string exception response', () => {
      const exception = new HttpException('Simple string message', HttpStatus.BAD_REQUEST);

      filter.catch(exception, mockHost);

      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Simple string message',
        }),
      );
    });

    it('should handle object exception response with custom code', () => {
      const exception = new HttpException(
        {
          code: 'CUSTOM_CODE',
          message: 'Custom error',
        },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, mockHost);

      // Note: The filter overrides custom code with standard code mapping
      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'BAD_REQUEST',
          message: 'Custom error',
        }),
      );
    });
  });
});
