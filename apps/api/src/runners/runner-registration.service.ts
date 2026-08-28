import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { Prisma } from '@prisma/client';

import { ContractValidator } from '../contracts/contract-validator';
import { PrismaService } from '../prisma/prisma.service';
import { OperatorSettingsService } from '../settings/operator-settings/operator-settings.service';
import { ClaudeCodeLocalRunner } from './claude-code-local/claude-code-local.runner';
import type { Runner, RunnerCapabilities } from './runner.types';

/**
 * How often registration re-runs, in milliseconds.
 *
 * A minute, matching the reconciler's default tick, because this IS a
 * reconciler: it recomputes desired state — the fleet as the runners currently
 * describe themselves — rather than depending on one successful moment at
 * boot. #162's whole complaint is that a single consumed attempt made the
 * health of the fleet a function of container start ordering.
 *
 * Not configurable, for the reason `PrismaService`'s retry schedule is not: a
 * knob implies a decision an operator has to make, and there is no deployment
 * that wants a different number here. The work is one cached `capabilities()`
 * call, one schema check and one two-row upsert; a minute is far below where
 * that cost is worth thinking about, and far above the rate at which anything
 * being fixed by hand actually changes.
 */
export const REGISTRATION_INTERVAL_MS = 60_000;

/**
 * How many consecutive identical TRANSIENT failures pass before the error is
 * said again — ten, so roughly every ten minutes.
 *
 * The two obvious settings are both wrong. Never repeating is #162 itself: one
 * ERROR at boot, scrolled past within seconds, and a fleet that is empty and
 * silent about it forever. Repeating every tick is how an operator learns the
 * log is noise, and this line would be competing for attention with the
 * escalations that matter.
 *
 * A repeat is only earned because the information is genuinely new: "still
 * unable to register, now for eleven minutes" is a different fact from the
 * first failure, and it is the fact somebody who arrived after boot needs.
 * Contrast the permanent case below, where a repeat carries nothing.
 */
const TRANSIENT_REPEAT_EVERY = 10;

/**
 * What one attempt at one runner produced.
 *
 * `transient` and `permanent` are the distinction the retry turns on, and they
 * are named for what they say about the NEXT attempt rather than for what
 * failed. A database that could not be reached will very likely answer later,
 * so the loop keeps trying and keeps saying so. A manifest that failed the
 * schema check is a deterministic function of that manifest — the next attempt
 * on an unchanged document produces the identical violations — so retrying is
 * free but SAYING it again is pure noise.
 */
export type RegistrationOutcome = 'registered' | 'transient' | 'permanent';

/** What a whole pass over the fleet produced. Counts, for the task's log. */
export interface RegistrationSweep {
  registered: number;
  transient: number;
  permanent: number;
}

/**
 * What has already been said about one runner, so it is not said again.
 *
 * Per runner rather than global: two runners failing for two different reasons
 * must both be reported, and a shared counter would suppress the second.
 */
interface RunnerReportState {
  /** Dedupe key for the last outcome reported. `null` before the first. */
  reported: string | null;
  /** Consecutive attempts that produced that same key. */
  repeats: number;
  /** When the current run of failures started, for the recovery line. */
  failingSince: number | null;
}

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
 * probed declares `available: false` and says why. A registration written from
 * a constant would re-introduce exactly the aspirational manifest #61 spent
 * three PRs avoiding, and it would be wrong in the most expensive way: dispatch
 * would route real work on the strength of a file nobody had checked against
 * the machine.
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
 *
 * ## It converges; it does not try once (#162)
 *
 * Everything above was written down once, at `onModuleInit`, and never again.
 * So a database that was away for the thirty seconds around boot left the
 * fleet table empty for the LIFE of the process: `loadPool()` returned `[]`,
 * every work order queued behind *"No runners are registered"*, and the only
 * evidence was one ERROR line that had scrolled past. That is the failure
 * VISION §1 exists to eliminate, with the roles reversed — the control plane
 * itself, silently dead, looking perfectly healthy.
 *
 * It was reachable by ordinary means, not exotic ones. PostgreSQL is not a
 * service in `base.compose.yml`; it is an external container on a shared
 * network, so Compose cannot order the API behind it with `depends_on`, and
 * `compose up` routinely races it. `PrismaService` absorbs the short version
 * of that race with a bounded probe and then — deliberately, see its comment
 * on #162 — warns and boots anyway rather than crash-looping. That leaves the
 * long version to be handled HERE, which is where it belongs: a registration
 * that never retries is a registration bug, not a reason to buy a workaround
 * by making the whole process exit.
 *
 * So {@link registerAll} is now driven by `RunnerRegistrationTask` on an
 * interval as well as at boot, and the two paths are the same code. It is safe
 * to repeat by construction: `capabilities()` is required to be cheap enough
 * to call on a tick, and {@link upsert} is idempotent inside one transaction.
 *
 * Repeating forever, rather than stopping at the first success, buys three
 * things a bounded boot retry would not:
 *
 * - A fleet row deleted or edited by hand heals on the next tick instead of
 *   at the next restart.
 * - `available` is a SNAPSHOT in the database — dispatch routes off the row,
 *   not off a live probe — so a CLI installed after boot only becomes
 *   dispatchable because something re-observes it.
 * - A runner that becomes unregisterable later is retried on exactly the same
 *   path as one that was unregisterable at boot, so there is no second case.
 *
 * What it must not buy is a log an operator learns to skip. See
 * {@link TRANSIENT_REPEAT_EVERY} and {@link report} for what the second,
 * tenth and hundredth attempt actually say.
 */
