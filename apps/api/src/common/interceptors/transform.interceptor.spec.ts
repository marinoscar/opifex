import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { TransformInterceptor, ApiResponse } from './transform.interceptor';
import { of } from 'rxjs';

describe('TransformInterceptor', () => {
  let interceptor: TransformInterceptor<any>;

  beforeEach(async () => {
    interceptor = new TransformInterceptor();
  });

  function createMockContext(): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({}),
        getResponse: () => ({}),
      }),
      getClass: () => jest.fn(),
      getHandler: () => jest.fn(),
    } as any;
  }

  function createMockCallHandler(data: any): CallHandler {
    return {
      handle: () => of(data),
    } as CallHandler;
  }

  describe('Response wrapping', () => {
    it('should wrap response data in standard format', (done) => {
      const context = createMockContext();
      const testData = { id: 1, name: 'test' };
      const callHandler = createMockCallHandler(testData);

      interceptor.intercept(context, callHandler).subscribe((result: ApiResponse<any>) => {
        expect(result).toHaveProperty('data');
        expect(result).toHaveProperty('meta');
        expect(result.data).toEqual(testData);
        done();
      });
    });

    it('should add timestamp to meta', (done) => {
      const context = createMockContext();
      const testData = { value: 'test' };
      const callHandler = createMockCallHandler(testData);

      const beforeTime = new Date().toISOString();

      interceptor.intercept(context, callHandler).subscribe((result: ApiResponse<any>) => {
        expect(result.meta).toBeDefined();
        expect(result.meta!.timestamp).toBeDefined();
        expect(typeof result.meta!.timestamp).toBe('string');

        // Verify timestamp is valid ISO string
        expect(() => new Date(result.meta!.timestamp)).not.toThrow();

        const afterTime = new Date().toISOString();
        expect(result.meta!.timestamp >= beforeTime).toBe(true);
        expect(result.meta!.timestamp <= afterTime).toBe(true);
        done();
      });
    });

    it('should preserve original response data unchanged', (done) => {
      const context = createMockContext();
      const testData = {
        id: 123,
        name: 'John Doe',
        nested: {
          field: 'value',
          array: [1, 2, 3],
        },
      };
      const callHandler = createMockCallHandler(testData);

      interceptor.intercept(context, callHandler).subscribe((result: ApiResponse<any>) => {
        expect(result.data).toEqual(testData);
        expect(result.data.id).toBe(123);
        expect(result.data.nested.field).toBe('value');
        expect(result.data.nested.array).toEqual([1, 2, 3]);
        done();
      });
    });
  });

  describe('Null and undefined handling', () => {
    it('should handle null responses', (done) => {
      const context = createMockContext();
      const callHandler = createMockCallHandler(null);

      interceptor.intercept(context, callHandler).subscribe((result: ApiResponse<any>) => {
        expect(result).toHaveProperty('data');
        expect(result.data).toBeNull();
        expect(result.meta).toBeDefined();
        done();
      });
    });

    it('should handle undefined responses', (done) => {
      const context = createMockContext();
      const callHandler = createMockCallHandler(undefined);

      interceptor.intercept(context, callHandler).subscribe((result: ApiResponse<any>) => {
        expect(result).toHaveProperty('data');
        expect(result.data).toBeUndefined();
        expect(result.meta).toBeDefined();
        done();
      });
    });

    it('should handle empty string responses', (done) => {
      const context = createMockContext();
      const callHandler = createMockCallHandler('');

      interceptor.intercept(context, callHandler).subscribe((result: ApiResponse<any>) => {
        expect(result.data).toBe('');
        expect(result.meta).toBeDefined();
        done();
      });
    });

    it('should handle zero number responses', (done) => {
      const context = createMockContext();
      const callHandler = createMockCallHandler(0);

      interceptor.intercept(context, callHandler).subscribe((result: ApiResponse<any>) => {
        expect(result.data).toBe(0);
        expect(result.meta).toBeDefined();
        done();
      });
    });

    it('should handle false boolean responses', (done) => {
      const context = createMockContext();
      const callHandler = createMockCallHandler(false);

      interceptor.intercept(context, callHandler).subscribe((result: ApiResponse<any>) => {
        expect(result.data).toBe(false);
        expect(result.meta).toBeDefined();
        done();
      });
    });
  });

  describe('Array responses', () => {
    it('should handle empty array responses', (done) => {
      const context = createMockContext();
      const callHandler = createMockCallHandler([]);

      interceptor.intercept(context, callHandler).subscribe((result: ApiResponse<any>) => {
        expect(result.data).toEqual([]);
        expect(Array.isArray(result.data)).toBe(true);
        expect(result.meta).toBeDefined();
        done();
      });
    });

    it('should handle array with primitive values', (done) => {
      const context = createMockContext();
      const testData = [1, 2, 3, 4, 5];
      const callHandler = createMockCallHandler(testData);

      interceptor.intercept(context, callHandler).subscribe((result: ApiResponse<any>) => {
        expect(result.data).toEqual(testData);
        expect(Array.isArray(result.data)).toBe(true);
        done();
      });
    });

    it('should handle array with objects', (done) => {
      const context = createMockContext();
      const testData = [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ];
      const callHandler = createMockCallHandler(testData);

      interceptor.intercept(context, callHandler).subscribe((result: ApiResponse<any>) => {
        expect(result.data).toEqual(testData);
        expect(result.data[0].name).toBe('Alice');
        expect(result.data[1].name).toBe('Bob');
        done();
      });
    });

    it('should handle nested arrays', (done) => {
      const context = createMockContext();
      const testData = [[1, 2], [3, 4], [5, 6]];
      const callHandler = createMockCallHandler(testData);

      interceptor.intercept(context, callHandler).subscribe((result: ApiResponse<any>) => {
        expect(result.data).toEqual(testData);
        done();
      });
    });
  });

  describe('Nested object responses', () => {
    it('should handle deeply nested objects', (done) => {
      const context = createMockContext();
      const testData = {
        level1: {
          level2: {
            level3: {
              level4: {
                value: 'deep',
              },
            },
          },
        },
      };
      const callHandler = createMockCallHandler(testData);

      interceptor.intercept(context, callHandler).subscribe((result: ApiResponse<any>) => {
        expect(result.data).toEqual(testData);
        expect(result.data.level1.level2.level3.level4.value).toBe('deep');
        done();
      });
    });

    it('should handle objects with mixed types', (done) => {
      const context = createMockContext();
      const testData = {
        string: 'text',
        number: 42,
        boolean: true,
        null: null,
        array: [1, 2, 3],
        object: { nested: 'value' },
      };
      const callHandler = createMockCallHandler(testData);

      interceptor.intercept(context, callHandler).subscribe((result: ApiResponse<any>) => {
        expect(result.data).toEqual(testData);
        done();
      });
    });

    it('should handle circular reference safety (no infinite loop)', (done) => {
      const context = createMockContext();
      const testData = { id: 1, name: 'test' };
      const callHandler = createMockCallHandler(testData);

      // This should complete without hanging
      interceptor.intercept(context, callHandler).subscribe((result: ApiResponse<any>) => {
        expect(result.data).toEqual(testData);
        done();
      });
    });
  });

  describe('Already wrapped responses', () => {
    it('should not double-wrap responses that already have data property', (done) => {
      const context = createMockContext();
      const alreadyWrapped = {
        data: { id: 1, name: 'test' },
        meta: { timestamp: new Date().toISOString() },
      };
      const callHandler = createMockCallHandler(alreadyWrapped);

      interceptor.intercept(context, callHandler).subscribe((result: ApiResponse<any>) => {
        expect(result).toEqual(alreadyWrapped);
        // Should not have nested data.data
        expect(result.data).not.toHaveProperty('data');
        done();
      });
    });

    it('should return as-is when response has data property', (done) => {
      const context = createMockContext();
      const customResponse = {
        data: [1, 2, 3],
        meta: {
          timestamp: '2024-01-01T00:00:00.000Z',
          total: 3,
        },
      };
      const callHandler = createMockCallHandler(customResponse);

      interceptor.intercept(context, callHandler).subscribe((result: ApiResponse<any>) => {
        expect(result).toBe(customResponse);
        expect(result.data).toEqual([1, 2, 3]);
        expect(result.meta!.total).toBe(3);
        done();
      });
    });

    it('should handle response with data property but no meta', (done) => {
      const context = createMockContext();
      const partialWrapped = {
        data: { value: 'test' },
      };
      const callHandler = createMockCallHandler(partialWrapped);

      interceptor.intercept(context, callHandler).subscribe((result: ApiResponse<any>) => {
        expect(result).toEqual(partialWrapped);
        done();
      });
    });
  });

  describe('Special response types', () => {
    it('should handle Date objects', (done) => {
      const context = createMockContext();
      const testData = { timestamp: new Date('2024-01-01') };
      const callHandler = createMockCallHandler(testData);

      interceptor.intercept(context, callHandler).subscribe((result: ApiResponse<any>) => {
        expect(result.data.timestamp).toBeInstanceOf(Date);
        done();
      });
    });

    it('should handle responses with functions (though unusual)', (done) => {
      const context = createMockContext();
      const testData = {
        value: 'test',
        method: function() { return 'function'; },
      };
      const callHandler = createMockCallHandler(testData);

      interceptor.intercept(context, callHandler).subscribe((result: ApiResponse<any>) => {
        expect(result.data.value).toBe('test');
        expect(typeof result.data.method).toBe('function');
        done();
      });
    });

    it('should handle Map objects', (done) => {
      const context = createMockContext();
      const testData = new Map([['key', 'value']]);
      const callHandler = createMockCallHandler(testData);

      interceptor.intercept(context, callHandler).subscribe((result: ApiResponse<any>) => {
        expect(result.data).toBeInstanceOf(Map);
        done();
      });
    });

    it('should handle Set objects', (done) => {
      const context = createMockContext();
      const testData = new Set([1, 2, 3]);
      const callHandler = createMockCallHandler(testData);

      interceptor.intercept(context, callHandler).subscribe((result: ApiResponse<any>) => {
        expect(result.data).toBeInstanceOf(Set);
        done();
      });
    });
  });

  describe('String and primitive responses', () => {
    it('should wrap string responses', (done) => {
      const context = createMockContext();
      const testData = 'plain text response';
      const callHandler = createMockCallHandler(testData);

      interceptor.intercept(context, callHandler).subscribe((result: ApiResponse<any>) => {
        expect(result.data).toBe(testData);
        expect(result.meta).toBeDefined();
        done();
      });
    });

    it('should wrap number responses', (done) => {
      const context = createMockContext();
      const testData = 42;
      const callHandler = createMockCallHandler(testData);

      interceptor.intercept(context, callHandler).subscribe((result: ApiResponse<any>) => {
        expect(result.data).toBe(42);
        expect(result.meta).toBeDefined();
        done();
      });
    });

    it('should wrap boolean responses', (done) => {
      const context = createMockContext();
      const testData = true;
      const callHandler = createMockCallHandler(testData);

      interceptor.intercept(context, callHandler).subscribe((result: ApiResponse<any>) => {
        expect(result.data).toBe(true);
        expect(result.meta).toBeDefined();
        done();
      });
    });
  });

  describe('Observable behavior', () => {
    it('should maintain observable chain', (done) => {
      const context = createMockContext();
      const testData = { value: 'test' };
      const callHandler = createMockCallHandler(testData);

      const observable = interceptor.intercept(context, callHandler);

      expect(observable).toBeDefined();
      expect(typeof observable.subscribe).toBe('function');

      observable.subscribe({
        next: (result) => {
          expect(result.data).toEqual(testData);
        },
        complete: done,
      });
    });

    it('should allow multiple subscriptions', (done) => {
      const context = createMockContext();
      const testData = { value: 'test' };
      const callHandler = createMockCallHandler(testData);

      const observable = interceptor.intercept(context, callHandler);

      let subscription1Complete = false;
      let subscription2Complete = false;

      observable.subscribe({
        next: (result) => expect(result.data).toEqual(testData),
        complete: () => {
          subscription1Complete = true;
          if (subscription2Complete) done();
        },
      });

      observable.subscribe({
        next: (result) => expect(result.data).toEqual(testData),
        complete: () => {
          subscription2Complete = true;
          if (subscription1Complete) done();
        },
      });
    });
  });
});
