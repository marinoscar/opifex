/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Written by `npm run contracts:generate` from the schema named below, which
 * is the contract. Edit that, re-run the generator, and commit both.
 * `npm run contracts:check` fails CI when this file and the schema disagree.
 */

// Source: schemas/runner-capability.schema.json

/**
 * A runner's HONEST declaration of itself (VISION.MD §6). Runners declare what they can do rather than pretending to be equivalent: equal observability across vendors is not achievable, but a common floor that some runners exceed is. Every field here is something the control plane will act on — thresholds, routing, gating — so an overstated manifest produces a control plane that trusts signal it is not actually receiving, and the failure surfaces as a healthy-looking run that nobody is really watching.
 */
export type RunnerCapabilityManifest = {
  /**
   * Version of this schema the manifest claims to conform to. Any 1.x version is accepted: within a major, every change is an added optional field, so a document written against an earlier minor still validates here (ADR-0010). A 2.x document is rejected by this file — majors get their own.
   */
  schemaVersion: string;
  /**
   * Stable identifier, used as the foreign key on every run and written into the `Runner:` commit trailer. Lowercase and hyphenated so it is safe in a trailer, a branch name and a log line.
   */
  key: string;
  displayName: string;
  /**
   * The runner's own version string, recorded on every run so a behaviour change can be correlated with an upgrade. Free-form: a vendor's versioning is not ours to constrain.
   */
  version: string;
  /**
   * How the control plane starts work. Determines what cancellation MEANS: a process can be signalled, an http_api call must be asked to stop, and a hosted_job may only be cancellable by its host. See ADR-0008 for why claude-code-local is `process`.
   */
  invocationModel: 'process' | 'http_api' | 'hosted_job';
  /**
   * Whose hardware the work runs on. A routing constraint, not a preference: work that must not leave the operator's own infrastructure declares `own-infrastructure` as a need, and vendor_cloud runners are then not eligible (VISION §11).
   */
  executionLocus: 'own_infrastructure' | 'vendor_cloud';
  /**
   * GRADED, not boolean, and the most consequential field here. It decides whether the control plane can run event-age watchdogs (#54) and tool-loop detection (#55), or must fall back to wall-clock timeouts and git-derived liveness (#52). `full` earns a 90-second silence threshold; `none` earns 90 minutes, because for a runner whose only signal is a commit, a false kill is far likelier than a missed stall.
   */
  streamingFidelity: 'full' | 'partial' | 'none';
  /**
   * GRADED, like streaming fidelity. Decides whether a blocked run can be PARKED with a dated resume (#56) or must be escalated because nothing can compute when it would resume. `structured` means a machine-readable reset time; `heuristic` means it can be inferred from a message; `none` means a rate limit is indistinguishable from any other failure.
   */
  rateLimitSignal: 'structured' | 'heuristic' | 'none';
  /**
   * How much the operator may depend on this runner. VISION §11 forbids a preview-tier runner from being LOAD-BEARING: routing will not select an `experimental` or `beta` runner unless some `stable` runner could take the identical work order (#64). The tier is the runner's own claim about itself, and is taken at its word.
   */
  stabilityTier: 'experimental' | 'beta' | 'stable';
  /**
   * Whether the runner reports spend. A capability rather than an assumption, because 'unknown' and 'zero' are genuinely different facts — a runner that cannot report cost must not look like one that spent nothing, or a budget ceiling becomes decorative.
   */
  reportsCost: boolean;
  /**
   * Whether the runner has vendor-specific session resumption. ALLOWED AS AN OPTIMISATION, NEVER LOAD-BEARING (VISION §3.4). Recovery is always abandon-and-re-run from the pinned base commit; a runner declaring true may shortcut that internally, and nothing in the control plane may require it. That is why this is a boolean here rather than a function on the seam.
   */
  resumable: boolean;
  /**
   * How many runs this runner will accept at once. VISION §11 notes automated runs compete with interactive use for one subscription quota, so this is the runner's own limit on how much of that quota it will take — not a performance hint. Routing enforces it (#64).
   */
  maxConcurrency: number;
  /**
   * Globs the runner is permitted to create or push to. `factory/*` for every runner Opifex dispatches to. A restriction the runner declares about ITSELF, which is separate from — and does not replace — the control plane's own refusal to touch anything else (ADR-0005).
   *
   * @minItems 1
   */
  branchPatterns: [string, ...string[]];
  /**
   * Which versions of the other two contracts this runner can read and write, so the control plane can emit at a version the runner actually understands. This matters because the schemas are strict (`unevaluatedProperties: false`): a runner validating an incoming work order against its pinned 1.0.0 copy REJECTS a 1.1.0 document over a field it does not know, even though the field is optional. So additive changes are only safe if the producer knows what the consumer speaks. Absent means the newest 1.x the control plane has — correct for a runner that ships with Opifex and tracks it, wrong for an independent one, which should say so explicitly (ADR-0010).
   */
  speaksSchemaVersions?: {
    /**
     * Work-order versions the runner can consume.
     *
     * @minItems 1
     */
    workOrder: [string, ...string[]];
    /**
     * Run-event versions the runner can emit.
     *
     * @minItems 1
     */
    runEvent: [string, ...string[]];
  };
  /**
   * Anything the operator should know that no field above captures. Prose, never parsed — a field the control plane branched on would be a capability in disguise.
   */
  notes?: string;
  /**
   * Free-form vendor metadata, kept verbatim for the record. Deliberately unconstrained AND deliberately never read by routing: anything routing needs is a field above. This is where a vendor's peculiarities go to be recorded rather than acted on.
   */
  vendor?: {
    [k: string]: unknown;
  };
};

/** The version a producer should write, from the schema's `default`. */
export const RUNNER_CAPABILITY_SCHEMA_VERSION = '1.1.0';

/** Every value `executionLocus` may take. Closed — adding one is a major bump (ADR-0010). */
export const RUNNER_CAPABILITY_EXECUTION_LOCUS = [
  'own_infrastructure',
  'vendor_cloud',
] as const;

/** Every value `invocationModel` may take. Closed — adding one is a major bump (ADR-0010). */
export const RUNNER_CAPABILITY_INVOCATION_MODEL = [
  'process',
  'http_api',
  'hosted_job',
] as const;
