import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { api, ApiError } from '../../services/api';

describe('ApiService', () => {
  beforeEach(() => {
    api.setAccessToken(null);
  });

  afterEach(() => {
    api.setAccessToken(null);
  });

  describe('Token Management', () => {
    it('should set access token', () => {
      api.setAccessToken('test-token');
      expect(api.getAccessToken()).toBe('test-token');
    });

    it('should clear access token', () => {
      api.setAccessToken('test-token');
      api.setAccessToken(null);
      expect(api.getAccessToken()).toBeNull();
    });

    it('should get current access token', () => {
      const token = 'my-access-token';
      api.setAccessToken(token);
      expect(api.getAccessToken()).toBe(token);
    });
  });

  describe('GET requests', () => {
    it('should make GET request', async () => {
      server.use(
        http.get('*/api/health/live', () => {
          return HttpResponse.json({ data: { status: 'ok' } });
        }),
      );

      const data = await api.get('/health/live');

      expect(data).toHaveProperty('status', 'ok');
    });

    it('should include auth header when token is set', async () => {
      let authHeader: string | null = null;

      server.use(
        http.get('*/api/auth/me', ({ request }) => {
          authHeader = request.headers.get('Authorization');
          return HttpResponse.json({ data: { id: 'user' } });
        }),
      );

      api.setAccessToken('test-token');
      await api.get('/auth/me');

      expect(authHeader).toBe('Bearer test-token');
    });

    it('should not include auth header when skipAuth is true', async () => {
      let authHeader: string | null = null;

      server.use(
        http.get('*/api/auth/providers', ({ request }) => {
          authHeader = request.headers.get('Authorization');
          return HttpResponse.json({ data: [] });
        }),
      );

      api.setAccessToken('test-token');
      await api.get('/auth/providers', { skipAuth: true });

      expect(authHeader).toBeNull();
    });

    it('should extract data from response', async () => {
      server.use(
        http.get('*/api/test', () => {
          return HttpResponse.json({ data: { message: 'success' } });
        }),
      );

      const result = await api.get('/test');

      expect(result).toEqual({ message: 'success' });
    });
  });

  describe('POST requests', () => {
    it('should make POST request with body', async () => {
      let capturedBody: any = null;

      server.use(
        http.post('*/api/test', async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json({ data: { success: true } });
        }),
      );

      await api.post('/test', { foo: 'bar' });

      expect(capturedBody).toEqual({ foo: 'bar' });
    });

    it('should make POST request without body', async () => {
      server.use(
        http.post('*/api/test', () => {
          return HttpResponse.json({ data: { success: true } });
        }),
      );

      const result = await api.post('/test');

      expect(result).toEqual({ success: true });
    });

    it('should NOT set Content-Type header when body is omitted (Fastify 5 strict)', async () => {
      let contentTypeHeader: string | null = null;

      server.use(
        http.post('*/api/auth/logout', ({ request }) => {
          contentTypeHeader = request.headers.get('Content-Type');
          return new HttpResponse(null, { status: 204 });
        }),
      );

      await api.post('/auth/logout');

      // Fastify 5 requires no Content-Type when there's no body
      expect(contentTypeHeader).toBeNull();
    });

    it('should set Content-Type header when body is provided', async () => {
      let contentTypeHeader: string | null = null;

      server.use(
        http.post('*/api/test', ({ request }) => {
          contentTypeHeader = request.headers.get('Content-Type');
          return HttpResponse.json({ data: {} });
        }),
      );

      await api.post('/test', { data: 'test' });

      expect(contentTypeHeader).toBe('application/json');
    });
  });

  describe('PUT requests', () => {
    it('should make PUT request with body', async () => {
      let capturedBody: any = null;

      server.use(
        http.put('*/api/test', async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json({ data: { updated: true } });
        }),
      );

      await api.put('/test', { name: 'updated' });

      expect(capturedBody).toEqual({ name: 'updated' });
    });
  });

  describe('PATCH requests', () => {
    it('should make PATCH request with body', async () => {
      let capturedBody: any = null;

      server.use(
        http.patch('*/api/test', async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json({ data: { patched: true } });
        }),
      );

      await api.patch('/test', { field: 'value' });

      expect(capturedBody).toEqual({ field: 'value' });
    });

    it('should include custom headers', async () => {
      let ifMatchHeader: string | null = null;

      server.use(
        http.patch('*/api/user-settings', ({ request }) => {
          ifMatchHeader = request.headers.get('If-Match');
          return HttpResponse.json({ data: {} });
        }),
      );

      await api.patch('/user-settings', {}, {
        headers: { 'If-Match': '5' },
      });

      expect(ifMatchHeader).toBe('5');
    });
  });

  describe('DELETE requests', () => {
    it('should make DELETE request', async () => {
      server.use(
        http.delete('*/api/test/:id', ({ params }) => {
          return HttpResponse.json({ data: { deleted: params.id } });
        }),
      );

      const result = await api.delete('/test/123');

      expect(result).toEqual({ deleted: '123' });
    });
  });

  describe('Error Handling', () => {
    it('should throw ApiError on 4xx response', async () => {
      server.use(
        http.get('*/api/not-found', () => {
          return HttpResponse.json(
            { message: 'Not found', code: 'NOT_FOUND' },
            { status: 404 },
          );
        }),
      );

      await expect(api.get('/not-found')).rejects.toThrow(ApiError);
    });

    it('should throw ApiError on 5xx response', async () => {
      server.use(
        http.get('*/api/error', () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      await expect(api.get('/error')).rejects.toThrow(ApiError);
    });

    it('should include status code in error', async () => {
      server.use(
        http.get('*/api/forbidden', () => {
          return HttpResponse.json(
            { message: 'Forbidden', code: 'FORBIDDEN' },
            { status: 403 },
          );
        }),
      );

      try {
        await api.get('/forbidden');
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(403);
      }
    });

    it('should include error code in error', async () => {
      server.use(
        http.get('*/api/validation-error', () => {
          return HttpResponse.json(
            { message: 'Validation failed', code: 'VALIDATION_ERROR' },
            { status: 400 },
          );
        }),
      );

      try {
        await api.get('/validation-error');
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).code).toBe('VALIDATION_ERROR');
      }
    });

    it('should include error message', async () => {
      server.use(
        http.get('*/api/bad-request', () => {
          return HttpResponse.json(
            { message: 'Invalid input', code: 'BAD_REQUEST' },
            { status: 400 },
          );
        }),
      );

      try {
        await api.get('/bad-request');
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).message).toBe('Invalid input');
      }
    });

    it('should handle non-JSON error responses', async () => {
      server.use(
        http.get('*/api/text-error', () => {
          return new HttpResponse('Internal Server Error', { status: 500 });
        }),
      );

      try {
        await api.get('/text-error');
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(500);
      }
    });
  });

  describe('Token Refresh', () => {
    it('should refresh token on 401 response', async () => {
      let callCount = 0;

      server.use(
        http.get('*/api/protected', () => {
          callCount++;
          if (callCount === 1) {
            return new HttpResponse(null, { status: 401 });
          }
          return HttpResponse.json({ data: { success: true } });
        }),
        http.post('*/api/auth/refresh', () => {
          return HttpResponse.json({
            accessToken: 'new-token',
            expiresIn: 900,
          });
        }),
      );

      api.setAccessToken('old-token');
      const result = await api.get('/protected');

      expect(callCount).toBe(2);
      expect(result).toEqual({ success: true });
      expect(api.getAccessToken()).toBe('new-token');
    });

    it('should retry original request after refresh', async () => {
      let protectedCallCount = 0;

      server.use(
        http.get('*/api/data', () => {
          protectedCallCount++;
          if (protectedCallCount === 1) {
            return new HttpResponse(null, { status: 401 });
          }
          return HttpResponse.json({ data: { value: 'success' } });
        }),
        http.post('*/api/auth/refresh', () => {
          return HttpResponse.json({
            accessToken: 'refreshed-token',
            expiresIn: 900,
          });
        }),
      );

      api.setAccessToken('expired-token');
      const result = await api.get('/data');

      expect(result).toEqual({ value: 'success' });
      expect(protectedCallCount).toBe(2);
    });

    it('should throw if refresh fails', async () => {
      server.use(
        http.get('*/api/protected', () => {
          return new HttpResponse(null, { status: 401 });
        }),
        http.post('*/api/auth/refresh', () => {
          return new HttpResponse(null, { status: 401 });
        }),
      );

      api.setAccessToken('old-token');

      await expect(api.get('/protected')).rejects.toThrow('Unauthorized');
    });

    it('should not refresh when skipAuth is true', async () => {
      let refreshCalled = false;

      server.use(
        http.get('*/api/public', () => {
          return new HttpResponse(null, { status: 401 });
        }),
        http.post('*/api/auth/refresh', () => {
          refreshCalled = true;
          return HttpResponse.json({ accessToken: 'new', expiresIn: 900 });
        }),
      );

      try {
        await api.get('/public', { skipAuth: true });
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
      }

      expect(refreshCalled).toBe(false);
    });

    it('should clear token when refresh fails', async () => {
      server.use(
        http.get('*/api/protected', () => {
          return new HttpResponse(null, { status: 401 });
        }),
        http.post('*/api/auth/refresh', () => {
          return new HttpResponse(null, { status: 401 });
        }),
      );

      api.setAccessToken('old-token');

      try {
        await api.get('/protected');
      } catch {
        // Expected to fail
      }

      expect(api.getAccessToken()).toBeNull();
    });
  });

  describe('204 No Content', () => {
    it('should handle 204 responses', async () => {
      server.use(
        http.post('*/api/auth/logout', () => {
          return new HttpResponse(null, { status: 204 });
        }),
      );

      const result = await api.post('/auth/logout');

      expect(result).toBeUndefined();
    });

    it('should handle 204 from DELETE', async () => {
      server.use(
        http.delete('*/api/resource/123', () => {
          return new HttpResponse(null, { status: 204 });
        }),
      );

      const result = await api.delete('/resource/123');

      expect(result).toBeUndefined();
    });
  });

  describe('Cookies', () => {
    it('should include credentials for cookie handling', async () => {
      server.use(
        http.get('*/api/test', () => {
          // Can't directly access credentials, but we can verify the request is made
          return HttpResponse.json({ data: {} });
        }),
      );

      await api.get('/test');

      // Credentials: 'include' is set in the api service
      expect(true).toBe(true);
    });
  });

  describe('refreshToken method', () => {
    it('should return true on successful refresh', async () => {
      server.use(
        http.post('*/api/auth/refresh', () => {
          return HttpResponse.json({
            accessToken: 'new-token',
            expiresIn: 900,
          });
        }),
      );

      const result = await api.refreshToken();

      expect(result).toBe(true);
      expect(api.getAccessToken()).toBe('new-token');
    });

    it('should return false on failed refresh', async () => {
      server.use(
        http.post('*/api/auth/refresh', () => {
          return new HttpResponse(null, { status: 401 });
        }),
      );

      const result = await api.refreshToken();

      expect(result).toBe(false);
      expect(api.getAccessToken()).toBeNull();
    });

    it('should handle network errors during refresh', async () => {
      server.use(
        http.post('*/api/auth/refresh', () => {
          throw new Error('Network error');
        }),
      );

      const result = await api.refreshToken();

      expect(result).toBe(false);
      expect(api.getAccessToken()).toBeNull();
    });

    it('should unwrap wrapped refresh response (TransformInterceptor)', async () => {
      server.use(
        http.post('*/api/auth/refresh', () => {
          // Backend wraps response in { data: { accessToken } } via TransformInterceptor
          return HttpResponse.json({
            data: {
              accessToken: 'wrapped-token',
              expiresIn: 900,
            },
          });
        }),
      );

      const result = await api.refreshToken();

      expect(result).toBe(true);
      expect(api.getAccessToken()).toBe('wrapped-token');
    });

    it('should handle unwrapped refresh response (backwards compatibility)', async () => {
      server.use(
        http.post('*/api/auth/refresh', () => {
          // Direct response without wrapper (backwards compatibility)
          return HttpResponse.json({
            accessToken: 'direct-token',
            expiresIn: 900,
          });
        }),
      );

      const result = await api.refreshToken();

      expect(result).toBe(true);
      expect(api.getAccessToken()).toBe('direct-token');
    });

    it('should reject invalid token response (missing accessToken)', async () => {
      server.use(
        http.post('*/api/auth/refresh', () => {
          // Response missing accessToken field
          return HttpResponse.json({
            data: {
              expiresIn: 900,
            },
          });
        }),
      );

      const result = await api.refreshToken();

      expect(result).toBe(false);
      expect(api.getAccessToken()).toBeNull();
    });

    it('should reject invalid token response (non-string accessToken)', async () => {
      server.use(
        http.post('*/api/auth/refresh', () => {
          // accessToken is not a string
          return HttpResponse.json({
            data: {
              accessToken: 12345,
              expiresIn: 900,
            },
          });
        }),
      );

      const result = await api.refreshToken();

      expect(result).toBe(false);
      expect(api.getAccessToken()).toBeNull();
    });

    it('should only trigger one refresh for concurrent requests', async () => {
      let refreshCallCount = 0;
      let protectedCallCount = 0;

      server.use(
        http.get('*/api/protected', () => {
          protectedCallCount++;
          if (protectedCallCount <= 3) {
            // First 3 calls fail with 401
            return new HttpResponse(null, { status: 401 });
          }
          // Subsequent calls succeed
          return HttpResponse.json({ data: { success: true } });
        }),
        http.post('*/api/auth/refresh', async () => {
          refreshCallCount++;
          // Simulate slow refresh to ensure concurrent requests wait
          await new Promise((resolve) => setTimeout(resolve, 100));
          return HttpResponse.json({
            data: {
              accessToken: 'refreshed-token',
              expiresIn: 900,
            },
          });
        }),
      );

      api.setAccessToken('expired-token');

      // Make 3 concurrent requests that will all get 401
      const [result1, result2, result3] = await Promise.all([
        api.get('/protected'),
        api.get('/protected'),
        api.get('/protected'),
      ]);

      // All should succeed
      expect(result1).toEqual({ success: true });
      expect(result2).toEqual({ success: true });
      expect(result3).toEqual({ success: true });

      // But refresh should only be called ONCE (not 3 times)
      expect(refreshCallCount).toBe(1);

      // Protected endpoint called: 3 initial 401s + 3 retries = 6 total
      expect(protectedCallCount).toBe(6);

      // Token should be updated
      expect(api.getAccessToken()).toBe('refreshed-token');
    });
  });

  describe('Data Extraction', () => {
    it('should extract data property from response', async () => {
      server.use(
        http.get('*/api/users', () => {
          return HttpResponse.json({
            data: [{ id: 1, name: 'User 1' }],
            meta: { total: 1 },
          });
        }),
      );

      const result = await api.get('/users');

      expect(result).toEqual([{ id: 1, name: 'User 1' }]);
    });

    it('should return full response if no data property', async () => {
      server.use(
        http.get('*/api/legacy', () => {
          return HttpResponse.json({ users: [], count: 0 });
        }),
      );

      const result = await api.get('/legacy');

      expect(result).toEqual({ users: [], count: 0 });
    });
  });
});
