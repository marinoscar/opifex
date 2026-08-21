import type { InputLabel } from '../labels/factory-labels';

/**
 * The normalized shapes every consumer of GitHub reads.
 *
 * ## Why these exist at all
 *
 * #41's rule: no GitHub response shape escapes the module. A reconciler that
 * reads `issue.pull_request !== undefined` to tell an issue from a PR is
 * coupled to a REST quirk; one that reads `issue.isPullRequest` is coupled to
 * a decision this file made once. The second survives GitHub changing its
 * mind, and more importantly it survives a second source — VISION §9 wants
 * git-derived liveness alongside runner-reported, and both have to produce
 * comparable facts.
 *
 * ## What is deliberately absent
 *
 * Nothing here mirrors a GitHub payload field-for-field. Every property is
 * one something in Opifex actually reads. Fields are added when a consumer
 * needs them, which keeps this from becoming a second definition of GitHub's
 * API that has to be maintained against the first.
 */

/** A label as Opifex classifies it — never a raw GitHub label. */
export interface NormalizedLabel {
  name: string;
  color: string;
  description: string | null;
}

export interface NormalizedIssue {
  number: number;
  title: string;
  /** Markdown, as authored. Null when the issue has an empty body. */
  body: string | null;
  state: 'open' | 'closed';
  /**
   * Login of the author. GitHub can return a null user for a deleted account,
   * so this is nullable and consumers must not assume otherwise.
   */
  author: string | null;
  /**
   * Labels with EVERY `factory/*` mirror label already removed.
   *
   * Filtered at the boundary, not by each consumer: VISION §3.3 says mirror
   * labels are never read as truth, and a rule enforced in one place is a
   * rule, while one each caller has to remember is a convention.
   */
  labels: NormalizedLabel[];
  /** The subset of `labels` that are recognised input labels. */
  inputLabels: InputLabel[];
  /**
   * `factory:` labels Opifex does not understand — a typo, surfaced rather
   * than dropped, so an operator who mistyped `factory:hold` finds out.
   */
  unknownInputLabels: string[];
  /**
   * `factory/*` labels currently on the issue — FOR THE DIFF ENGINE ONLY.
   *
   * ## Read this before using the field
   *
   * VISION §3.3 says mirror labels are "written by Opifex for visibility and
   * never read as truth". This field does not break that rule, but only
   * because of a distinction worth stating precisely:
   *
   *  - Reading a mirror label **as truth** means letting it influence what
   *    SHOULD be true. That is forbidden. It would make the control plane's
   *    desired state depend on its own previous output, and a mirror write
   *    that failed — or one a human hand-edited — would roll that state
   *    backwards. `desired-state.ts` therefore never sees this field, and a
   *    test asserts the projection is byte-identical with and without it.
   *
   *  - Reading a mirror label **as the current state of the output** is
   *    required. Without it the reconciler cannot tell an already-correct
   *    label from a missing one, so it would rewrite every label every tick,
   *    and could never remove a stale one (#48).
   *
   * The short version: the projection computes what labels SHOULD exist from
   * inputs only; the diff engine compares that against this to decide what to
   * write. Never pass this into a projection.
   */
  observedMirrorLabels: string[];

  /** True when this "issue" is really a pull request. GitHub conflates them. */
  isPullRequest: boolean;
  url: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface NormalizedPullRequest {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  /** Distinct from `state: closed`: GitHub reports a merged PR as closed. */
  merged: boolean;
  draft: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  author: string | null;
  url: string;
  createdAt: Date;
  updatedAt: Date;
  /** Null unless merged. */
  mergedAt: Date | null;
}

/**
 * The verdict of CI on a commit.
 *
 * GitHub has two separate systems here — check runs (the Checks API, used by
 * GitHub Actions) and commit statuses (the older Status API, used by most
 * third-party CI) — and a repository can use either or both. They are
 * normalized into one shape because the only question Opifex asks is "did CI
 * pass on this commit", and #107 gates PR surfacing on the answer.
 */
export interface NormalizedCheck {
  name: string;
  /** Which GitHub system reported it, for diagnosis when they disagree. */
  system: 'check-run' | 'commit-status';
  status: 'queued' | 'in_progress' | 'completed';
  /** Null while the check is still running. */
  conclusion:
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'timed_out'
    | 'action_required'
    | 'stale'
    | 'skipped'
    | null;
  url: string | null;
  completedAt: Date | null;
}

export interface NormalizedCommit {
  sha: string;
  message: string;
  /** Login where GitHub could match the commit to an account, else null. */
  author: string | null;
  /** The commit's own author date, which is what liveness measures from. */
  authoredAt: Date;
  url: string;
}

/**
 * A label applied to or removed from an issue, and BY WHOM.
 *
 * This is why #41 reads the timeline at all. VISION §8 says a quarantine
 * cannot be cleared by the system that raised it — only a human may apply
 * `factory:clear-quarantine`. The issue's label list can only say the label is
 * present; the timeline is the only place GitHub records who put it there, and
 * whether that actor was a bot.
 */
export interface NormalizedLabelEvent {
  event: 'labeled' | 'unlabeled';
  label: string;
  actor: string | null;
  /**
   * True when GitHub reports the actor's type as `Bot`, or the login carries
   * the `[bot]` suffix GitHub Apps get.
   *
   * Both checks, because they catch different things: `type: 'Bot'` covers
   * GitHub Apps, and the suffix catches an App acting through a token where
   * the type is reported as `User`. A human check that can be fooled by
   * either is not a check.
   */
  actorIsBot: boolean;
  occurredAt: Date;
}
