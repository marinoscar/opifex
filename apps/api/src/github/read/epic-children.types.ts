import type { RepositoryRef } from './github-read.service';

/** Which of the two sources named a child (#424). */
export type EpicChildSource = 'sub-issues-api' | 'issue-body';

/** `owner/name#number` — stable across repositories, unlike a bare number. */
export type IssueRef = string;

export function issueRef(
  owner: string,
  name: string,
  number: number,
): IssueRef {
  return `${owner}/${name}#${number}`;
}

export interface EpicChild {
  owner: string;
  name: string;
  number: number;
  ref: IssueRef;
  /** Null when the issue could not be read — see `unreadable`. */
  title: string | null;
  /**
   * As GitHub reports it RIGHT NOW, never the epic's checkbox.
   *
   * `- [x] #24` in an epic body is one human's bookkeeping and goes stale the
   * moment an issue is reopened. A caller deciding what to work on must read
   * this field; the checkbox is deliberately not carried at all, so it cannot
   * be mistaken for it.
   */
  state: 'open' | 'closed' | 'unknown';
  isPullRequest: boolean;
  /** Which source named it. Per-child, because a walk can mix sources. */
  source: EpicChildSource;
  /** 1 for a direct child of the epic. */
  depth: number;
  /** The issue that named it. */
  namedBy: IssueRef;
  /**
   * True when the child could not be read: deleted, transferred to another
   * repository, or in a repository this token cannot see (GitHub answers 404
   * for all three and does not distinguish them).
   *
   * Such a child stays IN the set with `state: 'unknown'` rather than being
   * dropped. Silently omitting it would make an epic look smaller than it is,
   * and the caller — which is about to act on this membership — would have no
   * way to tell a two-child epic from a five-child epic with three broken
   * references.
   */
  unreadable: boolean;
}

/** A reference skipped because it was already in the set. */
export interface SkippedRef {
  ref: IssueRef;
  namedBy: IssueRef;
  /**
   * `self` for an issue naming itself, `cycle` for a reference back to the
   * epic or to an ancestor, `duplicate` for the same issue reached twice by
   * different paths (a diamond, which is not an error).
   */
  reason: 'self' | 'cycle' | 'duplicate';
}

export interface EpicResolution {
  epic: {
    owner: string;
    name: string;
    number: number;
    ref: IssueRef;
    title: string;
  };
  /** Ordered by depth, then by the order the source named them. */
  children: EpicChild[];
  /**
   * What answered FOR THE EPIC ITSELF: the native relationship, its body, or
   * `none` when neither named anything.
   *
   * The acceptance criterion "the result records which source produced it".
   * Per-child `source` is the finer answer for a transitive walk.
   */
  source: EpicChildSource | 'none';
  /**
   * When this was observed. NOT a cache timestamp — nothing here is stored.
   *
   * Membership lives in GitHub and changes there. VISION §3.3's rule against
   * depending on values the system wrote itself is why this resolution is
   * never persisted: a `epic_children` table would be a second expression of
   * something GitHub already owns, and the first time the two disagreed the
   * factory would believe its own copy. A caller that holds this result is
   * holding an observation with a time on it, and is expected to treat an old
   * one as stale rather than as truth.
   */
  checkedAt: Date;
  /** The depth actually walked. `1` means "the issues directly listed here". */
  maxDepth: number;
  /** Every reference not followed, and why. Empty in the normal case. */
  skipped: SkippedRef[];
  /**
   * Why the native relationship did not answer for the epic, when it did not.
   *
   * Null when the native source answered. A string when it was empty
   * (the normal case in this repository today) or when the call failed — so a
   * surprising membership can be explained after the fact rather than guessed
   * at, which is the condition the issue attaches to allowing a fallback.
   */
  nativeUnavailable: string | null;
  /**
   * Task-list items in a body that named no issue, keyed by the issue whose
   * body they appeared in. Drift, surfaced rather than swallowed.
   */
  unparsed: { namedBy: IssueRef; item: string }[];
}

export interface ResolveEpicChildrenOptions {
  /**
   * How many levels to walk. Default 1.
   *
   * ## The decision, and why the default is 1
   *
   * "Everything under this" and "the issues directly listed here" are
   * different instructions, and the issue is explicit that the caller must
   * know which it got. The default is ONE LEVEL because the first caller
   * (#425) turns membership into label writes: an operator who says "only
   * work on epic #419" means the seven issues #419 lists, and a transitive
   * walk that silently pulled in a nested epic's children would widen a
   * destructive action beyond what was asked for. Narrow is recoverable;
   * wide is not.
   *
   * Transitive resolution is available by asking for it, and the depth walked
   * is reported back on every result so a caller can never be unsure.
   *
   * Clamped to 1..`MAX_EPIC_DEPTH`: each level costs a request per child, and
   * an unbounded walk over a mistyped graph is exactly the rate-limit
   * exhaustion #40 says must be surfaced rather than retried into.
   */
  maxDepth?: number;
}

/** The ceiling on `maxDepth`. Nesting deeper than this is a modelling error. */
export const MAX_EPIC_DEPTH = 5;

export type { RepositoryRef };
