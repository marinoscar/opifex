/**
 * Near-duplicate detection between a candidate issue and the open ones.
 *
 * VISION §5, "issue creation is gated":
 *
 * > The failure mode that destroys agent-driven traceability is volume: every
 * > run opens issues, four hundred accumulate, and traceability inverts into
 * > noise.
 *
 * ## Why token overlap rather than embeddings
 *
 * An embedding model would catch a paraphrase this misses. It would also put
 * a model call on the path of every issue creation, make the refusal
 * non-deterministic, and — the deciding objection — make "why was my issue
 * refused" unanswerable. VISION §3.6 is explicit that no model output takes
 * effect without passing through deterministic policy; a gate whose verdict
 * cannot be explained or reproduced is the wrong shape for a rule that
 * REFUSES things.
 *
 * Duplicate agent-generated issues are near-identical in wording in practice —
 * they come from the same prompt seeing the same repository — so lexical
 * overlap catches the case that actually occurs.
 */

/**
 * Words carrying no signal for this comparison.
 *
 * Deliberately short. Aggressive stop-listing makes two unrelated issues look
 * similar by stripping away everything that distinguished them, and a false
 * refusal is more expensive than a false accept: the duplicate can be closed,
 * but a refused issue is work that never got tracked.
 */
const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'if',
  'then',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'to',
  'of',
  'in',
  'on',
  'for',
  'with',
  'as',
  'at',
  'by',
  'from',
  'that',
  'this',
  'it',
  'its',
  'we',
  'should',
  'would',
  'can',
  'will',
  'not',
]);

/**
 * Normalize text to a token set.
 *
 * Markdown structure, code fences and links are stripped first: two issues
 * that quote the same stack trace or link the same file are not duplicates,
 * and leaving that text in makes them look like one.
 */
export function tokenize(text: string): Set<string> {
  const stripped = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .toLowerCase();

  return new Set(
    stripped
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token)),
  );
}

/** Jaccard: shared tokens over total distinct tokens. 0 when either is empty. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;

  let shared = 0;
  for (const token of a) {
    if (b.has(token)) shared += 1;
  }
  return shared / (a.size + b.size - shared);
}

export interface SimilarityInput {
  title: string;
  body: string;
}

/**
 * How alike two issues are, 0 to 1.
 *
 * Title is weighted heavily. Two issues with the same title are almost always
 * the same issue regardless of how the bodies differ, while two issues with
 * similar bodies are routinely different work against the same subsystem —
 * "add a test for X" and "fix X" share most of their body vocabulary and are
 * not duplicates.
 */
export function similarity(a: SimilarityInput, b: SimilarityInput): number {
  const titleScore = jaccard(tokenize(a.title), tokenize(b.title));
  const bodyScore = jaccard(tokenize(a.body), tokenize(b.body));

  return TITLE_WEIGHT * titleScore + (1 - TITLE_WEIGHT) * bodyScore;
}

export const TITLE_WEIGHT = 0.7;

/**
 * The refusal threshold.
 *
 * Set where an identical title with a differently-worded body still refuses
 * (0.7 x 1.0 = 0.7 on its own), while a shared subject with a different title
 * does not. Tuned to make a FALSE ACCEPT the likelier error, for the reason
 * in `STOP_WORDS`: a duplicate that slips through can be closed by a human in
 * seconds, and a refused issue is work that never got tracked at all.
 */
export const DUPLICATE_THRESHOLD = 0.65;
