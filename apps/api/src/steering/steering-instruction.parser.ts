/**
 * An operator instruction, read WITHOUT a model (#425, epic #419).
 *
 * ## Why this is tried first, and why that is not an optimisation
 *
 * VISION §3.1 and §7 put dispatch decisions in code because "a model makes it
 * slower, costlier, and less reliable with no upside". *"only do 1 2 3"* is a
 * sentence with a grammar, and a grammar is a parser's job: this path is
 * faster, free, reproducible, and — the property that actually matters here —
 * **it cannot hallucinate an issue number**. A model asked to extract issue
 * references from prose will occasionally invent one, and the caller writes
 * labels to whatever it is handed.
 *
 * So the model is not a fallback this file degrades into. It is a SEPARATE
 * path that the caller takes only when this one reports it did not understand,
 * and `confident` is the whole of that contract.
 *
 * ## No I/O, and nothing here knows what a repository is
 *
 * This is a pure function over a string, in the shape `issue-projection.ts`
 * uses: the parse is a fact about the SENTENCE, and whether `#12` exists, is
 * open, or lives in a registered repository is a fact about GitHub that only
 * `SteeringService` can establish. Mixing the two would make the grammar
 * untestable without a network.
 *
 * ## The bare-number rule, which is the one subtle thing
 *
 * `#419` is unambiguous and always read as a reference. A BARE `419` is not:
 * *"fix the 404 handler"* names no issue, and a parser that swept every digit
 * run out of the sentence would propose writing labels to issue #404. That is
 * the parser's own version of hallucinating a number, and it is worse than the
 * model's because it looks deterministic.
 *
 * A bare number is therefore read as a reference only when it is ARMED — when
 * the tokens leading up to it are scope words (`only`, `work on`, `issues`,
 * `hold`, …) or fillers between them. `only do 1 2 3` arms; `fix the 404
 * handler` does not, and the number is reported in `ignoredNumbers` so the
 * operator can see the parser declined to read it rather than guessing that it
 * was silently dropped.
 */

import { INPUT_LABELS } from '../github/labels/factory-labels';

/** What the operator wants to happen to the issues they NAMED. */
export type SteeringIntent = 'ready' | 'hold';

/**
 * What happens to everything the operator did NOT name, when the instruction
 * is exclusive.
 *
 * `unready` removes `factory:ready`; `hold` also applies `factory:hold`. The
 * difference is deliberate and is argued in `steering.service.ts`: *"only work
 * on 1, 2 and 3"* asks for the narrower of the two, and widening it to a hold
 * would put a stronger statement on record than the operator made.
 */
export type SteeringElseIntent = 'unready' | 'hold';

export interface ParsedTarget {
  /** `epic` means "the issues this one lists", never the issue itself. */
  kind: 'issue' | 'epic';
  /** Null for a bare `#12` or `12`, which names no repository. */
  owner: string | null;
  name: string | null;
  number: number;
  /** As the operator wrote it, for the unresolved report. */
  reference: string;
}

