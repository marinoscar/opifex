import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ContractValidator } from '../contracts/contract-validator';
import { PrismaService } from '../prisma/prisma.service';
import { ClaudeCodeLocalRunner } from './claude-code-local/claude-code-local.runner';
import {
  REGISTRATION_INTERVAL_MS,
  RunnerRegistrationService,
} from './runner-registration.service';
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
  describe('converging rather than trying once (#162)', () => {
    /**
     * Every level captured, because the claims below are as much about what is
     * NOT said as about what is.
     */
    function spyOnLogger() {
      return {
        error: jest.spyOn(Logger.prototype, 'error').mockImplementation(),
        warn: jest.spyOn(Logger.prototype, 'warn').mockImplementation(),
        log: jest.spyOn(Logger.prototype, 'log').mockImplementation(),
        debug: jest.spyOn(Logger.prototype, 'debug').mockImplementation(),
      };
    }

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('registers the runner once the database comes back', async () => {
      // The test that would have caught the bug. A database away for the boot
      // attempt used to leave the fleet table empty for the life of the
      // process: `loadPool()` returned nothing and every work order queued
      // behind "No runners are registered" until somebody restarted the API.
      spyOnLogger();
      const service = build();
      (prisma.$transaction as jest.Mock).mockRejectedValueOnce(
        new Error("Can't reach database server at 127.0.0.1:5432"),
      );

      await service.onModuleInit();
      expect(runnerUpsert).not.toHaveBeenCalled();

      // The database came back; the next tick is what has to notice.
      await service.registerAll();

      expect(runnerUpsert).toHaveBeenCalledTimes(1);
      expect(capabilityUpsert).toHaveBeenCalledTimes(1);
    });

    it('reports the recovery, so an operator who read the failure learns it is over', async () => {
      // An error that is silently retried until it works is worse than either
      // alternative: the operator has seen the failure and has no way to find
      // out it cleared, so they go on believing the fleet is empty.
      const logger = spyOnLogger();
      const service = build();
      (prisma.$transaction as jest.Mock).mockRejectedValueOnce(
        new Error('database is down'),
      );

      await service.onModuleInit();
      await service.registerAll();

      const recovery = logger.log.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('after failing for'));
      expect(recovery).toHaveLength(1);
      expect(recovery[0]).toContain('claude-code-local');
      expect(recovery[0]).toContain('can route to it again');
    });

    it('says the first failure at error and the repeats at debug', async () => {
      // First attempt: exactly what the operator saw before this change.
      // Repeats: found only by someone who turned the level up and is asking
      // whether the loop is still running.
      const logger = spyOnLogger();
      const service = build();
      (prisma.$transaction as jest.Mock).mockRejectedValue(
        new Error('database is down'),
      );

      await service.onModuleInit();
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(String(logger.error.mock.calls[0][0])).toContain(
        'dispatch will not route to it',
      );

      await service.registerAll();
      await service.registerAll();

      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.debug).toHaveBeenCalledTimes(2);
    });

    it('re-asserts a transient failure every tenth attempt, with how long', async () => {
      // The compromise #162 is actually about. Never repeating is the bug —
      // one line at boot, scrolled past. Repeating every tick is how a log
      // stops being read. "Still failing, eleven minutes in" is new
      // information; the identical line a minute later is not.
      const logger = spyOnLogger();
      const service = build();
      (prisma.$transaction as jest.Mock).mockRejectedValue(
        new Error('database is down'),
      );

      for (let attempt = 0; attempt < 20; attempt++) {
        await service.registerAll();
      }

      const errors = logger.error.mock.calls.map((call) => String(call[0]));
      expect(errors).toHaveLength(3); // attempt 1, then 10 and 20
      expect(errors[1]).toContain('Still cannot register');
      expect(errors[1]).toContain('10 attempts');
      expect(errors[2]).toContain('20 attempts');
    });

    it('reports a failure whose reason changed, straight away', async () => {
      // A new reason is new information whatever the counter says. An
      // unreachable database and a rejected password call for different
      // responses, and suppressing the second because the first was recent
      // would tell the operator to keep waiting for a blip that is over.
      const logger = spyOnLogger();
      const service = build();
      const transaction = prisma.$transaction as jest.Mock;

      transaction.mockRejectedValue(new Error("Can't reach database server"));
      await service.registerAll();
      await service.registerAll();

      transaction.mockRejectedValue(new Error('Authentication failed'));
      await service.registerAll();

      const errors = logger.error.mock.calls.map((call) => String(call[0]));
      expect(errors).toHaveLength(2);
      expect(errors[1]).toContain('Authentication failed');
    });

    it('does not repeat itself about a manifest that will never validate', async () => {
      // A schema failure is a pure function of the document, so the hundredth
      // check produces the identical violations. Retrying it is free; SAYING
      // it a hundred times is how an operator learns to ignore the log — and
      // this line competes for attention with the escalations that matter.
      const logger = spyOnLogger();
      const service = build({
        capabilities: {
          manifest: {
            ...CAPABILITIES.manifest,
            streamingFidelity: 'excellent',
          },
        },
      });

      for (let attempt = 0; attempt < 50; attempt++) {
        await service.registerAll();
      }

      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(String(logger.error.mock.calls[0][0])).toContain(
        'runner-capability.schema.json',
      );
      // And the boundary still holds on every one of those attempts.
      expect(runnerUpsert).not.toHaveBeenCalled();
    });

    it('says nothing at all when a healthy registration is repeated', async () => {
      // The cost of converging forever must not be a line a minute. The state
      // did not change, so there is nothing to report.
      const logger = spyOnLogger();
      const service = build();

      await service.onModuleInit();
      expect(logger.log).toHaveBeenCalledTimes(1);

      await service.registerAll();
      await service.registerAll();

      expect(logger.log).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.debug).not.toHaveBeenCalled();
      // Still written every time, though. The upsert is how a fleet row
      // deleted by hand heals, and how an `available` snapshot taken while the
      // CLI was missing is corrected once it is installed.
      expect(runnerUpsert).toHaveBeenCalledTimes(3);
    });

    it('speaks again when the registration itself changed', async () => {
      // A CLI upgrade, a flag flipped, a binary that appeared: each moves the
      // signature, so suppression never hides a change an operator would act
      // on.
      const logger = spyOnLogger();
      const config = {
        get: () => true,
      } as unknown as ConfigService;
      let version = '2.1.240';
      const runner = {
        capabilities: jest.fn(async () => capabilitiesOf({ version })),
      } as unknown as ClaudeCodeLocalRunner;
      const service = new RunnerRegistrationService(
        buildPrisma(),
        config,
        runner,
        contracts,
      );

      await service.registerAll();
      await service.registerAll();
      expect(logger.log).toHaveBeenCalledTimes(1);

      version = '2.2.0';
      await service.registerAll();

      expect(logger.log).toHaveBeenCalledTimes(2);
      expect(String(logger.log.mock.calls[1][0])).toContain('2.2.0');
    });

    it('keeps trying when the runner cannot describe itself', async () => {
      // A probe that threw is a machine in a bad moment, not a verdict. The
      // fleet is left unchanged, and the next tick asks again.
      spyOnLogger();
      const service = build({
        capabilitiesThrows: new Error('probe exploded'),
      });

      const first = await service.registerAll();
      const second = await service.registerAll();

      expect(first).toMatchObject({ transient: 1, registered: 0 });
      expect(second).toMatchObject({ transient: 1 });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('counts what a pass did, so the tick has something to act on', async () => {
      spyOnLogger();
      await expect(build().registerAll()).resolves.toEqual({
        registered: 1,
        transient: 0,
        permanent: 0,
      });
    });

    it('re-runs often enough that a database blip is measured in a minute', async () => {
      // Pinned rather than described: the whole complaint in #162 is a fleet
      // table that stayed empty indefinitely, and the bound on "indefinitely"
      // is this constant.
      expect(REGISTRATION_INTERVAL_MS).toBeLessThanOrEqual(60_000);
    });
  });
});
