import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ContractValidator } from '../contracts/contract-validator';
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
  /**
   * The declared fields, with no manifest beside them.
   *
   * The real runner has no second copy either: `capabilities()` builds its
   * manifest FROM the declared fields, `{ manifest: _ignored, ...declared }`,
   * precisely so the two cannot drift. A fixture that kept its own hand-written
   * manifest reproduced the drift the runner was written to avoid.
   */
  const DECLARED: Omit<RunnerCapabilities, 'manifest'> = {
    key: 'claude-code-local',
    displayName: 'Claude Code (local)',
    version: '2.1.240',
    schemaVersion: '1.3.0',
    invocationModel: 'process',
    executionLocus: 'own_infrastructure',
    streamingFidelity: 'full',
    rateLimitSignal: 'structured',
    stabilityTier: 'experimental',
    reportsCost: true,
    resumable: false,
    maxConcurrency: 2,
    branchPatterns: ['factory/*'],
  };

  /**
   * Capabilities the way the real runner publishes them — manifest DERIVED.
   *
   * This is not tidying, it is the bug (#253). The fixture used to carry an
   * independently written `manifest` and `build()` merged it shallowly, so a
   * test overriding `maxConcurrency: 0` moved the typed field and left the
   * manifest saying 2. Validation reads the manifest. The zero-capacity test
   * below was therefore green against a document the real runner never
   * produces, which is exactly why nobody noticed the schema forbade zero.
   *
   * An explicit `manifest` override is still honoured, because it is the only
   * way to express the case the boundary check exists for: a runner whose
   * PUBLISHED document disagrees with the schema. Everything else derives.
   */
  function capabilitiesOf(
    overrides: Partial<RunnerCapabilities> = {},
  ): RunnerCapabilities {
    const { manifest, ...declared } = overrides;
    const capabilities: RunnerCapabilities = {
      ...DECLARED,
      ...declared,
      manifest: {},
    };
    const { manifest: _ignored, ...published } = capabilities;
    capabilities.manifest = manifest ?? { ...published };
    return capabilities;
  }

  const CAPABILITIES = capabilitiesOf();

  /**
   * The real validator, not a double.
   *
   * It is stateless and reads the schema off disk, so using the real one means
   * these tests exercise the actual contract rather than a stub that agrees
   * with whatever they pass it.
   */
  const contracts = new ContractValidator();

  let runnerUpsert: jest.Mock;
  let capabilityUpsert: jest.Mock;
  let prisma: PrismaService;

  function buildPrisma(): PrismaService {
    runnerUpsert = jest
      .fn()
      .mockResolvedValue({ id: 'runner-uuid', key: 'claude-code-local' });
    capabilityUpsert = jest.fn().mockResolvedValue({});

    const tx = {
      runner: { upsert: runnerUpsert },
      runnerCapability: { upsert: capabilityUpsert },
    };

    return {
      $transaction: jest.fn(async (callback: (t: typeof tx) => unknown) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
  }

  function build(
    options: {
      enabled?: boolean;
      capabilities?: Partial<RunnerCapabilities>;
      capabilitiesThrows?: Error;
    } = {},
  ) {
    prisma = buildPrisma();

    const config = {
      get: (key: string) =>
        key === 'runners.claudeCodeLocal.enabled'
          ? (options.enabled ?? true)
          : undefined,
    } as unknown as ConfigService;

    const runner = {
      capabilities: jest.fn(async () => {
        if (options.capabilitiesThrows) throw options.capabilitiesThrows;
        // Built through the same derivation the runner uses, so an override
        // reaches the published document as well as the typed field. A shallow
        // merge here is what made the zero-capacity test meaningless.
        return capabilitiesOf(options.capabilities);
      }),
    } as unknown as ClaudeCodeLocalRunner;

    return new RunnerRegistrationService(prisma, config, runner, contracts);
  }

  describe('the double publishes what it declares', () => {
    it('derives the manifest from the fields, the way the runner does', () => {
      // A test about a fixture, which is unusual and is here for a reason: the
      // fixture drifting from the runner is what hid #253 for the life of the
      // file. If this ever fails, every assertion below is about a document
      // nothing in production would send.
      expect(capabilitiesOf({ available: false }).manifest).toMatchObject({
        available: false,
      });
      expect(capabilitiesOf({ version: '9.9.9' }).manifest).toMatchObject({
        version: '9.9.9',
      });
      expect(CAPABILITIES.manifest).toMatchObject({ maxConcurrency: 2 });
    });
  });

  describe('the schema boundary (#35)', () => {
    it('keeps a runner out of the fleet when its manifest does not validate', async () => {
      // The failure this prevents is not a parse error. The schema says an
      // overstated manifest produces "a control plane that trusts signal it is
      // not actually receiving" — dispatch routing real work on a declaration
      // nobody checked. Refusing to register is the honest outcome: the runner
      // is absent from routing rather than present with a wrong shape.
      const service = build({
        capabilities: {
          manifest: {
            ...CAPABILITIES.manifest,
            streamingFidelity: 'excellent',
          },
        },
      });

      await service.onModuleInit();

      expect(runnerUpsert).not.toHaveBeenCalled();
      expect(capabilityUpsert).not.toHaveBeenCalled();
    });

    it('names the offending field, so the runner author can fix it', async () => {
      // #35: "validation failures produce an error naming the offending field
      // and why". A log line saying only "invalid manifest" makes the next
      // person read the schema and guess.
      const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation();

      await build({
        capabilities: {
          manifest: { ...CAPABILITIES.manifest, maxConcurrency: -1 },
        },
      }).onModuleInit();

      const logged = errors.mock.calls
        .map((call) => String(call[0]))
        .join('\n');
      expect(logged).toContain('maxConcurrency');
      expect(logged).toContain('runner-capability.schema.json');
      // And the boundary held. Zero became expressible in schema 1.3.0 (#253);
      // a negative count did not, and a manifest that is malformed for a real
      // reason must still keep its runner out of the fleet rather than in it
      // with a shape dispatch would act on.
      expect(runnerUpsert).not.toHaveBeenCalled();
      expect(capabilityUpsert).not.toHaveBeenCalled();
      errors.mockRestore();
    });

    it('registers when the manifest is the one the real runner publishes', async () => {
      await build().onModuleInit();
      expect(runnerUpsert).toHaveBeenCalled();
    });
  });

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
        schemaVersion: '1.3.0',
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

      expect(capabilityUpsert.mock.calls[0][0].create.manifest).toEqual(
        CAPABILITIES.manifest,
      );
    });

    it('records the version the runner observed', async () => {
      await build({ capabilities: { version: '3.0.1' } }).onModuleInit();

      expect(runnerUpsert.mock.calls[0][0].update).toMatchObject({
        version: '3.0.1',
      });
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
      expect(runnerUpsert.mock.calls[0][0].update).toMatchObject({
        enabled: true,
      });
    });

    it('registers but disables the runner when the flag is off', async () => {
      // Registered-and-disabled is not the same as absent: the schema keeps
      // the row so history survives, and "the only runner is disabled" is a
      // far more actionable answer than "no runner is registered".
      await build({ enabled: false }).onModuleInit();

      expect(runnerUpsert).toHaveBeenCalled();
      expect(runnerUpsert.mock.calls[0][0].update).toMatchObject({
        enabled: false,
      });
      expect(runnerUpsert.mock.calls[0][0].create).toMatchObject({
        enabled: false,
      });
    });

    it('treats anything other than true as off', async () => {
      const config = { get: () => undefined } as unknown as ConfigService;
      const runner = {
        capabilities: jest.fn(async () => CAPABILITIES),
      } as unknown as ClaudeCodeLocalRunner;

      await new RunnerRegistrationService(
        buildPrisma(),
        config,
        runner,
        contracts,
      ).onModuleInit();
      expect(runnerUpsert.mock.calls[0][0].update).toMatchObject({
        enabled: false,
      });
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
      await build({
        capabilities: { streamingFidelity: 'partial', maxConcurrency: 4 },
      }).onModuleInit();

      expect(capabilityUpsert.mock.calls[0][0].update).toMatchObject({
        streamingFidelity: 'partial',
        maxConcurrency: 4,
      });
    });
  });

  describe('when things are wrong', () => {
    it('registers an unavailable runner rather than leaving the fleet empty', async () => {
      // `capabilities()` reports `available: false` for a binary it could not
      // probe. Registration must carry that through untouched: the runner is
      // in the fleet, dispatch can see WHY it is not routing there, and the
      // operator reads a missing CLI instead of "no runners are registered".
      //
      // This test was green for years against a document the real runner never
      // produces (#253): the fixture merged shallowly, so an override moved
      // the typed field and left the published manifest untouched, and the
      // schema — which rejected the old `maxConcurrency: 0` spelling — never
      // had to have an opinion. It does now.
      await build({
        capabilities: {
          available: false,
          unavailableReason: '`claude --version` could not be probed',
          version: 'unavailable',
        },
      }).onModuleInit();

      expect(runnerUpsert).toHaveBeenCalled();
      expect(capabilityUpsert.mock.calls[0][0].create.manifest).toMatchObject({
        available: false,
        unavailableReason: '`claude --version` could not be probed',
      });
      // Capacity is untouched: the slots exist, they are momentarily unusable.
      expect(capabilityUpsert.mock.calls[0][0].create).toMatchObject({
        maxConcurrency: 2,
      });
      expect(runnerUpsert.mock.calls[0][0].update).toMatchObject({
        version: 'unavailable',
      });
    });

    it('keeps out a runner that says it cannot work and will not say why', async () => {
      // The schema requires a reason with `available: false`, and this is the
      // boundary holding rather than the fix widening it: an unavailable
      // runner with no stated reason leaves the operator exactly as stuck as
      // one that said nothing at all.
      await build({
        capabilities: { available: false },
      }).onModuleInit();

      expect(runnerUpsert).not.toHaveBeenCalled();
    });

    it('says the binary is the problem, not the enabled flag', async () => {
      // The symptom of both is identical — work orders queueing forever — so
      // the log line is the only place the difference is available, and an
      // operator who reads "disabled" goes looking for who turned it off.
      const warnings = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation();

      await build({
        enabled: true,
        capabilities: {
          available: false,
          unavailableReason: 'the CLI is not on this PATH',
          version: 'unavailable',
        },
      }).onModuleInit();

      const logged = warnings.mock.calls.map((call) => String(call[0]));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain('UNAVAILABLE');
      expect(logged[0]).toContain('the CLI is not on this PATH');
      expect(logged[0]).not.toContain('DISABLED');
      warnings.mockRestore();
    });

    it('reports both when a disabled runner also has no binary', async () => {
      // The dev deployment's actual state: the flag defaults off AND `claude`
      // is not on the container's PATH. An `else if` reported only the flag,
      // so fixing it bought a second wait and a second investigation.
      const warnings = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation();

      await build({
        enabled: false,
        capabilities: {
          available: false,
          unavailableReason: 'the CLI is not on this PATH',
          version: 'unavailable',
        },
      }).onModuleInit();

      const logged = warnings.mock.calls.map((call) => String(call[0]));
      expect(logged).toHaveLength(2);
      expect(logged.some((line) => line.includes('DISABLED'))).toBe(true);
      expect(logged.some((line) => line.includes('UNAVAILABLE'))).toBe(true);
      warnings.mockRestore();
    });

    it('leaves the fleet unchanged when a runner cannot describe itself', async () => {
      // Writing a partial row would be worse than writing none: dispatch would
      // route against whatever half of the manifest survived.
      await build({
        capabilitiesThrows: new Error('probe exploded'),
      }).onModuleInit();

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('does not stop the API booting when the database write fails', async () => {
      // The reconciler, the watchdog and the escalation path are what VISION
      // §9 relies on to notice things going wrong. Refusing to boot because
      // one runner could not be written down would take all of them out over
      // the least important of them.
      const service = build();
      (prisma.$transaction as jest.Mock).mockRejectedValue(
        new Error('database is down'),
      );

      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });

    it('does not stop the API booting when capabilities throws', async () => {
      const service = build({
        capabilitiesThrows: new Error('probe exploded'),
      });
      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });
  });
});