export interface ParsedInstruction {
  intent: SteeringIntent;
  /** True when the instruction restricts work to `targets` and nothing else. */
  exclusive: boolean;
  elseIntent: SteeringElseIntent;
  targets: ParsedTarget[];
  /**
   * Digit runs this parser refused to read as issue references.
   *
   * Reported rather than dropped: an operator who wrote `404` and expected
   * issue #404 must be able to see that it was not read, and the remedy
   * (`#404`) is in the note.
   */
  ignoredNumbers: number[];
  /**
   * True when this parse may be acted on with no model involved at all.
   *
   * False is NOT a failure. It is the signal that the instruction needs
   * interpretation, and the caller reports that as an outcome.
   */
  confident: boolean;
  /** Why the parse is not confident. Null when it is. */
  ambiguity: string | null;
  /** What the parser understood, in sentences an operator can check. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// The vocabulary
//
// Closed sets, like `INPUT_LABELS` is a closed set and for the same reason: an
// unrecognised verb must make the parse UNCONFIDENT and reach the
// interpretation path, not be silently treated as one of the known ones.
// ---------------------------------------------------------------------------

/** Verbs that mean "let the factory work on this". */
const READY_VERBS: ReadonlySet<string> = new Set([
  'work',
  'working',
  'do',
  'run',
  'start',
  'dispatch',
  'release',
  'resume',
  'unhold',
  'unblock',
  'ready',
  'focus',
  'prioritize',
  'prioritise',
  'build',
  'tackle',
]);

/** Verbs that mean "stop acting on this". */
const HOLD_VERBS: ReadonlySet<string> = new Set([
  'hold',
  'pause',
  'stop',
  'halt',
  'freeze',
  'park',
  'suspend',
]);

/** Words that make an instruction restrictive rather than additive. */
const EXCLUSIVE_WORDS: ReadonlySet<string> = new Set([
  'only',
  'just',
  'exclusively',
  'solely',
]);

/** Nouns that introduce a list of numbers. */
const SCOPE_NOUNS: ReadonlySet<string> = new Set([
  'issue',
  'issues',
  'epic',
  'epics',
  'number',
  'numbers',
  'item',
  'items',
  'ticket',
  'tickets',
]);

/**
 * Words that neither arm nor disarm.
 *
 * They sit BETWEEN a scope word and its list — `work on THE issues 1, 2 AND 3`
 * — so treating them as ordinary words would disarm the run and lose every
 * number in it.
 */
const FILLERS: ReadonlySet<string> = new Set([
  'the',
  'a',
  'an',
  'and',
  'to',
  'of',
  'for',
  'on',
  'please',
  'all',
  'these',
  'those',
  'them',
  'my',
  'our',
  'in',
  'at',
  'is',
  'are',
  'be',
  'up',
  'with',
]);

/** "everything else", "the rest", "all others", "nothing else". */
const ELSE_PHRASES: readonly RegExp[] = [
  /\b(?:everything|anything|all)\s+else\b/,
  /\bthe\s+rest\b/,
  /\ball\s+(?:the\s+)?others?\b/,
  /\bnothing\s+else\b/,
];

/**
 * One token. `ref` is `#12` or `owner/name#12`; `number` is a bare digit run.
 *
 * Ordered alternatives matter: the `ref` branch is first so that the `#` form
 * is never split into a stray symbol and a bare number, which would drop the
 * repository qualifier and make `acme/app#12` resolve against the wrong
 * repository.
 */
const TOKEN =
  /(?:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+))?#(\d+)|(\d+)|([A-Za-z][A-Za-z'’-]*)|([,&])/g;

