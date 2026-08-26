/**
 * `GET /api/cost/summary`, in the API's real shape (#349, epic #332).
 *
 * The Credentials section reads this endpoint for ONE thing: `ceiling`, which
 * is the only place the API publishes spend measured over the ceiling's own
 * window. `apps/api/src/cockpit/cost.service.ts` tallies `ceiling.spend` over
 * `ceiling.windowDays` regardless of the `days` the request asked for, and the
 * fixture reproduces that rather than making the two agree by coincidence —
 * a fixture where every window is 30 could not tell a correct reading from one
 * that used the request's window by mistake.
 *
 * `totalUsd` is null-able and `reportedUsd`/`estimatedUsd` are never summed by
 * the API; both distinctions are the cost read model's and are carried here so
 * a component cannot be written against a shape that flattens them.
 */

import type { CostSummary } from '../../types/cockpit';

export function costSummaryFixture(
  overrides: Partial<CostSummary> = {},
): CostSummary {
  return {
    generatedAt: '2026-08-20T12:00:00.000Z',
    window: {
      from: '2026-07-21T12:00:00.000Z',
      to: '2026-08-20T12:00:00.000Z',
    },
    totalUsd: 12.5,
    runs: 9,
    runsWithoutCost: 1,
    byRepository: [],
    byDay: [],
    quota: null,
    ceiling: {
      limitUsd: 25,
      // The ceiling's own window, which the request's `days` does not change.
      windowDays: 30,
      malformed: null,
      spend: {
        reportedUsd: 11,
        estimatedUsd: 1.5,
        totalUsd: 12.5,
        runsWithoutCost: 1,
        unboundedRuns: 0,
      },
      headroomUsd: 12.5,
    },
    ...overrides,
  };
}
