/**
 * Work-order identity, as arithmetic on strings.
 *
 * VISION §3.4 makes recovery abandon-and-re-run rather than session
 * resumption, and that only works if a re-run is idempotent. VISION §4 says
 * what buys the idempotency:
 *
 * > A runner checks whether its branch already exists before doing anything.
 *
 * So idempotency is a property of the NAMING SCHEME, not of a lock. Two
 * dispatches of the same work at the same commit compute the same branch name,
 * and the second runner finds the first one's branch already there. No
 * coordination, no lease, nothing to leak if a process dies at the wrong
 * moment.
 *
 * Everything here is pure and deterministic. There is no clock, no random, and
 * no database — a function that produced a different answer on Tuesday would
 * make the whole recovery model unsound.
 */

/** How much of the base commit goes in the name. VISION §4 fixes this at 7. */
export const COMMIT_PREFIX_LENGTH = 7;

export interface WorkOrderCoordinates {
  /** Repository NAME only, without the owner. */
  repository: string;
  issueNumber: number;
  /** The full 40-character SHA the work starts from. */
  baseCommit: string;
  /** 1 for the first go at this issue at this commit. */
  attempt: number;
}

/**
 * `wo_{repo}_{issue}_{commit7}_a{attempt}`
 *
 * ## What each component is doing
 *
 * - **repo** — which codebase. Sanitized, because a repository may legally be
 *   named `my.repo` and a dot in an identity that also appears in branch names
 *   and log lines invites someone to split on it.
 * - **issue** — the work. VISION §4 makes a work order a projection of an
 *   issue, so the issue number is the closest thing to a natural key.
 * - **commit7** — the base. This is the component that makes a re-run at a
 *   MOVED base a genuinely different work order, which is correct: the same
 *   task against a different starting tree is different work, and reusing the
 *   branch would rebase someone's changes by accident.
 * - **attempt** — a deliberate retry of the same work at the same base. The
 *   only component a human or the retry policy increments.
 *
 * ## The owner is not in here, and that is a known sharp edge
 *
 * The format comes from VISION §4 and `run-event.schema.json`, and it uses the
 * repository name alone. `Repository` is unique on `(owner, name)` but
 * `WorkOrder.identity` is globally unique, so two repositories with the same
 * NAME under different owners, on the same issue number, at the same base
 * commit, would collide on insert. Rare enough to live with and specific
 * enough to be worth stating: the failure is a loud unique-constraint
 * violation at generation, not silent cross-repository work.
 */
export function workOrderIdentity(coordinates: WorkOrderCoordinates): string {
  const { repository, issueNumber, baseCommit, attempt } =
    validate(coordinates);

  return `wo_${slug(repository)}_${issueNumber}_${shortCommit(baseCommit)}_a${attempt}`;
}

/**
 * `factory/{issue}-{commit7}-a{attempt}`
 *
 * Under the `factory/` prefix every runner declares in `branchPatterns`, so a
 * branch Opifex created is distinguishable from one a human did at a glance
 * and by a glob. The repository name is absent because the branch already
 * lives in the repository.
 */
export function workOrderBranch(coordinates: WorkOrderCoordinates): string {
  const { issueNumber, baseCommit, attempt } = validate(coordinates);

  return `factory/${issueNumber}-${shortCommit(baseCommit)}-a${attempt}`;
}

/**
 * Read an identity back apart.
 *
 * Not the inverse of `workOrderIdentity`: the repository name has been
 * slugged, so this returns the slug rather than the original. Useful for
 * reading a log line or an event whose work order has been deleted, and
 * deliberately strict — a string that does not parse returns null rather than
 * a half-filled object somebody then treats as real.
 */
export function parseWorkOrderIdentity(
  identity: string,
): WorkOrderCoordinates | null {
  const match = /^wo_(.+)_(\d+)_([0-9a-f]{7})_a(\d+)$/.exec(identity);
  if (!match) return null;

  return {
    repository: match[1],
    issueNumber: Number(match[2]),
    // Only the short form survives in the identity; the full SHA lives on the
    // row. Padding it out to 40 characters here would be inventing data.
    baseCommit: match[3],
    attempt: Number(match[4]),
  };
}

/**
 * The next attempt at the same work at the same base.
 *
 * Separate from generation so the retry policy (#66) has one obvious way to
 * say "again" without re-deriving coordinates and risking a different base.
 */
export function nextAttempt(
  coordinates: WorkOrderCoordinates,
): WorkOrderCoordinates {
  return { ...coordinates, attempt: coordinates.attempt + 1 };
}

function shortCommit(baseCommit: string): string {
  return baseCommit.slice(0, COMMIT_PREFIX_LENGTH).toLowerCase();
}

/**
 * Lowercase, and anything outside `[a-z0-9-]` becomes `-`.
 *
 * Underscores included, deliberately: `_` is the identity's own separator, so
 * a repository named `my_repo` would otherwise produce an identity that parses
 * back wrong.
 */
function slug(repository: string): string {
  return repository
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Refuse to name something that cannot be named correctly.
 *
 * Throwing rather than coercing, because every downstream use — the branch, the
 * unique constraint, the commit trailer, the correlation on every event — reads
 * this string back. A silently mangled identity would produce a work order that
 * looks fine and correlates with nothing.
 */
function validate(coordinates: WorkOrderCoordinates): WorkOrderCoordinates {
  const { repository, issueNumber, baseCommit, attempt } = coordinates;

  if (!slug(repository)) {
    throw new Error(
      `Repository name ${JSON.stringify(repository)} has no usable characters`,
    );
  }
  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    throw new Error(
      `Issue number must be a positive integer, got ${issueNumber}`,
    );
  }
  if (!/^[0-9a-f]{40}$/i.test(baseCommit)) {
    // The full SHA, not an abbreviation. An abbreviated base is ambiguous the
    // moment the repository grows, and this identity has to still resolve to
    // one commit in a year.
    throw new Error(
      `Base commit must be a full 40-character SHA, got ${JSON.stringify(baseCommit)}`,
    );
  }
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`Attempt must be a positive integer, got ${attempt}`);
  }

  return coordinates;
}
