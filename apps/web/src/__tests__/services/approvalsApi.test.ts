import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import {
  ApiError,
  approvalErrorDetails,
  decideApproval,
  getApprovalRates,
  getApprovals,
} from '../../services/api';

/**
 * The approvals client (#98). What is asserted here is the WIRE CONTRACT — the
 * query parameters that reach the endpoint, and the refusal `details` the
 * cockpit branches on — because both are places where a plausible client would
 * be silently wrong.
 */

const API = '*/api';

function envelope(data: unknown) {
  return HttpResponse.json({
    data,
    meta: { timestamp: new Date().toISOString() },
  });
}

describe('getApprovals', () => {
  it('sends only the parameters the endpoint accepts', async () => {
    const urls: string[] = [];
    server.use(
      http.get(`${API}/approvals`, ({ request }) => {
        urls.push(new URL(request.url).search);
        return envelope([]);
      }),
    );

    await getApprovals();
    await getApprovals({ status: 'parked', repositoryId: 'acme/api' });

    expect(urls[0]).toBe('');
    expect(urls[1]).toContain('status=parked');
    expect(urls[1]).toContain('repositoryId=acme%2Fapi');
  });

  it('returns the server order untouched', async () => {
    server.use(
      http.get(`${API}/approvals`, () =>
        envelope([{ id: 'oldest' }, { id: 'newest' }]),
      ),
    );

    const queue = await getApprovals();

    // The client must never re-sort: oldest first is the ordering the queue
    // exists to surface.
    expect(queue.map((approval) => approval.id)).toEqual(['oldest', 'newest']);
  });
});

describe('getApprovalRates', () => {
  it('omits the window entirely when the caller does not choose one', async () => {
    const urls: string[] = [];
    server.use(
      http.get(`${API}/approvals/rates`, ({ request }) => {
        urls.push(new URL(request.url).search);
        return envelope([]);
      }),
    );

    await getApprovalRates();
    await getApprovalRates(7);

    // No `days=30` invented client-side: the DEFAULT belongs to the endpoint,
    // and a second copy here would drift the day it changes.
    expect(urls[0]).toBe('');
    expect(urls[1]).toBe('?days=7');
  });
});

describe('decideApproval', () => {
  it('posts the decision, the note and the flag as given', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(`${API}/approvals/:id/decide`, async ({ request }) => {
        bodies.push(await request.json());
        return envelope({
          approval: { id: 'a1', status: 'approved' },
          createdGrantId: null,
          grantSkippedReason: null,
          decidedAfterTimeout: false,
        });
      }),
    );

    await decideApproval('a1', {
      decision: 'approve',
      note: 'looks right',
      alwaysApproveThisClass: true,
    });

    expect(bodies[0]).toEqual({
      decision: 'approve',
      note: 'looks right',
      alwaysApproveThisClass: true,
    });
  });

  it('throws an ApiError carrying the refusal details', async () => {
    server.use(
      http.post(`${API}/approvals/:id/decide`, () =>
        HttpResponse.json(
          {
            statusCode: 403,
            code: 'FORBIDDEN',
            message: 'Nothing was recorded.',
            details: {
              reason: 'trust-grant-required',
              decisionApplied: false,
            },
            timestamp: new Date().toISOString(),
            path: '/api/approvals/a1/decide',
          },
          { status: 403 },
        ),
      ),
    );

    const error = await decideApproval('a1', {
      decision: 'approve',
      alwaysApproveThisClass: true,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiError);
    // The discriminator travels in `details.reason` and NOT in `code`, because
    // the API's exception filter overwrites `code` from the status.
    expect(approvalErrorDetails(error).reason).toBe('trust-grant-required');
    expect(approvalErrorDetails(error).decisionApplied).toBe(false);
  });
});

describe('approvalErrorDetails', () => {
  it('is empty for anything that is not an ApiError with details', () => {
    expect(approvalErrorDetails(new Error('network'))).toEqual({});
    expect(approvalErrorDetails(new ApiError('boom', 500))).toEqual({});
    expect(
      approvalErrorDetails(new ApiError('boom', 409, 'CONFLICT', 'nope')),
    ).toEqual({});
  });
});
