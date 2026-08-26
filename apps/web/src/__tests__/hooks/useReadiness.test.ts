/**
 * `useReadiness` (#347, epic #332).
 *
 * The hook's whole job is to keep two independent reads independent. The cases
 * below are the ones where a `Promise.all` would have quietly lost half the
 * screen: readiness red while the repository list is fine, a repository 403
 * while the fleet is fine, and a readiness payload whose fleet entry is only
 * in `details` because the check went red.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../mocks/server';
import { useReadiness } from '../../hooks/useReadiness';

const API_BASE = '*/api';

function stepOf(
  result: { current: ReturnType<typeof useReadiness> },
  id: string,
) {
  const found = result.current.steps.find((step) => step.id === id);
  if (!found) throw new Error(`no step ${id}`);
  return found;
}

describe('useReadiness', () => {
  it('builds the chain from the default fixtures', async () => {
    const { result } = renderHook(() => useReadiness());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.steps).toHaveLength(5);
    expect(result.current.lastUpdatedAt).toBeInstanceOf(Date);
  });

  it('keeps the fleet visible when the repository read is forbidden', async () => {
    server.use(
      http.get(`${API_BASE}/repositories`, () =>
        HttpResponse.json({ message: 'Forbidden' }, { status: 403 }),
      ),
    );

    const { result } = renderHook(() => useReadiness());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // The half that succeeded is still on screen. A `Promise.all` here would
    // have blanked the fleet over a permission the fleet does not need.
    expect(stepOf(result, 'binaries').verdict).toBe('pass');
    expect(stepOf(result, 'repository').verdict).toBe('unknown');
    expect(stepOf(result, 'repository').detail).toContain('projects:read');
  });

  it('keeps the repository count when readiness itself is red', async () => {
    server.use(
      http.get(`${API_BASE}/health/ready`, () =>
        HttpResponse.json({ message: 'Service Unavailable' }, { status: 503 }),
      ),
      http.get(`${API_BASE}/repositories`, ({ request }) => {
        const url = new URL(request.url);
        const total =
          url.searchParams.get('dispatchEnabled') === 'true' ? 2 : 3;
        return HttpResponse.json({
          data: { items: [], total, page: 1, pageSize: 1 },
        });
      }),
    );

    const { result } = renderHook(() => useReadiness());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(stepOf(result, 'binaries').verdict).toBe('unknown');
    expect(stepOf(result, 'binaries').detail).toContain('503');
    expect(stepOf(result, 'repository').verdict).toBe('pass');
    expect(stepOf(result, 'repository').configured?.statement).toBe(
      '2 of 3 registered',
    );
  });

  it('reads the fleet out of details when info does not carry it', async () => {
    // A red readiness moves the failing indicators out of `info`. Reading only
    // `info` would blank the fleet on the one screen it is needed most.
    server.use(
      http.get(`${API_BASE}/health/ready`, () =>
        HttpResponse.json({
          data: {
            status: 'error',
            info: {},
            error: { database: { status: 'down' } },
            details: {
              database: { status: 'down' },
              fleet: {
                status: 'up',
                checked: true,
                registered: 1,
                routable: 1,
                enabled: 1,
                dispatchable: 1,
                runners: [
                  {
                    key: 'claude-code-local',
                    version: '2.1.246',
                    enabled: true,
                    available: true,
                    maxConcurrency: 2,
                  },
                ],
              },
            },
          },
        }),
      ),
    );

    const { result } = renderHook(() => useReadiness());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(stepOf(result, 'runner').verdict).toBe('pass');
  });

  it('says so when the payload carries no fleet entry at all', async () => {
    server.use(
      http.get(`${API_BASE}/health/ready`, () =>
        HttpResponse.json({
          data: { status: 'ok', info: { database: { status: 'up' } } },
        }),
      ),
    );

    const { result } = renderHook(() => useReadiness());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(stepOf(result, 'runner').verdict).toBe('unknown');
    expect(stepOf(result, 'runner').detail).toContain('fleet');
  });

  it('counts the verdicts rather than concluding readiness', async () => {
    const { result } = renderHook(() => useReadiness());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const { summary } = result.current;
    expect(summary.total).toBe(5);
    expect(
      summary.pass + summary.blocked + summary.unverifiable + summary.unknown,
    ).toBe(5);
    // Two steps have no probe behind them, always.
    expect(summary.unverifiable).toBe(2);
  });
});
