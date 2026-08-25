import { HealthCheckError } from '@nestjs/terminus';

import type {
  FleetReport,
  FleetStateService,
} from '../../runners/fleet-state.service';
import { FleetIndicator } from './fleet.indicator';

describe('FleetIndicator', () => {
  let check: jest.Mock<Promise<FleetReport>, []>;
  let indicator: FleetIndicator;

  const CHECKED_AT = new Date('2026-08-25T00:00:00.000Z');

  const routableRunner: FleetReport = {
    checked: true,
    checkedAt: CHECKED_AT,
    registered: 1,
    routable: 1,
    enabled: 1,
    dispatchable: 1,
    unroutable: [],
    runners: [
      {
        key: 'claude-code-local',
        displayName: 'Claude Code (local)',
        version: '2.0.1',
        enabled: true,
        available: true,
        unavailableReason: null,
        maxConcurrency: 2,
      },
    ],
  };

  const emptyFleet: FleetReport = {
    checked: true,
    checkedAt: CHECKED_AT,
    registered: 0,
    routable: 0,
    enabled: 0,
    dispatchable: 0,
    unroutable: [],
    runners: [],
  };

  const allDisabled: FleetReport = {
    ...routableRunner,
    enabled: 0,
    dispatchable: 0,
    runners: [{ ...routableRunner.runners[0], enabled: false }],
  };

  const unreadable: FleetReport = {
    checked: false,
    checkedAt: CHECKED_AT,
    error: 'connection refused',
  };

  beforeEach(() => {
    check = jest.fn();
    // Only `check` is doubled, following `SeedIntegrityIndicator`'s spec —
    // the query and the tick counting behind it are `FleetStateService`'s own
    // concern and are covered in fleet-state.service.spec.ts.
    indicator = new FleetIndicator({ check } as unknown as FleetStateService);
  });

  describe('report (readiness)', () => {
    it('stays up on a routable fleet', async () => {
      check.mockResolvedValue(routableRunner);

      const result = await indicator.report('fleet');

      expect(result.fleet).toMatchObject({
        status: 'up',
        checked: true,
        registered: 1,
        routable: 1,
      });
    });

    it('never throws on an empty fleet — readiness must stay up', async () => {
      check.mockResolvedValue(emptyFleet);

      await expect(indicator.report('fleet')).resolves.toMatchObject({
        fleet: { status: 'up', routable: 0 },
      });
    });

    it('stays up, unconditionally, whatever the finding', async () => {
      check.mockResolvedValue(unreadable);

      const result = await indicator.report('fleet');

      expect(result.fleet).toMatchObject({
        status: 'up',
        checked: false,
        message: expect.stringContaining('connection refused'),
      });
    });
  });

  describe('isHealthy (full check)', () => {
    it('passes a routable fleet', async () => {
      check.mockResolvedValue(routableRunner);

      const result = await indicator.isHealthy('fleet');

      expect(result.fleet.status).toBe('up');
    });

    it('throws on an empty fleet', async () => {
      check.mockResolvedValue(emptyFleet);

      await expect(indicator.isHealthy('fleet')).rejects.toThrow(
        HealthCheckError,
      );
    });

    it('names the fleet state in the failure, so the 503 is actionable', async () => {
      check.mockResolvedValue(emptyFleet);

      try {
        await indicator.isHealthy('fleet');
        fail('Should have thrown HealthCheckError');
      } catch (e) {
        const error = e as HealthCheckError;
        expect(error.causes.fleet).toMatchObject({
          status: 'down',
          registered: 0,
          routable: 0,
        });
      }
    });

    it('passes a fleet that is entirely disabled — an operator choice, not a fault', async () => {
      // `enabled: false` is a human's own decision and its row is present, so
      // the fleet is not empty. Failing a health check over it would report a
      // deliberate choice back as a fault, which is the fastest way to teach
      // an operator the check is noise.
      check.mockResolvedValue(allDisabled);

      const result = await indicator.isHealthy('fleet');

      expect(result.fleet.status).toBe('up');
      expect(result.fleet.enabled).toBe(0);
    });

    it('does not throw on checked: false, leaving that outage to the database indicator', async () => {
      // The database indicator running beside this one has already failed
      // for the same outage; a second red entry would make one fault look
      // like two.
      check.mockResolvedValue(unreadable);

      const result = await indicator.isHealthy('fleet');

      expect(result.fleet.status).toBe('up');
      expect(result.fleet.checked).toBe(false);
    });
  });
});
