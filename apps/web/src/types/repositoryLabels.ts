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
 * ## The counts are nullable, and **null means NOT READ — never zero**
 *
 * `declared`, `present`, `missing`, `created`, `updated`, `unchanged` and
 * `failed` are null together or populated together. They are null exactly when
 * GitHub's label list was never obtained, which is the one condition under
 * which no number about this repository's labels can be honest: a token that
 * cannot read them says nothing whatever about what is on it. The API made
 * these nullable rather than merely documented so that "0 of 15 labels
 * present" — a lie with a plausible shape — cannot be rendered by accident.
 *
 * ## Nullness is a fact about the READ, not about `status`
 *
 * This is the distinction that decides whether a client is right or only
 * looks right, and the two conditions come apart:
 *
 *  - **Read-phase failure** — the label list could not be fetched at all. All
 *    seven counts are null and `labels` is empty.
 *  - **Write-phase failure** — the list came back and a write was then
 *    refused. `status` is still `refused` (or `rate_limited`, or any of the
 *    others), and the counts are **real**, with the full `labels` array: this
 *    call knows exactly what is on the repository, and may even have created
 *    some labels before being cut off.
 *
 * So a `refused` report can legitimately carry counts. Deriving nullness from
 * `status` throws a genuine observation away to satisfy a rule about a word;
 * `config/repositoryLabels.ts`'s `wasRead` checks the nulls themselves.
 *
 * ## `attempted` is not a success signal
 *
 * True when the call TRIED to write — false for `GET`, true for every `POST`,
 * including one that wrote nothing because it was refused. What landed is
 * `created`, `updated` and `failed`.
 *
 * ## `stateBefore` is the observation; `action` is the outcome
 *
 * `stateBefore` is what GitHub had before the call and is deliberately not
 * rewritten when a write succeeds, so a repaired label reads
 * `stateBefore: 'missing'` with `action: 'created'`. The name carries the
 * tense; a renderer still has to join the two, and one that showed
 * `stateBefore` after a repair would report the label it just made as absent.
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
 * is no way to know before trying. It is also the status that can arrive from
 * either phase — see the header.
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
  stateBefore: LabelStateName;
  /** What this call did. `none` for an inspection, or for a label a
   * write-phase refusal never got to. */
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
  /**
   * True when this call TRIED to write; false for an inspection.
   *
   * **Not "the writes landed."** A refused repair is `attempted: true` having
   * written nothing.
   */
  attempted: boolean;
  /** One human sentence, safe to render. Never contains the GitHub token. */
  detail: string;
  /** ISO-8601. When this was observed — not when it was stored. */
  checkedAt: string;
  /** The M in "N of M labels present". **Null when the labels were not read.** */
  declared: number | null;
  /**
   * The N, as of `checkedAt`, including anything this call just created.
   *
   * **Null means the labels could not be read, not that there are none.**
   */
  present: number | null;
  /** Null when not read. */
  missing: number | null;
  /** Null when not read. */
  created: number | null;
  /** Null when not read. */
  updated: number | null;
  /** Already present and already correct. Null when not read. */
  unchanged: number | null;
  /** Null when not read. */
  failed: number | null;
  /**
   * Per-label state. **Empty when the labels could not be read** — the same
   * condition that nulls every count above. A write-phase refusal keeps its
   * full array.
   */
  labels: LabelState[];
}
