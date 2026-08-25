import { HealthCheckError } from '@nestjs/terminus';

import {
  SeedIntegrityService,
  type SeedIntegrityReport,
} from '../seed-integrity.service';
import { SeedIntegrityIndicator } from './seed-integrity.indicator';

describe('SeedIntegrityIndicator', () => {
  let check: jest.Mock<Promise<SeedIntegrityReport>, []>;
  let indicator: SeedIntegrityIndicator;

  const seeded: SeedIntegrityReport = {
    checked: true,
    checkedAt: new Date('2026-08-25T00:00:00.000Z'),
    expected: 29,
    missing: [],
    unexpected: [],
  };

  const drifted: SeedIntegrityReport = {
    ...seeded,
    missing: ['runs:read', 'workorders:read'],
  };

  beforeEach(() => {
    check = jest.fn();
    // Only `check` is doubled — the query and the cache behind it are the
    // service's own concern and are covered in seed-integrity.service.spec.ts.
    indicator = new SeedIntegrityIndicator({
      check,
    } as unknown as SeedIntegrityService);
  });

  describe('report (readiness)', () => {
    it('stays up on a fully seeded database', async () => {
      check.mockResolvedValue(seeded);

      const result = await indicator.report('seed');

      expect(result.seed).toMatchObject({
        status: 'up',
        checked: true,
        expected: 29,
        missing: 0,
      });
    });

    it('stays up when permissions are missing, so drift cannot pull the API out of service', async () => {
      check.mockResolvedValue(drifted);

      const result = await indicator.report('seed');

      // The whole readiness decision: still routable, and no longer silent.
      expect(result.seed.status).toBe('up');
      expect(result.seed.missing).toBe(2);
      expect(result.seed.missingPermissions).toEqual([
        'runs:read',
        'workorders:read',
      ]);
      expect(result.seed.message).toContain('prisma:seed');
    });

    it('says so when the table could not be read', async () => {
      check.mockResolvedValue({
        checked: false,
        checkedAt: new Date(),
        error: 'connection refused',
      });

      const result = await indicator.report('seed');

      expect(result.seed).toMatchObject({
        status: 'up',
        checked: false,
        message: expect.stringContaining('connection refused'),
      });
    });
  });

  describe('isHealthy (full check)', () => {
    it('passes a fully seeded database', async () => {
      check.mockResolvedValue(seeded);

      const result = await indicator.isHealthy('seed');

      expect(result.seed.status).toBe('up');
    });

    it('fails when a permission this build enforces has no row behind it', async () => {
      check.mockResolvedValue(drifted);

      await expect(indicator.isHealthy('seed')).rejects.toThrow(
        HealthCheckError,
      );
    });

    it('names the missing permissions in the failure, so the 503 is actionable', async () => {
      check.mockResolvedValue(drifted);

      try {
        await indicator.isHealthy('seed');
        fail('Should have thrown HealthCheckError');
      } catch (e) {
        const error = e as HealthCheckError;
        expect(error.causes.seed).toMatchObject({
          status: 'down',
          missing: 2,
          missingPermissions: ['runs:read', 'workorders:read'],
        });
        expect(error.causes.seed.message).toContain('prisma:seed');
      }
    });

    it('passes rows the build no longer uses, reporting them alongside', async () => {
      check.mockResolvedValue({ ...seeded, unexpected: ['legacy:retired'] });

      const result = await indicator.isHealthy('seed');

      expect(result.seed.status).toBe('up');
      expect(result.seed.unexpectedPermissions).toEqual(['legacy:retired']);
    });

    it('does not fail on an unreadable table, leaving that to the database indicator', async () => {
      check.mockResolvedValue({
        checked: false,
        checkedAt: new Date(),
        error: 'connection refused',
      });

      const result = await indicator.isHealthy('seed');

      // One outage, one red entry — the database indicator's.
      expect(result.seed.status).toBe('up');
      expect(result.seed.checked).toBe(false);
    });
  });
});
