import { Injectable, Logger } from '@nestjs/common';

/**
 * Supervisor settings that were removed, and are still read once at boot to
 * say so (ADR-0016).
 *
 * ## Why removing a variable is not enough on its own
 *
 * `SUPERVISOR_LIVE_RUN_CEILING` defaulted to no ceiling and was removed by
 * ADR-0016, so almost every deployment is unaffected. The exception is the one
 * that matters: an operator who set it, believing they had bounded something.
 * Deleting the read and saying nothing leaves that operator with a variable
 * exported in a real `.env`, a control they think is in force, and no way to
 * find out otherwise short of reading a diff.
 *
 * This holds itself to the standard `hard-spend-ceiling.ts` already sets for
 * its own limit — "a safety limit nobody can see the state of is one an
 * operator will assume is working". The difference is the direction: that file
 * announces a limit that IS in force, and this one announces that a value the
 * operator supplied is NOT.
 *
 * ## Warn, not error, and nothing at all when unset
 *
 * A warning rather than an error because nothing is broken and nothing is
 * unbounded: the parked-run arm of the quota gate is untouched and still
 * defaults on, and ADR-0016's finding is that the ceiling never bounded spend
 * to begin with. An unset variable produces no message — the overwhelming
 * majority of deployments never set it, and a boot line about a setting nobody
 * chose is noise that teaches operators to skim warnings.
 *
 * Read from `process.env` rather than `ConfigService` for the plain reason
 * that there is no config key left to read: `configuration.ts` no longer maps
 * this variable to anything, which is the point of the retirement.
 */

/** A setting that no longer does anything, and what to tell the operator. */
export interface RetiredSetting {
  /** The environment variable name, as an operator would grep for it. */
  readonly env: string;
  /** The decision that retired it, named in the log line. */
  readonly decision: string;
  /** Where to read the reasoning in full. */
  readonly document: string;
  /** What it used to do and why it stopped, in one sentence. */
  readonly because: string;
  /** What, if anything, still covers the concern it was reached for. */
  readonly instead: string;
}

export const RETIRED_LIVE_RUN_CEILING_ENV = 'SUPERVISOR_LIVE_RUN_CEILING';

/**
 * Every retired supervisor setting.
 *
 * A list rather than a one-off branch so the next retirement is a row here
 * beside its reasoning, rather than a second ad-hoc warning somewhere else.
 */
export const RETIRED_SUPERVISOR_SETTINGS: readonly RetiredSetting[] =
  Object.freeze([
    {
      env: RETIRED_LIVE_RUN_CEILING_ENV,
      decision: 'ADR-0016',
      document: 'docs/adr/0016-supervisor-live-run-ceiling.md',
      because:
        'it stood the supervisor down on a count of live runs, which does not determine ' +
        'what an invocation spends — every proposer runs once per tick whatever that ' +
        'count is',
      instead:
        'the supervisor still stands down while any run is parked on a rate limit ' +
        '(SUPERVISOR_STAND_DOWN_WHEN_BLOCKED, still on by default); for a real cap on ' +
        'the supervisor’s metered spend see #261',
    },
  ]);

/**
 * The warnings an environment earns, in order.
 *
 * PURE, so the wording an operator will actually see is testable without a
 * Nest container — the same reason `parseHardCeiling` is separate from the
 * service that holds it.
 *
 * An empty or whitespace-only value counts as unset, matching how the removed
 * `configuration.ts` read behaved: it treated an exported-but-empty variable
 * as no ceiling, so warning about one now would report a control that was
 * never in force either.
 */
export function retiredSupervisorWarnings(
  env: NodeJS.ProcessEnv,
  settings: readonly RetiredSetting[] = RETIRED_SUPERVISOR_SETTINGS,
): string[] {
  const warnings: string[] = [];

  for (const setting of settings) {
    const raw = env[setting.env];
    if (raw === undefined || raw.trim() === '') continue;

    warnings.push(
      `${setting.env} is set to ${JSON.stringify(raw)} and has NO EFFECT. ` +
        `${setting.decision} removed it because ${setting.because}. ` +
        `Remove it from your environment — ${setting.instead}. ` +
        `See ${setting.document}.`,
    );
  }

  return warnings;
}

/**
 * Says the above once, at boot.
 *
 * The constructor is the whole of it: Nest instantiates the provider once per
 * process, so an operator gets one line per retired setting they still have
 * exported rather than one per supervisor tick.
 */
@Injectable()
export class RetiredSupervisorConfigService {
  private readonly logger = new Logger(RetiredSupervisorConfigService.name);

  constructor() {
    for (const warning of retiredSupervisorWarnings(process.env)) {
      this.logger.warn(warning);
    }
  }
}