export function parseSteeringInstruction(
  instruction: string,
): ParsedInstruction {
  const text = instruction.toLowerCase();

  const targets: ParsedTarget[] = [];
  const ignoredNumbers: number[] = [];
  const notes: string[] = [];

  let armed = false;
  let leadKind: 'issue' | 'epic' = 'issue';
  let sawReady = false;
  let sawHold = false;
  let sawExclusiveWord = false;

  // `lastIndex` is reset because the regex is module-scoped and global; a
  // shared /g regex that keeps its cursor between calls is the classic way for
  // the second invocation of a pure function to disagree with the first.
  TOKEN.lastIndex = 0;

  for (let match = TOKEN.exec(text); match !== null; match = TOKEN.exec(text)) {
    const [raw, owner, name, refNumber, bareNumber, word, separator] = match;

    if (refNumber !== undefined) {
      targets.push({
        kind: leadKind,
        owner: owner ?? null,
        name: name ?? null,
        number: Number(refNumber),
        reference: raw,
      });
      // A reference is self-arming: `#12 #13 #14` is a list, and the second
      // and third are no less explicit than the first.
      armed = true;
      continue;
    }

    if (bareNumber !== undefined) {
      const value = Number(bareNumber);
      if (armed) {
        targets.push({
          kind: leadKind,
          owner: null,
          name: null,
          number: value,
          reference: bareNumber,
        });
      } else {
        ignoredNumbers.push(value);
      }
      continue;
    }

    if (separator !== undefined) continue; // Commas do not break a run.

    if (word === undefined) continue;

    if (READY_VERBS.has(word)) sawReady = true;
    if (HOLD_VERBS.has(word)) sawHold = true;
    if (EXCLUSIVE_WORDS.has(word)) sawExclusiveWord = true;

    if (word === 'epic' || word === 'epics') {
      leadKind = 'epic';
      armed = true;
      continue;
    }

    if (
      READY_VERBS.has(word) ||
      HOLD_VERBS.has(word) ||
      EXCLUSIVE_WORDS.has(word) ||
      SCOPE_NOUNS.has(word)
    ) {
      leadKind = 'issue';
      armed = true;
      continue;
    }

    if (FILLERS.has(word)) continue;

    // Anything else is prose, and prose ends a list.
    armed = false;
    leadKind = 'issue';
  }

  const sawElsePhrase = ELSE_PHRASES.some((pattern) => pattern.test(text));

  // -------------------------------------------------------------------------
  // Intent
  // -------------------------------------------------------------------------

  let intent: SteeringIntent = 'ready';
  let ambiguity: string | null = null;

  if (sawReady && sawHold) {
    if (sawElsePhrase) {
      // "only work on 1, 2 and 3 and hold everything else" — the canonical
      // two-verb form. The hold belongs to the else-clause, not to the targets.
      intent = 'ready';
    } else {
      ambiguity =
        'The instruction names both a release verb and a hold verb with no ' +
        '"everything else" clause for the hold to attach to, so which issues ' +
        'are to be held cannot be decided without interpretation.';
    }
  } else if (sawHold) {
    intent = 'hold';
  } else if (sawReady) {
    intent = 'ready';
  } else if (!sawExclusiveWord) {
    ambiguity =
      'The instruction names no verb this parser recognises, so whether the ' +
      'issues it names should be worked on or held cannot be decided without ' +
      'interpretation.';
  }

  if (targets.length === 0 && ambiguity === null) {
    ambiguity =
      'The instruction names no issue or epic number. Write a number as ' +
      '`#419` (or `owner/name#419`) to name one without interpretation.';
  }

  // -------------------------------------------------------------------------
  // Exclusivity
  // -------------------------------------------------------------------------

  let exclusive = sawExclusiveWord || sawElsePhrase;
  const elseIntent: SteeringElseIntent =
    sawElsePhrase && sawHold ? 'hold' : 'unready';

  if (exclusive && intent === 'hold') {
    // "only hold 1, 2 and 3" restricts nothing: holding three issues says
    // nothing about the others, and reading "only" as "un-ready the rest"
    // would invent a destructive clause the operator did not write. The
    // narrow reading is the recoverable one.
    exclusive = false;
    notes.push(
      'Read as a hold on the named issues only. A restrictive word next to a ' +
        'hold verb does not un-ready anything else — that would be a second, ' +
        'destructive instruction the sentence does not contain.',
    );
  }

  const confident = ambiguity === null && targets.length > 0;

  if (confident) {
    notes.push(
      exclusive
        ? `Read as: work exclusively on the named issues, and ${
            elseIntent === 'hold'
              ? `apply ${INPUT_LABELS.HOLD} to`
              : `remove ${INPUT_LABELS.READY} from`
          } every other issue currently marked ${INPUT_LABELS.READY}.`
        : intent === 'hold'
          ? `Read as: apply ${INPUT_LABELS.HOLD} to the named issues. Nothing else is touched.`
          : `Read as: apply ${INPUT_LABELS.READY} to the named issues. Nothing else is touched.`,
    );
  }

  for (const value of ignoredNumbers) {
    notes.push(
      `The number ${value} was not read as an issue reference — it is not in a ` +
        `list introduced by a scope word. Write \`#${value}\` to name issue ${value}.`,
    );
  }

  return {
    intent,
    exclusive,
    elseIntent,
    targets: dedupe(targets),
    ignoredNumbers,
    confident,
    ambiguity,
    notes,
  };
}

/**
 * Drop repeats, keeping the FIRST spelling.
 *
 * `#12 and issue 12` is one issue named twice, and two operations against one
 * issue would double-count the blast radius — the number the operator reads
 * before confirming a destructive change.
 */
function dedupe(targets: ParsedTarget[]): ParsedTarget[] {
  const seen = new Set<string>();
  const kept: ParsedTarget[] = [];

  for (const target of targets) {
    const key = `${target.kind}:${target.owner ?? ''}/${target.name ?? ''}#${target.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(target);
  }

  return kept;
}
