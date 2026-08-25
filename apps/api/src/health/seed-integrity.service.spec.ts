import { Logger } from '@nestjs/common';

import { PERMISSIONS } from '../common/constants/roles.constants';
import { PrismaService } from '../prisma/prisma.service';
import {
  EXPECTED_PERMISSIONS,
  hasSeedDrift,
  SeedIntegrityService,
} from './seed-integrity.service';

/**
 * Exposes the protected TTL so cache behaviour is asserted directly instead of
 * with fake timers, matching the `connectRetryDelaysMs` handling in
 * prisma.service.spec.ts.
 */
class TestSeedIntegrityService extends SeedIntegrityService {
  setTtl(ms: number): void {
    this.checkTtlMs = ms;
  }
}

describe('SeedIntegrityService', () => {
  let findMany: jest.Mock;
  let service: TestSeedIntegrityService;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  /** Rows as the table would return them for a given permission set. */
  const rows = (names: readonly string[]) => names.map((name) => ({ name }));

  beforeEach(() => {
    findMany = jest.fn();
    // Only `permission.findMany` is doubled: it is the entire database surface
    // this service touches, and a narrower double makes an accidental second
    // query fail loudly rather than pass silently.
    const prisma = { permission: { findMany } } as unknown as PrismaService;

    service = new TestSeedIntegrityService(prisma);
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('EXPECTED_PERMISSIONS', () => {
    it('covers every permission the application enforces', () => {
      // Derived, not restated: a permission added to the constant must be
      // checked by the same commit that adds it.
      expect([...EXPECTED_PERMISSIONS].sort()).toEqual(
        [...new Set(Object.values(PERMISSIONS))].sort(),
      );
    });
  });

  describe('check', () => {
    it('flags nothing when the database carries every permission', async () => {
      findMany.mockResolvedValue(rows(EXPECTED_PERMISSIONS));

      const report = await service.check();

      expect(report).toMatchObject({
        checked: true,
        expected: EXPECTED_PERMISSIONS.length,
        missing: [],
        unexpected: [],
      });
      expect(hasSeedDrift(report)).toBe(false);
    });

    it('detects a permission that was never seeded', async () => {
      // The exact shape of #173: rows exist, the table is healthy, and one
      // string the code enforces has nothing behind it.
      const seeded = EXPECTED_PERMISSIONS.filter(
        (name) => name !== PERMISSIONS.RUNS_READ,
      );
      findMany.mockResolvedValue(rows(seeded));

      const report = await service.check();

      expect(report.checked).toBe(true);
      expect(hasSeedDrift(report)).toBe(true);
      if (report.checked) {
        expect(report.missing).toEqual([PERMISSIONS.RUNS_READ]);
        expect(report.unexpected).toEqual([]);
      }
    });

    it('detects a whole group of permissions that never reached the database', async () => {
      const cockpit: string[] = [
        PERMISSIONS.PROJECTS_READ,
        PERMISSIONS.PROJECTS_WRITE,
        PERMISSIONS.RUNS_READ,
        PERMISSIONS.RUNS_CANCEL,
        PERMISSIONS.RUNS_WRITE,
        PERMISSIONS.WORKORDERS_READ,
        PERMISSIONS.WORKORDERS_WRITE,
      ];
      findMany.mockResolvedValue(
        rows(EXPECTED_PERMISSIONS.filter((name) => !cockpit.includes(name))),
      );

      const report = await service.check();

      if (!report.checked) {
        throw new Error('expected a completed check');
      }
      expect(report.missing.sort()).toEqual([...cockpit].sort());
    });

    it('reports an unknown row without calling it drift', async () => {
      // A permission retired from the code keeps its row: the seed is
      // deliberately non-destructive. Reported so a rollback is diagnosable,
      // never failed on, because nothing checks the string.
      findMany.mockResolvedValue(
        rows([...EXPECTED_PERMISSIONS, 'legacy:retired']),
      );

      const report = await service.check();

      expect(hasSeedDrift(report)).toBe(false);
      if (report.checked) {
        expect(report.missing).toEqual([]);
        expect(report.unexpected).toEqual(['legacy:retired']);
      }
    });

    it('does not claim drift when the table cannot be read', async () => {
      // An unreachable database must not be reported as an empty permission
      // set: that would invent a second failure out of one fact.
      findMany.mockRejectedValue(
        new Error("Can't reach database server at 127.0.0.1:5432"),
      );

      const report = await service.check();

      expect(report.checked).toBe(false);
      expect(hasSeedDrift(report)).toBe(false);
      if (!report.checked) {
        expect(report.error).toContain("Can't reach database server");
      }
    });

    it('bounds the cost by reusing a fresh result', async () => {
      findMany.mockResolvedValue(rows(EXPECTED_PERMISSIONS));

      await service.check();
      await service.check();
      await service.check();

      expect(findMany).toHaveBeenCalledTimes(1);
    });

    it('asks the database again once the result is stale', async () => {
      service.setTtl(0);
      findMany.mockResolvedValue(rows(EXPECTED_PERMISSIONS));

      await service.check();
      await service.check();

      expect(findMany).toHaveBeenCalledTimes(2);
    });

    it('does not cache a failed check', async () => {
      findMany.mockRejectedValueOnce(new Error('connection refused'));
      findMany.mockResolvedValue(rows(EXPECTED_PERMISSIONS));

      const failed = await service.check();
      const recovered = await service.check();

      expect(failed.checked).toBe(false);
      expect(recovered.checked).toBe(true);
      expect(findMany).toHaveBeenCalledTimes(2);
    });
  });

  describe('onApplicationBootstrap', () => {
    it('reports missing permissions at error level, naming them and the fix', async () => {
      findMany.mockResolvedValue(
        rows(
          EXPECTED_PERMISSIONS.filter(
            (name) => name !== PERMISSIONS.WORKORDERS_READ,
          ),
        ),
      );

      await service.onApplicationBootstrap();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const message = String(errorSpy.mock.calls[0][0]);
      expect(message).toContain(PERMISSIONS.WORKORDERS_READ);
      expect(message).toContain('prisma:seed');
      expect(message).toContain('403');
    });

    it('confirms a fully seeded database instead of staying silent', async () => {
      findMany.mockResolvedValue(rows(EXPECTED_PERMISSIONS));

      await service.onApplicationBootstrap();

      expect(errorSpy).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `all ${EXPECTED_PERMISSIONS.length} permissions present`,
        ),
      );
    });

    it('does not raise an error over rows the build no longer uses', async () => {
      findMany.mockResolvedValue(
        rows([...EXPECTED_PERMISSIONS, 'legacy:retired']),
      );

      await service.onApplicationBootstrap();

      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('legacy:retired'),
      );
    });

    it('warns quietly when the database could not be read, leaving the alarm to PrismaService', async () => {
      findMany.mockRejectedValue(new Error('connection refused'));

      await service.onApplicationBootstrap();

      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('connection refused'),
      );
    });

    it('never throws, so an unseeded database still boots', async () => {
      findMany.mockResolvedValue(rows([]));

      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    });
  });
});
