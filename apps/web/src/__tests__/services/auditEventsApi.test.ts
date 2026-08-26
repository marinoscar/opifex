import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';

import { server } from '../mocks/server';
import { getAuditEvents } from '../../services/api';

/**
 * The audit-events client (#351, epic #332).
 *
 * What is asserted here is the WIRE CONTRACT: which query parameters reach
 * `GET /api/audit-events`, and that the flat pagination envelope is unwrapped
 * rather than handed on. Both are places a plausible client is silently wrong
 * — a parameter the endpoint does not declare is dropped by zod without a
 * word, so a filter that looks applied would simply return everything.
 */

const API = '*/api';

function page(items: unknown[] = []) {
  return HttpResponse.json({
    data: {
      items,
      total: items.length,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    },
    meta: { timestamp: new Date().toISOString() },
  });
}

describe('getAuditEvents', () => {
  it('sends nothing at all when nothing was asked for', async () => {
    const urls: string[] = [];
    server.use(
      http.get(`${API}/audit-events`, ({ request }) => {
        urls.push(new URL(request.url).search);
        return page();
      }),
    );

    await getAuditEvents();

    // The endpoint's own defaults — page 1, 20 rows, newest first — are the
    // server's to apply. Restating them here would freeze today's defaults
    // into the client.
    expect(urls[0]).toBe('');
  });

  it('sends only the parameters the endpoint declares', async () => {
    const urls: string[] = [];
    server.use(
      http.get(`${API}/audit-events`, ({ request }) => {
        urls.push(new URL(request.url).search);
        return page();
      }),
    );

    await getAuditEvents({
      page: 3,
      pageSize: 50,
      targetType: 'operator_settings',
      targetId: 'github.token',
      action: 'operator_settings:set',
      actorUserId: '00000000-0000-4000-8000-000000000001',
      since: '2026-08-01T00:00:00.000Z',
      until: '2026-08-26T00:00:00.000Z',
      sortOrder: 'asc',
    });

    const search = urls[0];
    for (const expected of [
      'page=3',
      'pageSize=50',
      'targetType=operator_settings',
      'targetId=github.token',
      'action=operator_settings%3Aset',
      'actorUserId=00000000-0000-4000-8000-000000000001',
      'since=2026-08-01T00%3A00%3A00.000Z',
      'until=2026-08-26T00%3A00%3A00.000Z',
      'sortOrder=asc',
    ]) {
      expect(search, expected).toContain(expected);
    }
  });

  it('unwraps the envelope and keeps the pagination the pager needs', async () => {
    server.use(
      http.get(`${API}/audit-events`, () =>
        HttpResponse.json({
          data: {
            items: [{ id: 'e1' }],
            total: 42,
            page: 2,
            pageSize: 20,
            totalPages: 3,
          },
          meta: { timestamp: new Date().toISOString() },
        }),
      ),
    );

    // Unlike the dashboard panels, which unwrap to a bare array, a paged
    // section genuinely needs `total` — it is what the pager counts.
    await expect(getAuditEvents({ page: 2 })).resolves.toMatchObject({
      total: 42,
      page: 2,
      totalPages: 3,
    });
  });
});