@Injectable()
export class RunnerRegistrationService implements OnModuleInit {
  private readonly logger = new Logger(RunnerRegistrationService.name);

  /**
   * What has already been reported, per runner key.
   *
   * In memory rather than in the database: this is about what this PROCESS has
   * already said in its own log, so it is per process by definition, and a
   * fresh boot re-saying the state of the fleet is correct — that is the one
   * moment somebody is reading. Bounded by the number of runners, which is
   * one.
   */
  private readonly reportState = new Map<string, RunnerReportState>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: OperatorSettingsService,
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
   *
   * Kept as well as the interval, not replaced by it. Boot is when the fleet
   * is most likely to be stale (a new build, a changed manifest) and the one
   * moment an operator is definitely reading the log, so waiting a minute for
   * the first tick would make every healthy start look like a failed one.
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
   *
   * Returns counts rather than nothing so the task above it can act on a pass
   * without re-deriving what happened from the log. Never throws, on the tick
   * for the same reason as at boot: an unhandled rejection out of a
   * `setInterval` callback has no caller and takes the process down.
   */
  async registerAll(): Promise<RegistrationSweep> {
    const sweep: RegistrationSweep = {
      registered: 0,
      transient: 0,
      permanent: 0,
    };

    const outcomes = [
      await this.register(
        ClaudeCodeLocalRunner.KEY,
        this.claudeCodeLocal,
        this.claudeCodeLocalEnabled,
      ),
    ];

    for (const outcome of outcomes) {
      if (outcome === 'registered') sweep.registered += 1;
      else if (outcome === 'transient') sweep.transient += 1;
      else sweep.permanent += 1;
    }

    return sweep;
  }

  /**
   * The key is passed in rather than read off the runner.
   *
   * `Runner` is the four-function seam of #60 and carries no `key`; the only
   * place one appears is inside the capabilities document, which is precisely
   * what is unavailable when `capabilities()` is the thing that threw. Keying
   * the report state on the manifest would mean a runner whose probe keeps
   * failing gets no dedupe at all — the one case that most needs it.
   */
  private async register(
    key: string,
    runner: Runner,
    enabled: boolean,
  ): Promise<RegistrationOutcome> {
    let capabilities: RunnerCapabilities;
    try {
      capabilities = await runner.capabilities();
    } catch (error) {
      // Reaching here means the runner could not describe itself, which is a
      // different failure from the binary being missing — that one is already
      // handled inside `capabilities()` and comes back as `available: false`.
      //
      // Transient: a probe that threw is usually a machine in a bad moment
      // (a spawn that could not allocate, a filesystem that was busy), and
      // the next tick genuinely may differ.
      return this.report(key, {
        outcome: 'transient',
        message: `Could not read capabilities for ${key}; leaving the fleet unchanged: ${asMessage(error)}`,
      });
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
      // Permanent: validation is a pure function of the document, so an
      // unchanged manifest fails identically on every future tick. The loop
      // still re-checks it — a manifest is re-observed, and a version string
      // that was garbage can become valid once the CLI is fixed — but the
      // report is said once, and again only if the violations CHANGE.
      return this.report(key, {
        outcome: 'permanent',
        message:
          `${capabilities.key} published a manifest that does not match ` +
          `runner-capability.schema.json; leaving it unregistered so dispatch ` +
          `cannot route to it: ${ContractValidator.describe(check.violations)}`,
      });
    }

    try {
      await this.upsert(capabilities, enabled);
    } catch (error) {
      // The #162 path. Transient by nature — this is a database write, and
      // the overwhelmingly common cause is a database that is briefly away.
      return this.report(key, {
        outcome: 'transient',
        message: `Could not register ${capabilities.key}; dispatch will not route to it: ${asMessage(error)}`,
      });
    }

    return this.report(key, {
      outcome: 'registered',
      // Everything an operator would act on, so an UNCHANGED registration can
      // be repeated in silence and a changed one always speaks. A version
      // bump, a flag flipped, a CLI that appeared or vanished: each of them
      // moves this string and is therefore reported on the tick it happens,
      // without the log gaining a line a minute for the state that did not.
      signature:
        `${capabilities.key}@${capabilities.version}/${enabled}/` +
        `${capabilities.available !== false}/${capabilities.unavailableReason ?? ''}/` +
        `${capabilities.maxConcurrency}/${capabilities.streamingFidelity}`,
      lines: () => this.describeRegistration(capabilities, enabled),
    });
  }

