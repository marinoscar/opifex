import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import {
  ApiError,
  createTrustGrant,
  demoteActionClass,
  getPromotionLadder,
  getPromotionState,
  getTrustGrant,
  getTrustGrants,
  revokeTrustGrant,
  trustErrorDetails,
} from '../../services/api';

/**
 * The trust client (#101). What is asserted here is the WIRE CONTRACT — the
 * query parameters that reach each endpoint, the shape of the revocation body,
 * and the refusal `details` the cockpit branches on — because each is a place
 * where a plausible client would be silently wrong.
 */

const API = '*/api';

function envelope(data: unknown) {
  return HttpResponse.json({
    data,
    meta: { timestamp: new Date().toISOString() },
  });
}

describe('getTrustGrants', () => {
  it('sends only the parameters the endpoint accepts', async () => {
    const urls: string[] = [];
    server.use(
      http.get(`${API}/trust/grants`, ({ request }) => {
        urls.push(new URL(request.url).search);
        return envelope([]);
      }),
    );

    await getTrustGrants();
    await getTrustGrants({ status: 'revoked', repositoryId: 'acme/api' });
    await getTrustGrants({ actionClass: 're-dispatch' });

    expect(urls[0]).toBe('');
    expect(urls[1]).toContain('status=revoked');
    expect(urls[1]).toContain('repositoryId=acme%2Fapi');
    expect(urls[2]).toContain('actionClass=re-dispatch');
  });

  it('sends `includeEnded` as the literal word, and omits it when false', async () => {
    // The API parses this with `z.stringbool()` rather than
    // `z.coerce.boolean()` precisely because the latter maps every non-empty
    // string to true — under which `includeEnded=false` would mean TRUE. So
    // the client must never send the word "false".
    const urls: string[] = [];
    server.use(
      http.get(`${API}/trust/grants`, ({ request }) => {
        urls.push(new URL(request.url).search);
        return envelope([]);
      }),
    );

    await getTrustGrants({ includeEnded: true });
    await getTrustGrants({ includeEnded: false });

    expect(urls[0]).toContain('includeEnded=true');
    expect(urls[1]).not.toContain('includeEnded');
  });

  it('returns the server order untouched', async () => {
    server.use(
      http.get(`${API}/trust/grants`, () =>
        envelope([{ id: 'newest' }, { id: 'oldest' }]),
      ),
    );

    const grants = await getTrustGrants();

    expect(grants.map((grant) => grant.id)).toEqual(['newest', 'oldest']);
  });
});

describe('getTrustGrant', () => {
  it('encodes the id into the path', async () => {
    const paths: string[] = [];
    server.use(
      http.get(`${API}/trust/grants/:id`, ({ request }) => {
        paths.push(new URL(request.url).pathname);
        return envelope({ id: 'g/1' });
      }),
    );

    await getTrustGrant('g/1');

    expect(paths[0]).toBe('/api/trust/grants/g%2F1');
  });
});

describe('revokeTrustGrant', () => {
  it('sends NO body when there is no note', async () => {
    // The API's schema defaults to `{}` so that a DELETE with no body is not a
    // 400: revocation is the safe direction and must never be harder than
    // granting. Sending `{}` would work too — sending nothing proves the
    // client does not depend on the body existing.
    const bodies: string[] = [];
    server.use(
      http.delete(`${API}/trust/grants/:id`, async ({ request }) => {
        bodies.push(await request.text());
        return envelope({ id: 'g-1', status: 'revoked' });
      }),
    );

    await revokeTrustGrant('g-1');
    await revokeTrustGrant('g-1', '   ');

    // Whitespace is not a note. `endDetail` is the sentence the next operator
    // reads, and appending three spaces to it says nothing.
    expect(bodies).toEqual(['', '']);
  });

  it('sends the trimmed note when there is one', async () => {
    let body: unknown;
    server.use(
      http.delete(`${API}/trust/grants/:id`, async ({ request }) => {
        body = await request.json();
        return envelope({ id: 'g-1', status: 'revoked' });
      }),
    );

    await revokeTrustGrant('g-1', '  misfiring on acme/api  ');

    expect(body).toEqual({ note: 'misfiring on acme/api' });
  });

  it('throws an ApiError whose details carry the 409 discriminator', async () => {
    // `HttpExceptionFilter` derives the envelope's `code` from the status, so
    // the value a client branches on travels in `details.reason` — which is
    // why `trustErrorDetails` reads `details` and not `ApiError.code`.
    server.use(
      http.delete(`${API}/trust/grants/:id`, () =>
        HttpResponse.json(
          {
            statusCode: 409,
            code: 'CONFLICT',
            message: 'Trust grant g-1 is already suspended.',
            details: {
              reason: 'already-ended',
              status: 'suspended',
              endReason: 'failure_rate_exceeded',
            },
            timestamp: new Date().toISOString(),
            path: '/api/trust/grants/g-1',
          },
          { status: 409 },
        ),
      ),
    );

    const error = await revokeTrustGrant('g-1').catch((cause) => cause);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect(trustErrorDetails(error)).toMatchObject({
      reason: 'already-ended',
      status: 'suspended',
      endReason: 'failure_rate_exceeded',
    });
  });

  it('returns an empty details block for anything that is not an ApiError', () => {
    expect(trustErrorDetails(new Error('boom'))).toEqual({});
    expect(trustErrorDetails(new ApiError('boom', 500))).toEqual({});
  });
});

