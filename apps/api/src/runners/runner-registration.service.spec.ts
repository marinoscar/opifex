import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service';
import { ClaudeCodeLocalRunner } from './claude-code-local/claude-code-local.runner';
import { RunnerRegistrationService } from './runner-registration.service';
import type { RunnerCapabilities } from './runner.types';

/**
 * Prisma is a double here, and the runner is not.
 *
 * The claim under test is that what lands in the fleet is what the RUNNER said
 * about itself at that moment — so the runner has to be the real one, or the
 * test asserts a fixture agrees with a fixture. Prisma is faked because the
 * database's own behaviour is not what is in question; what gets handed to it
 * is.
 */
describe('RunnerRegistrationService', () => {
  const CAPABILITIES: RunnerCapabilities = {
    key: 'claude-code-local',
    displayName: 'Claude Code (local)',
    version: '2.1.240',
    schemaVersion: '1.0.0',
    invocationModel: 'process',
    executionLocus: 'own_infrastructure',
    streamingFidelity: 'full',
    rateLimitSignal: 'structured',
    stabilityTier: 'experimental',
    reportsCost: true,
    resumable: false,
    maxConcurrency: 2,
    branchPatterns: ['factory/*'],
    manifest: { key: 'claude-code-local', version: '2.1.240' },
  };

  let runnerUpsert: jest.Mock;
  let capabilityUpsert: jest.Mock;
  let prisma: PrismaService;

  function buildPrisma(): PrismaService {
    runnerUpsert = jest.fn().mockResolvedValue({ id: 'runner-uuid', key: 'claude-code-local' });
    capabilityUpsert = jest.fn().mockResolvedValue({});

    const tx = {
      runner: { upsert: runnerUpsert },
      runnerCapability: { upsert: capabilityUpsert },
    };

    return {
      $transaction: jest.fn(async (callback: (t: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaService;
  }

  function build(options: {
    enabled?: boolean;
    capabilities?: Partial<RunnerCapabilities>;
    capabilitiesThrows?: Error;
  } = {}) {
    prisma = buildPrisma();

    const config = {
      get: (key: string) =>
        key === 'runners.claudeCodeLocal.enabled' ? (options.enabled ?? true) : undefined,
    } as unknown as ConfigService;

    const runner = {
      capabilities: jest.fn(async () => {
        if (options.capabilitiesThrows) throw options.capabilitiesThrows;
        return { ...CAPABILITIES, ...options.capabilities };
      }),
    } as unknown as ClaudeCodeLocalRunner;

    return new RunnerRegistrationService(prisma, config, runner);
  }

  describe('what lands in the fleet', () => {
    it('registers the runner under the key everything else joins on', async () => {
      // `Run.runnerKey` is a foreign key onto this, and the `Runner:` commit
      // trailer records it — so the trailer and the database agree only if
      // this is the key the runner itself reports.
      await build().onModuleInit();

      expect(runnerUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { key: 'claude-code-local' } }),
      );
    });

    it('writes the manifest the runner reported, not a constant', async () => {
      // The point of the whole exercise. The version is probed off the
      // installed binary; a registration built from a seed file would put
      // dispatch back to routing real work on facts nobody checked.
      await build().onModuleInit();

      const written = capabilityUpsert.mock.calls[0][0].create;
      expect(written).toMatchObject({
        runnerId: 'runner-uuid',
        schemaVersion: '1.0.0',
        invocationModel: 'process',
        executionLocus: 'own_infrastructure',
        streamingFidelity: 'full',
        rateLimitSignal: 'structured',
        stabilityTier: 'experimental',
        reportsCost: true,
        resumable: false,
        maxConcurrency: 2,
        branchPatterns: ['factory/*'],
      });
    });

    it('keeps the raw manifest alongside the parsed columns', async () => {
      // The schema asks for this explicitly: a field the database does not
      // model yet must not be silently discarded at the boundary.
      await build().onModuleInit();

      expect(capabilityUpsert.mock.calls[0][0].create.manifest).toEqual(CAPABILITIES.manifest);
    });

    it('records the version the runner observed', async () => {
      await build({ capabilities: { version: '3.0.1' } }).onModuleInit();

      expect(runnerUpsert.mock.calls[0][0].update).toMatchObject({ version: '3.0.1' });
    });

    it('writes both rows in one transaction', async () => {
      // They are one fact. A runner row whose capability row failed to write
      // is exactly the state dispatch drops with a warning — the runner would
      // vanish from routing while appearing registered.
      await build().onModuleInit();

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(runnerUpsert).toHaveBeenCalledTimes(1);
      expect(capabilityUpsert).toHaveBeenCalledTimes(1);
    });
  });

  describe('the enabled flag', () => {
    it('enables the runner when the flag is on', async () => {
      await build({ enabled: true }).onModuleInit();
      expect(runnerUpsert.mock.calls[0][0].update).toMatchObject({ enabled: true });
    });

    it('registers but disables the runner when the flag is off', async () => {
      // Registered-and-disabled is not the same as absent: the schema keeps
      // the row so history survives, and "the only runner is disabled" is a
      // far more actionable answer than "no runner is registered".
      await build({ enabled: false }).onModuleInit();

      expect(runnerUpsert).toHaveBeenCalled();
      expect(runnerUpsert.mock.calls[0][0].update).toMatchObject({ enabled: false });
      expect(runnerUpsert.mock.calls[0][0].create).toMatchObject({ enabled: false });
    });

    it('treats anything other than true as off', async () => {
      const config = { get: () => undefined } as unknown as ConfigService;
      const runner = {
        capabilities: jest.fn(async () => CAPABILITIES),
      } as unknown as ClaudeCodeLocalRunner;

      await new RunnerRegistrationService(buildPrisma(), config, runner).onModuleInit();
      expect(runnerUpsert.mock.calls[0][0].update).toMatchObject({ enabled: false });
    });
  });

  describe('re-registration', () => {
    it('upserts rather than inserting, so a second boot is not a second runner', async () => {
      const service = build();
      await service.onModuleInit();
      await service.registerAll();

      expect(runnerUpsert).toHaveBeenCalledTimes(2);
      for (const call of runnerUpsert.mock.calls) {
        expect(call[0].where).toEqual({ key: 'claude-code-local' });
      }
    });

    it('carries a changed capability through on the next boot', async () => {
      // A CLI upgrade that changed what the runner can do must reach the fleet,
      // or dispatch keeps routing on last month's manifest.
      await build({ capabilities: { streamingFidelity: 'partial', maxConcurrency: 4 } })
        .onModuleInit();

      expect(capabilityUpsert.mock.calls[0][0].update).toMatchObject({
        streamingFidelity: 'partial',
        maxConcurrency: 4,
      });
    });
  });

  describe('when things are wrong', () => {
    it('registers zero capacity rather than a plausible-looking lie', async () => {
      // `capabilities()` already reports maxConcurrency 0 for a binary it
      // could not probe. Registration must carry that through untouched:
      // zero headroom is how dispatch says "route nothing here", so a missing
      // CLI becomes a queue with a reason instead of a run that fails after
      // being authorized.
      await build({
        capabilities: { maxConcurrency: 0, version: 'unavailable' },
      }).onModuleInit();

      expect(capabilityUpsert.mock.calls[0][0].create).toMatchObject({ maxConcurrency: 0 });
      expect(runnerUpsert.mock.calls[0][0].update).toMatchObject({ version: 'unavailable' });
    });

    it('leaves the fleet unchanged when a runner cannot describe itself', async () => {
      // Writing a partial row would be worse than writing none: dispatch would
      // route against whatever half of the manifest survived.
      await build({ capabilitiesThrows: new Error('probe exploded') }).onModuleInit();

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('does not stop the API booting when the database write fails', async () => {
      // The reconciler, the watchdog and the escalation path are what VISION
      // §9 relies on to notice things going wrong. Refusing to boot because
      // one runner could not be written down would take all of them out over
      // the least important of them.
      const service = build();
      (prisma.$transaction as jest.Mock).mockRejectedValue(new Error('database is down'));

      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });

    it('does not stop the API booting when capabilities throws', async () => {
      const service = build({ capabilitiesThrows: new Error('probe exploded') });
      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });
  });
});
