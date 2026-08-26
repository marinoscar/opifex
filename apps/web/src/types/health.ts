/**
 * `GET /api/health/ready`, as the Control Center reads it.
 *
 * The endpoint is Terminus's, is `@Public()`, and is the ONLY place in the API
 * today that publishes fleet state to a browser. Epic #332's first design rule
 * is that configured and observed are different facts — and this payload is
 * the one that already carries both for a runner: `enabled` is what an
 * operator permitted, `available` is what the container's probe found. The
 * runbook (`docs/RUNBOOK-enable-claude-code-local.md`, step 3) puts the point
 * plainly by showing `available: true` beside `enabled: false`.
 *
 * Every field below `status` is OPTIONAL, and that is not defensive padding.
 * `FleetIndicator.describe()` emits a two-key object — `{ checked: false,
 * message }` — when it could not read the fleet table at all, and adds
 * `unroutable` and `message` only when there is something to say. A type that
 * insisted on the full shape would be a type that lies about the degraded
 * case, which is the case this screen exists for.
 */

/** One runner, as the fleet reports it. */
export interface FleetRunnerHealth {
  key: string;
  /**
   * What `claude --version` printed, carried through `probeVersion()`.
   *
   * OBSERVED, not configured — the runbook is explicit that the version string
   * "is not configuration, it is what `claude --version` actually printed".
   */
  version: string | null;
  /** An operator's switch: a human permitted this runner to take work. */
  enabled: boolean;
  /** A health report: the runner probed itself and can work right now. */
  available: boolean;
  /** Present only when `available` is false. */
  unavailableReason?: string;
  maxConcurrency: number;
}

/** `info.fleet` from the readiness payload. */
export interface FleetHealth {
  status: string;
  /**
   * False when the fleet table could not be read at all. Everything below is
   * then absent, and `message` carries the reason.
   */
  checked: boolean;
  registered?: number;
  routable?: number;
  enabled?: number;
  dispatchable?: number;
  checkedAt?: string;
  runners?: FleetRunnerHealth[];
  /** Runner keys registered but invisible to routing. */
  unroutable?: string[];
  /** The indicator's own sentence about the finding, when it has one. */
  message?: string;
}

/** A Terminus indicator entry, keyed by indicator name. */
export type HealthIndicatorMap = Record<
  string,
  { status: string } & Record<string, unknown>
>;

/**
 * The readiness payload.
 *
 * `info` holds the indicators that are up and `details` holds all of them, so
 * a fleet entry is in `details` whether or not the check went red. Read `info`
 * first and fall back to `details` — never the other way round.
 */
export interface ReadinessHealth {
  status: string;
  info?: HealthIndicatorMap;
  error?: HealthIndicatorMap;
  details?: HealthIndicatorMap;
  timestamp?: string;
}
