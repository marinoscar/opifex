/**
 * `GET`/`POST /api/repositories/:id/labels`, as the ladder reads them (#415).
 *
 * A mirror of `apps/api/src/repositories/dto/repository-labels.dto.ts`,
 * written against that file rather than guessed at.
 *
 * ## A failure is a 200 carrying a `status`, so there is one shape and never two
 *
 * `no_credential`, `invalid_credential`, `refused`, `not_found`,
 * `rate_limited`, `unreachable` and `failed` all arrive as successful
 * responses. An `ApiError` from either call therefore means the REQUEST
 * failed — the account may not hold the permission, or the API is down — and
 * never that GitHub said no. The two are reported separately for the same
 * reason `types/repositories.ts` states.
 *
 * ## `labels` is EMPTY on every GitHub-level failure
 *
 * This is the one property of the shape that a renderer can get wrong without
 * looking wrong. `present: 0, declared: 15, labels: []` on a `refused` report
 * does not mean "no label exists on that repository" — it means nobody was
 * able to look. "None are present" and "we could not ask" are different facts
 * with different remedies, and `config/repositoryLabels.ts` keeps them apart
 * (`wasRead`) so that no count is ever rendered for an answer that never
 * observed anything.
 *
 * ## `state` is the observation; `action` is the outcome
 *
 * `state` is what GitHub had BEFORE the call and is deliberately not rewritten
 * when a write succeeds, so a repaired label reads `state: 'missing'` with
 * `action: 'created'`. A renderer that shows `state` after a repair would
 * report the label still missing, having just created it.
 */

/**
 * Which part of the taxonomy a label belongs to. Missing one of each has a
 * different consequence, which is why the kind travels with the label.
 */
export type ProvisionedLabelKind = 'input' | 'mirror' | 'routing';

/**
 * Why the report says what it says. Each member names a different remedy —
 * the API's own test for whether a status earns its own arm.
 *
 * `refused` is the one this feature exists to report: ADR-0001's fine-grained
 * PAT grants access one repository and one permission at a time, so a token
 * that can READ a repository need not be able to write its labels, and there
 * is no way to know before trying.
 */
export type LabelProvisioningStatus =
  | 'ok'
  | 'incomplete'
  | 'no_credential'
  | 'invalid_credential'
  | 'refused'
  | 'not_found'
  | 'rate_limited'
  | 'unreachable'
  | 'failed';

/** What was found on GitHub for one declared label, before this call. */
export type LabelStateName = 'present' | 'missing' | 'drifted';

/** What this call did about one declared label. There is no `deleted`. */
export type LabelActionName = 'none' | 'created' | 'updated' | 'failed';

/** One declared label, as found and as acted on. */
export interface LabelState {
  /** e.g. `factory:ready`. */
  name: string;
  kind: ProvisionedLabelKind;
  /** GitHub's state BEFORE this call. Never rewritten by a write. */
  state: LabelStateName;
  /** What this call did. `none` for an inspection. */
  action: LabelActionName;
  /** For `drifted`: what differs, e.g. `color ededed -> d93f0b`. */
  differences: string[];
  /** Why the write failed, when `action` is `failed`. Else null. */
  detail: string | null;
}

/** The whole answer. One object, whatever happened. */
export interface LabelProvisioningReport {
  /** `owner/name`. */
  repository: string;
  /** True only when `status` is `ok`. */
  ok: boolean;
  status: LabelProvisioningStatus;
  /** True when the call attempted writes; false for an inspection. */
  applied: boolean;
  /** One human sentence, safe to render. Never contains the GitHub token. */
  detail: string;
  /** ISO-8601. When this was observed — not when it was stored. */
  checkedAt: string;
  /** The M in "N of M labels present". */
  declared: number;
  /** The N, as of `checkedAt`. Includes anything this call just created. */
  present: number;
  missing: number;
  created: number;
  updated: number;
  /** Already present and already correct: a no-op, reported as one. */
  unchanged: number;
  failed: number;
  /** Per-label state. **Empty on every GitHub-level failure** — see above. */
  labels: LabelState[];
}
