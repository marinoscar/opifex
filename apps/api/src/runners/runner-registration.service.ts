import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Prisma } from '@prisma/client';

import { ContractValidator } from '../contracts/contract-validator';
import { PrismaService } from '../prisma/prisma.service';
import { ClaudeCodeLocalRunner } from './claude-code-local/claude-code-local.runner';
import type { Runner, RunnerCapabilities } from './runner.types';

/**
 * Puts the fleet in the database, so dispatch can find it.
 *
 * ## Why this exists at all
 *
 * #61 built the runner and nothing could reach it. `DispatchService.loadPool()`
 * routes by reading `runners` and `runner_capabilities` — a runner absent from
 * those tables does not exist as far as routing is concerned, and one present
 * without a capability row is dropped with a warning. So the seam was complete
 * and unreachable at the same time.
 *
 * ## The manifest is written from the runner, never from a fixture
 *
 * The row is built from a live `capabilities()` call at boot, not from a seed
 * file or a migration. That is the whole point: the manifest is OBSERVED — the
 * version is probed off the installed binary, and a binary that cannot be
 * probed declares `maxConcurrency: 0`. A registration written from a constant
 * would re-introduce exactly the aspirational manifest #61 spent three PRs
 * avoiding, and it would be wrong in the most expensive way: dispatch would
 * route real work on the strength of a file nobody had checked against the
 * machine.
 *
 * Re-registering on every boot is what keeps that true across a CLI upgrade.
 *
 * ## Registered-and-disabled is not the same as absent
 *
 * A runner switched off keeps its row with `enabled: false`, which is what the
 * schema's own comment asks for: *"a runner can be registered and switched off
 * without losing its history."* It also gives dispatch a better answer — "the
 * only runner is disabled" is actionable, "no runner is registered" sends an
 * operator looking for a bug in registration.
 *
 * ## Nor is registered-but-unavailable, which is a third thing (#253)
 *
 * The design above was true and unreachable. A probe failure used to be said
 * as `maxConcurrency: 0`; the schema required at least one slot, so the
 * manifest failed the boundary check below and the runner was left
 * unregistered — the precise outcome this comment says the design exists to
 * avoid, reported to the operator as an empty fleet. Schema 1.3.0 gives the
 * fact its own field, `available`, and the runner keeps its real capacity, so
 * the manifest validates and the branch below reports the health problem for
 * the first time. It had been dead code since it was written.
 *
 * Three states, three signals, none of them collapsed: `enabled: false` is an
 * operator's switch, `available: false` is a health report, `maxConcurrency`
 * is capacity. They are logged as separate lines that can both appear — the
 * dev deployment is regularly both — and dispatch names them differently too.
 *
 * None of this weakens the boundary. A manifest that is genuinely malformed
 * still keeps its runner out of the fleet; what changed is that being unable
 * to work stopped counting as being malformed.
 */
@Injectable()
export class RunnerRegistrationService implements OnModuleInit {
  private readonly logger = new Logger(RunnerRegistrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly claudeCodeLocal: ClaudeCodeLocalRunner,
    private readonly contracts: ContractValidator,
  ) {}

  /**
   * Register the fleet at boot.
   *
   * Never throws. A registration failure must not stop the API coming up: the
   * rest of the control plane — the reconciler, the watchdog, the escalation
   * path — is what VISION §9 relies on to notice things going wrong, and
   * refusing to boot because one runner could not be written down would take
   * all of it out over the least important of them.
   */
  async onModuleInit(): Promise<void> {
    await this.registerAll();
  }

  /**
   * Every runner this build knows about.
   *
   * A list rather than a loop over a registry, because there is exactly one
   * runner and VISION §3.7 says not to build the second until it is needed.
   * Adding one here is a line; a registry abstraction for a single entry is
   * the kind of thing that makes the second runner look easy and the first
   * one hard to read.
   */
  async registerAll(): Promise<void> {
    await this.register(this.claudeCodeLocal, this.claudeCodeLocalEnabled);
  }