  /**
   * Say it, unless it has already been said.
   *
   * The whole answer to "what does the second, third and hundredth attempt
   * log at", in one place so the three outcomes cannot drift apart:
   *
   * | attempt                          | level                          |
   * | -------------------------------- | ------------------------------ |
   * | first failure, or a NEW reason   | `error`                        |
   * | transient repeat, 2nd..9th       | `debug`                        |
   * | transient repeat, every 10th     | `error`, with how long          |
   * | permanent repeat, ever           | `debug`                        |
   * | first success, or a CHANGED one  | `log` / `warn`, as before      |
   * | identical success, repeated      | nothing                        |
   * | success after failures           | `log`, naming the recovery     |
   *
   * The recovery line is the one #162 was missing entirely and it is not
   * optional: an error that is silently retried until it works is worse than
   * either an error that repeats or one that never appears, because an
   * operator who read the failure has no way to learn it is over.
   */
  private report(
    key: string,
    attempt: {
      outcome: RegistrationOutcome;
      /** Dedupe key. Defaults to the message for failures. */
      signature?: string;
      message?: string;
      lines?: () => void;
    },
  ): RegistrationOutcome {
    const state = this.stateFor(key);
    const signature = `${attempt.outcome}:${attempt.signature ?? attempt.message ?? ''}`;
    const repeated = state.reported === signature;
    state.repeats = repeated ? state.repeats + 1 : 1;
    state.reported = signature;

    if (attempt.outcome === 'registered') {
      if (state.failingSince !== null) {
        const seconds = Math.round((Date.now() - state.failingSince) / 1000);
        this.logger.log(
          `Registered ${key} after failing for ${seconds}s; dispatch can route to it again`,
        );
        state.failingSince = null;
        // Reported below regardless of the dedupe: a recovery is exactly when
        // an operator wants the full manifest line, and suppressing it because
        // it matches the one from before the outage would leave the recovery
        // line unexplained.
        attempt.lines?.();
        return 'registered';
      }
      if (!repeated) attempt.lines?.();
      return 'registered';
    }

    const message = attempt.message ?? 'Registration failed';
    if (state.failingSince === null) state.failingSince = Date.now();

    if (!repeated) {
      // A new reason is new information, whatever came before it.
      this.logger.error(message);
      return attempt.outcome;
    }

    if (
      attempt.outcome === 'transient' &&
      state.repeats % TRANSIENT_REPEAT_EVERY === 0
    ) {
      const minutes = Math.round((Date.now() - state.failingSince) / 60_000);
      this.logger.error(
        `Still cannot register ${key} after ${state.repeats} attempts over ~${minutes}m; ` +
          `dispatch has no runner to route to. ${message}`,
      );
      return attempt.outcome;
    }

    // Deliberately `debug`: the condition is unchanged and already reported,
    // so this exists to be found by someone who has turned the level up and
    // is asking whether the loop is still running at all.
    this.logger.debug(
      `Registration attempt ${state.repeats} for ${key} failed the same way; retrying in ` +
        `${REGISTRATION_INTERVAL_MS}ms`,
    );
    return attempt.outcome;
  }

  private stateFor(key: string): RunnerReportState {
    const existing = this.reportState.get(key);
    if (existing) return existing;

    const fresh: RunnerReportState = {
      reported: null,
      repeats: 0,
      failingSince: null,
    };
    this.reportState.set(key, fresh);
    return fresh;
  }

  /**
   * The success lines, unchanged from before the retry existed.
   *
   * Logged at `warn` when something is off, because both cases produce the
   * same visible symptom — work orders queueing forever — and an operator
   * scanning for why deserves to find the reason without turning up the log
   * level.
   *
   * Two conditions, two lines, and deliberately not one `else if` chain.
   * `enabled: false` is a decision a human made and `available: false` is a
   * condition the machine is in; they take opposite responses — flip a flag
   * back, or fix what the runner's own reason names — and they are very
   * often BOTH true at once, which is exactly the case the chain used to
   * hide: a deployment with the flag turned off AND no `claude` on its PATH
   * gets one investigation per problem if only one is reported, so fixing the
   * flag buys a second wait rather than a working runner.
   *
   * Since ADR-0019 (#439) the flag defaults ON, which changes what the
   * disabled line MEANS rather than whether it is worth printing: it is no
   * longer the shipped posture an operator has not got to yet, it is a switch
   * somebody deliberately turned off. The message says so, because "set it to
   * true" reads very differently once true is where it started.
   */
  private describeRegistration(
    capabilities: RunnerCapabilities,
    enabled: boolean,
  ): void {
    if (!enabled) {
      this.logger.warn(
        `Registered ${capabilities.key}@${capabilities.version} as DISABLED by ` +
          'configuration — this runner ships enabled (ADR-0019), so something turned it ' +
          'off. Dispatch will queue every work order until it is turned back on, from ' +
          'the Control Center or with CLAUDE_CODE_LOCAL_ENABLED=true.',
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
    return this.settings.get('runners.claudeCodeLocal.enabled');
  }
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
