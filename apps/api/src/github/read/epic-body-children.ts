/**
 * The child-issue references an epic's BODY names (#424).
 *
 * ## Why this parser exists at all
 *
 * GitHub's native sub-issue relationship is the authoritative answer, and
 * `EpicChildrenService` asks for it first. It is also, in this repository,
 * completely empty: every epic ever filed here declares its children as a
 * markdown task list under a *Child work* heading, because that is what
 * `.github/ISSUE_TEMPLATE/epic.yml` renders. A resolver that consulted only
 * the native relationship would answer "no children" for every real epic and
 * be technically correct while being useless.
 *
 * So this is deliberately a prose parser, with all the drift that implies.
 * The drift is bounded by two rules below, and both are load-bearing.
 *
 * ## Rule 1: only inside a recognised child section
 *
 * Task lists appear all over an epic — *Exit criteria* is a checkbox list in
 * every one of them, and those items routinely cite issue numbers. Scanning
 * the whole body would make "#135" in `#17`'s "All merged in #135" a child of
 * that epic. Since the first real caller (#425) turns membership into LABEL
 * WRITES on GitHub, a false child is materially worse than a missing one: it
 * silently takes an unrelated issue off the queue. An epic that does not use
 * the heading therefore resolves to nothing, visibly, rather than to a guess.
 *
 * ## Rule 2: the FIRST reference in an item, and only the first
 *
 * Real items carry commentary that cites other issues. `#332` has
 *
 *     - [ ] #333 — `docs(adr)`: operator settings resolution *(blocks #345)*
 *
 * where #345 is a dependency, not a child. Taking every reference on the line
 * would have made it one. The child is the reference the item LEADS with,
 * which is the convention every epic in this repository follows.
 */

/**
 * One reference as written, before anything has been fetched.
 *
 * `owner`/`name` are null for the bare `#123` form, meaning "the epic's own
 * repository" — resolved by the caller, which is the only thing that knows
 * what that is.
 */
export interface ParsedChildRef {
  owner: string | null;
  name: string | null;
  number: number;
  /** The item's text, for diagnosing a surprising membership. */
  raw: string;
}

export interface ParsedEpicBody {
  /**
   * Whether a child section existed at all.
   *
   * Distinct from an empty `refs`: "this epic lists no children" and "this
   * epic has no child list" are different facts, and only the second one
   * suggests the body simply was not written to the template.
   */
  sectionFound: boolean;
  /** The heading text as authored, when one matched. */
  heading: string | null;
  /** Deduplicated, in the order the body names them. */
  refs: ParsedChildRef[];
  /**
   * Task-list items inside the section that carry no issue reference.
   *
   * Reported rather than dropped: this is the drift Rule 1 cannot prevent,
   * and the only way a human learns that an item they wrote is invisible to
   * the factory is if something says so.
   */
  unparsed: string[];
}

/** `## Child work`, `### Children`, and the variants actually in use. */
const CHILD_HEADING = /^child(?:ren| work| issues)?$/;

const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE = /^\s*(?:```|~~~)/;

/** `- [ ] text`, `* [x] text`, up to three leading spaces as CommonMark allows. */
const TASK_ITEM = /^\s{0,3}[-*+]\s+\[[ xX]\]\s*(.*)$/;

/**
 * An issue reference in the three forms a human writes.
 *
 * Ordered longest-first so `acme/app#12` is read as a cross-repository
 * reference rather than as a bare `#12` that happens to follow a slash. The
 * lookbehind on the bare form stops `docs/adr#5`-style text and any `#`
 * glued to a word from being read as a reference.
 */
const REFERENCE =
  /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)|([\w.-]+)\/([\w.-]+)#(\d+)|(?<![\w/])#(\d+)\b/;

/**
 * Read an epic body's declared children.
 *
 * Pure, and total: an unparseable body is an empty answer with `sectionFound`
 * false, never a throw. Nothing about resolution should fail because somebody
 * wrote an epic by hand.
 */
export function parseEpicBodyChildren(body: string | null): ParsedEpicBody {
  const empty: ParsedEpicBody = {
    sectionFound: false,
    heading: null,
    refs: [],
    unparsed: [],
  };
  if (!body) return empty;

  const section = extractChildSection(body);
  if (!section) return empty;

  const refs: ParsedChildRef[] = [];
  const unparsed: string[] = [];
  const seen = new Set<string>();

  for (const line of section.lines) {
    const item = line.match(TASK_ITEM);
    if (!item) continue;

    const text = item[1].trim();
    if (text.length === 0) continue;

    const ref = firstReference(text);
    if (!ref) {
      unparsed.push(text);
      continue;
    }

    // Deduplicated here rather than by the caller's visited set, so that a
    // repeated line reads as the typo it is instead of as a cycle.
    const key = `${ref.owner ?? ''}/${ref.name ?? ''}#${ref.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }

  return {
    sectionFound: true,
    heading: section.heading,
    refs,
    unparsed,
  };
}

/**
 * The lines under a child heading, up to the next heading of the SAME OR
 * SHALLOWER level.
 *
 * The level comparison is what lets `#332` keep its `#### Wave 1` style
 * subheadings inside its own section; stopping at the next heading of any
 * level would truncate that epic to its first wave. Fenced code is skipped so
 * a `# comment` inside an example block cannot end a section.
 */
function extractChildSection(
  body: string,
): { lines: string[]; heading: string } | null {
  const lines = body.split(/\r?\n/);

  let start = -1;
  let level = 0;
  let heading = '';
  let fenced = false;

  for (let i = 0; i < lines.length; i += 1) {
    if (FENCE.test(lines[i])) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    const match = lines[i].match(HEADING);
    if (!match) continue;

    if (start === -1) {
      if (isChildHeading(match[2])) {
        start = i + 1;
        level = match[1].length;
        heading = match[2].trim();
      }
      continue;
    }

    if (match[1].length <= level) {
      return { lines: lines.slice(start, i), heading };
    }
  }

  if (start === -1) return null;
  return { lines: lines.slice(start), heading };
}

/** `**Child work**` and `Child Work:` are the same heading as `Child work`. */
function isChildHeading(text: string): boolean {
  const normalized = text
    .replace(/[*_`]/g, '')
    .trim()
    .replace(/[:.\s]+$/, '')
    .toLowerCase();
  return CHILD_HEADING.test(normalized);
}

function firstReference(text: string): ParsedChildRef | null {
  const match = text.match(REFERENCE);
  if (!match) return null;

  // One alternative matched; the others are undefined.
  const owner = match[1] ?? match[4] ?? null;
  const name = match[2] ?? match[5] ?? null;
  const number = Number.parseInt(match[3] ?? match[6] ?? match[7], 10);

  if (!Number.isInteger(number) || number <= 0) return null;

  return { owner, name, number, raw: text };
}