describe('createTrustGrant', () => {
  it('sends exactly the three fields the strict schema accepts', async () => {
    // The create schema is `.strict()`: an extra key is a 400 naming the
    // field, because the four VISION §8 attributes are attached by the server
    // and are not caller input. The client's signature is narrow for the same
    // reason.
    let body: unknown;
    server.use(
      http.post(`${API}/trust/grants`, async ({ request }) => {
        body = await request.json();
        return envelope({ id: 'g-new' });
      }),
    );

    await createTrustGrant({
      actionClass: 're-dispatch',
      repositoryId: 'acme/api',
      note: 'from an approval',
    });

    expect(body).toEqual({
      actionClass: 're-dispatch',
      repositoryId: 'acme/api',
      note: 'from an approval',
    });
  });
});

describe('the promotion endpoints', () => {
  it('reads the whole ladder, `enabled` flag included', async () => {
    server.use(
      http.get(`${API}/promotion/states`, () =>
        envelope({
          enabled: false,
          readAt: new Date().toISOString(),
          thresholds: {
            minSample: 10,
            promotionRate: 0.9,
            demotionRate: 0.5,
            demotionMinSample: 5,
            regressionWindowDays: 14,
            manualHoldDays: 14,
          },
          states: [],
        }),
      ),
    );

    const ladder = await getPromotionLadder();

    // `false` has to survive the trip: it is the flag that decides whether any
    // rung on the screen is a live conclusion.
    expect(ladder.enabled).toBe(false);
    expect(ladder.thresholds.minSample).toBe(10);
  });

  it('encodes the action class into the path', async () => {
    const paths: string[] = [];
    server.use(
      http.get(`${API}/promotion/states/:actionClass`, ({ request }) => {
        paths.push(new URL(request.url).pathname);
        return envelope({ enabled: true, state: {} });
      }),
    );

    await getPromotionState('quarantine/decision');

    expect(paths[0]).toBe('/api/promotion/states/quarantine%2Fdecision');
  });

  it('posts a demotion with no body when there is no note', async () => {
    const bodies: string[] = [];
    server.use(
      http.post(
        `${API}/promotion/states/:actionClass/demote`,
        async ({ request }) => {
          bodies.push(await request.text());
          return envelope({
            state: {},
            grantsSuspended: 0,
            notified: false,
            manualHoldUntil: '2026-09-06T10:00:00.000Z',
            rungMayBeRestoredByLadder: false,
          });
        },
      ),
    );

    await demoteActionClass('runner-restart');
    await demoteActionClass('runner-restart', 'oscillating');

    expect(bodies[0]).toBe('');
    expect(JSON.parse(bodies[1])).toEqual({ note: 'oscillating' });
  });

  it('surfaces the 409 discriminator for a class that is not promoted', async () => {
    server.use(
      http.post(`${API}/promotion/states/:actionClass/demote`, () =>
        HttpResponse.json(
          {
            statusCode: 409,
            code: 'CONFLICT',
            message: 'runner-restart is not on the promoted rung.',
            details: { reason: 'not-promoted', rung: 'measure' },
            timestamp: new Date().toISOString(),
            path: '/api/promotion/states/runner-restart/demote',
          },
          { status: 409 },
        ),
      ),
    );

    const error = await demoteActionClass('runner-restart').catch(
      (cause) => cause,
    );

    expect(trustErrorDetails(error)).toMatchObject({
      reason: 'not-promoted',
      rung: 'measure',
    });
  });
});
