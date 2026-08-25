/**
 * The `factory:*` / `factory/*` label vocabulary, and the one rule that makes
 * it safe.
 *
 * VISION §3.3 is precise about this: labels are a **bidirectional edge, not
 * the state machine**. Two kinds, and the separator is what tells them apart:
 *
 *  - **Input labels** (`factory:hold`) express HUMAN INTENT. Opifex obeys them.
 *  - **Mirror labels** (`factory/dispatched`) are written BY Opifex for
 *    visibility, and are never read as truth.
 *
 * ## Why reading a mirror label back would be a bug, not just redundant
 *
 * Opifex's own state lives in Postgres. If the reconciler also read
 * `factory/dispatched` as an input, its computed desired state would depend on
 * a value it wrote itself on a previous tick — a feedback loop with its own
 * output. Worse, GitHub's copy lags: a mirror write that failed, or one a
 * human removed by hand, would silently roll the control plane's state
 * backwards. Postgres is authoritative precisely so that cannot happen.
 *
 * The separator is the whole enforcement mechanism, so it is defined once,
 * here, and `isMirrorLabel` is applied at the read boundary rather than by
 * each consumer remembering to filter.
 */

/** Input labels obey a colon: `factory:hold`. */
export const INPUT_LABEL_PREFIX = 'factory:';

/** Mirror labels use a slash: `factory/dispatched`. */
export const MIRROR_LABEL_PREFIX = 'factory/';

/**
 * The input labels Opifex understands. VISION §3.3 names exactly these three.
 *
 * A closed set rather than "anything starting with `factory:`", because an
 * unrecognised input label is a typo — `factory:hold-please` should be
 * reported as unknown, not silently ignored as if the operator never asked.
 */
export const INPUT_LABELS = {
  /** Stop. Nothing is dispatched for this issue while it is present. */
  HOLD: 'factory:hold',
  /** Go. The operator has confirmed this issue is ready to be worked. */
  READY: 'factory:ready',
  /**
   * Release a quarantine.
   *
   * VISION §8 makes this the one label whose APPLIER matters: only a human may
   * apply it, which is why #41 has to read issue timeline events and not just
   * the current label set. A label list says a label is present; only the
   * timeline says who put it there.
   */
  CLEAR_QUARANTINE: 'factory:clear-quarantine',
} as const;

export type InputLabel = (typeof INPUT_LABELS)[keyof typeof INPUT_LABELS];

export const ALL_INPUT_LABELS: readonly InputLabel[] =
  Object.values(INPUT_LABELS);

/** Mirror labels Opifex writes. Listed so #42 cannot invent a fourth quietly. */
export const MIRROR_LABELS = {
  DISPATCHED: 'factory/dispatched',
  BLOCKED: 'factory/blocked',
  REVIEW: 'factory/review',
  QUARANTINE: 'factory/quarantine',
  /**
   * A `factory:`, `needs:` or `tier:` label on this issue was not understood,
   * or contradicted another, so it was ignored (#297).
   *
   * ## Why a fifth mirror label was worth it when a fourth INPUT label was not
   *
   * #273 declined to name the model tier `factory:tier-…` because `factory:`
   * is a closed vocabulary of three human INTENTS, and a fourth would have to
   * be understood by the mirror machinery and the unknown-input reporting.
   * None of that applies here. A mirror label is never read as truth, so it
   * couples to nothing; the whole cost is this entry plus one in
   * `.github/labels.yml`, which is exactly the registration `MIRROR_LABELS`
   * exists to force.
   *
   * ## It is advisory, and orthogonal to intent
   *
   * Every other mirror label reports what the factory is DOING, and exactly
   * one of them applies at a time. This one reports something about the
   * INPUT, so it can accompany any of them — an issue can be dispatched and
   * still have had a `tier:` typo ignored. The projection therefore appends
   * it rather than choosing it, and the work still runs on the default.
   */
  LABEL_IGNORED: 'factory/label-ignored',
} as const;

export type MirrorLabel = (typeof MIRROR_LABELS)[keyof typeof MIRROR_LABELS];

export const ALL_MIRROR_LABELS: readonly MirrorLabel[] =
  Object.values(MIRROR_LABELS);

export function isMirrorLabel(name: string): boolean {
  return name.startsWith(MIRROR_LABEL_PREFIX);
}

export function isInputLabel(name: string): name is InputLabel {
  return (ALL_INPUT_LABELS as readonly string[]).includes(name);
}

/**
 * A `factory:` label that is not one of the three Opifex understands.
 *
 * Surfaced rather than dropped: an operator who typed `factory:hold-please`
 * and got silence has no way to discover that nothing is holding.
 */
export function isUnknownInputLabel(name: string): boolean {
  return name.startsWith(INPUT_LABEL_PREFIX) && !isInputLabel(name);
}