  private async register(runner: Runner, enabled: boolean): Promise<void> {
    let capabilities: RunnerCapabilities;
    try {
      capabilities = await runner.capabilities();
    } catch (error) {
      // Reaching here means the runner could not describe itself, which is a
      // different failure from the binary being missing — that one is already
      // handled inside `capabilities()` and comes back as zero capacity.
      this.logger.error(
        `Could not read capabilities; leaving the fleet unchanged: ${asMessage(error)}`,
      );
      return;
    }

    // The boundary (#35). A manifest is a runner's declaration of itself, and
    // the schema says an overstated one produces "a control plane that trusts
    // signal it is not actually receiving" — a run nobody is really watching,
    // discovered much later. Checking it here means a malformed manifest keeps
    // the runner out of the fleet instead of into it with a wrong shape.
    //
    // `capabilities.manifest` is the verbatim document the runner published;
    // the parsed fields alongside it are this service's own projection, so the
    // document is what the schema has an opinion about.
    const check = this.contracts.checkCapability(capabilities.manifest);
    if (!check.valid) {
      this.logger.error(
        `${capabilities.key} published a manifest that does not match ` +
          `runner-capability.schema.json; leaving it unregistered so dispatch ` +
          `cannot route to it: ${ContractValidator.describe(check.violations)}`,
      );
      return;
    }

    try {
      await this.upsert(capabilities, enabled);
    } catch (error) {
      this.logger.error(
        `Could not register ${capabilities.key}; dispatch will not route to it: ${asMessage(error)}`,
      );
      return;
    }

    // Logged at `warn` when something is off, because both cases produce the
    // same visible symptom — work orders queueing forever — and an operator
    // scanning for why deserves to find the reason without turning up the log
    // level.
    //
    // Two conditions, two lines, and deliberately not one `else if` chain.
    // `enabled: false` is a decision a human made and `available: false` is a
    // condition the machine is in; they take opposite responses — flip a flag
    // back, or fix what the runner's own reason names — and they are very
    // often BOTH true at once, which is exactly the case the chain used to
    // hide. The dev deployment defaults the flag off AND has no `claude` on
    // its PATH, so reporting only the flag would send an operator to fix it
    // and leave them waiting on a runner that still could not take the work.
    if (!enabled) {
      this.logger.warn(
        `Registered ${capabilities.key}@${capabilities.version} as DISABLED by ` +
          'configuration; set CLAUDE_CODE_LOCAL_ENABLED=true to let dispatch route to it',
      );
    }

    // `=== false` rather than `!capabilities.available`: absent means
    // available, and a falsy test would report every healthy runner as broken.
    if (capabilities.available === false) {
      this.logger.warn(
        `Registered ${capabilities.key} as UNAVAILABLE: it can take no work right now, ` +
          `and says why — ${capabilities.unavailableReason ?? 'no reason given'} ` +
          `Its ${capabilities.maxConcurrency} slot(s) are intact and nothing has been ` +
          'switched off; dispatch will queue rather than route to it until this clears.',
      );
    }

    if (enabled && capabilities.available !== false) {
      this.logger.log(
        `Registered ${capabilities.key}@${capabilities.version}, ` +
          `${capabilities.maxConcurrency} slot(s), ${capabilities.streamingFidelity} streaming`,
      );
    }
  }

  /**
   * One upsert for the runner, one for its manifest.
   *
   * In a transaction because the two are one fact. A runner row whose
   * capability row failed to write is precisely the state `loadPool()` drops
   * with a warning — the runner would vanish from routing while appearing
   * registered, which is the most confusing of the available failures.
   */
  private async upsert(
    capabilities: RunnerCapabilities,
    enabled: boolean,
  ): Promise<void> {
    const shared = {
      displayName: capabilities.displayName,
      version: capabilities.version,
      enabled,
    };

    await this.prisma.$transaction(async (tx) => {
      const runner = await tx.runner.upsert({
        where: { key: capabilities.key },
        create: { key: capabilities.key, ...shared },
        update: shared,
      });

      const manifest = {
        schemaVersion: capabilities.schemaVersion,
        invocationModel: capabilities.invocationModel,
        executionLocus: capabilities.executionLocus,
        streamingFidelity: capabilities.streamingFidelity,
        rateLimitSignal: capabilities.rateLimitSignal,
        stabilityTier: capabilities.stabilityTier,
        reportsCost: capabilities.reportsCost,
        resumable: capabilities.resumable,
        maxConcurrency: capabilities.maxConcurrency,
        branchPatterns: capabilities.branchPatterns,
        // Kept verbatim as well as parsed, per the schema's own comment: a
        // field this database does not model yet must not be silently
        // discarded, or a manifest gains a capability and the record of it is
        // lost at the boundary.
        //
        // Cast because Prisma's Json input type does not accept an open
        // `Record<string, unknown>` — the manifest is JSON-serialisable by
        // construction (it is what `capabilities()` publishes), and this is
        // the boundary where that stops being expressible in the type system.
        manifest: capabilities.manifest as Prisma.InputJsonValue,
      };

      await tx.runnerCapability.upsert({
        where: { runnerId: runner.id },
        create: { runnerId: runner.id, ...manifest },
        update: manifest,
      });
    });
  }

  private get claudeCodeLocalEnabled(): boolean {
    return this.config.get<boolean>('runners.claudeCodeLocal.enabled') === true;
  }
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
