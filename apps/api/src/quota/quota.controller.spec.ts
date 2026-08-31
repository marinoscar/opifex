import { Reflector } from '@nestjs/core';

import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { quotaSummarySchema } from './dto/quota.dto';
import { QuotaController } from './quota.controller';
import type { QuotaHistoryService } from './quota-history.service';
import type { QuotaRunnerReading, QuotaService } from './quota.service';

/**
 * Nothing anywhere else calls `GET /api/quota` through Nest — every other
 * assertion about this endpoint's shape is really an assertion about
 * `QuotaService.readings()`. This is the one file that checks what the
 * controller itself contributes: the permission gate, and that the response
 * envelope (`generatedAt` + `runners`) is what `quotaSummarySchema` — the
 * contract in `quota.dto.ts` — actually accepts.
 */
describe('QuotaController', () => {
  function reading(
    overrides: Partial<QuotaRunnerReading> = {},
  ): QuotaRunnerReading {
    return {
      runnerKey: 'claude-code-local',
      position: {
        exhausted: false,
        resumesAt: '2026-08-25T15:00:00.000Z',
        basis:
          'runner reported rate-limit status "allowed" for its five_hour window',
      },
      windows: [
        {
          windowKind: 'five_hour',
          resetsAt: '2026-08-25T15:00:00.000Z',
          startedAt: '2026-08-25T10:00:00.000Z',
          startedAtBasis: 'vendor-window-length',
          partialWindow: false,
          pressure: 'allowed',
          peakPressure: 'warning',
          lastObservedAt: '2026-08-25T11:55:00.000Z',
          observations: 12,
          opifexConsumption: {
            runs: 4,
            runsWithoutCost: 1,
            reportedUsd: 4.25,
            tokensInput: 1000,
            tokensOutput: 250,
          },
          burnFraction: null,
          basis: 'Opifex’s own runs against the vendor’s "five_hour" window.',
        },
      ],
      ...overrides,
    };
  }

  function build(readings: QuotaRunnerReading[] = []) {
    const quota = {
      readings: jest.fn().mockResolvedValue(readings),
    };
    // #476 added two history endpoints to this controller. They are covered
    // by their own specs; this stub exists only so the constructor is
    // satisfiable, and its methods must never be reached by the cases below.
    const history = {
      episodes: jest.fn(),
      exhaustedWindows: jest.fn(),
    };
    const controller = new QuotaController(
      quota as unknown as QuotaService,
      history as unknown as QuotaHistoryService,
    );
    return { controller, quota, history };
  }

  it('gates the endpoint on runs:read', () => {
    // `runs:read` because the figures returned are sums over run events — the
    // same argument `CostController` makes for its own summary. A change that
    // widens this to a weaker gate lets a caller total runs it cannot open.
    const required =
      new Reflector().get<string[]>(
        PERMISSIONS_KEY,
        QuotaController.prototype.summary,
      ) ?? [];

    expect(required).toEqual([PERMISSIONS.RUNS_READ]);
  });

  it('wraps the service reading in a summary the DTO schema actually accepts', async () => {
    const { controller } = build([reading()]);

    const summary = await controller.summary();

    // Round-trips through the real contract, not just a shape assertion —
    // this is what would refuse a `position` missing `resumesAt` or a
    // `windows` entry carrying a non-null `burnFraction` reaching a client.
    expect(() => quotaSummarySchema.parse(summary)).not.toThrow();
    expect(summary.runners).toEqual([reading()]);
  });

  it('stamps generatedAt with the SAME instant it asks the service to read at', async () => {
    // Two separate `new Date()` calls a millisecond apart would let
    // `generatedAt` describe an instant slightly later than the data it
    // labels — a small but real lie about when the numbers are as of.
    const { controller, quota } = build([]);

    const summary = await controller.summary();

    const askedAt = quota.readings.mock.calls[0]![0] as Date;
    expect(summary.generatedAt).toBe(askedAt.toISOString());
  });

  it('reports an empty fleet as an empty list, not an error', async () => {
    // #231's last acceptance criterion, exercised at the controller: a fleet
    // reporting no quota signal at all is a valid, empty response.
    const { controller } = build([]);

    const summary = await controller.summary();

    expect(summary.runners).toEqual([]);
    expect(() => quotaSummarySchema.parse(summary)).not.toThrow();
  });

  it('carries a null position through untouched — UNKNOWN, never coerced to healthy', async () => {
    const { controller } = build([reading({ position: null })]);

    const summary = await controller.summary();

    expect(summary.runners[0]!.position).toBeNull();
    expect(() => quotaSummarySchema.parse(summary)).not.toThrow();
  });
});
