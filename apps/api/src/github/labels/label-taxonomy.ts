/**
 * The declared label taxonomy, with the two fields the API needs and did not
 * have: **colour and description** (#415).
 *
 * ## Why this is in TypeScript and not read from `.github/labels.yml`
 *
 * `factory-labels.ts` owns the vocabulary — the names, and the `:` vs `/` rule
 * that keeps input labels and mirror labels from ever being confusable.
 * `.github/labels.yml` owned everything else, and that was fine for as long as
 * the only thing that applied the taxonomy was `scripts/sync-labels.mjs`,
 * which runs from a repository checkout.
 *
 * #415 needs the API to create these labels when a repository is registered,
 * and the API runs in a container. Shipping the YAML into the image was the
 * obvious alternative and is rejected: `apps/api/scripts` went missing from
 * the production image in #382 in exactly that way, and the failure was
 * silent. A taxonomy that empties itself in production — registering a
 * repository, creating nothing, reporting success — is strictly worse than one
 * that cannot compile. Declared in code, the set is a build-time artefact and
 * cannot go missing.
 *
 * `.github/labels.yml` stays as the human-facing and developer-CLI copy, and
 * `label-taxonomy.spec.ts` asserts the two agree **in both directions**: an
 * entry here missing from the file, or a control-loop entry in the file
 * missing here, is a failing test rather than an API and a CLI that provision
 * different sets.
 *
 * ## Which labels the API provisions, and which it deliberately does not
 *
 * `.github/labels.yml` declares 40 labels. Three kinds of them are the control
 * loop's own vocabulary and are provisioned:
 *
 *  - **input** (`factory:*`) — the operator's control surface. Missing, the
 *    repository cannot be steered at all: `projectIssue()` skips every issue
 *    without `factory:ready`, and GitHub's label picker only offers labels
 *    that exist.
 *  - **mirror** (`factory/*`) — Opifex's own writes. GitHub would create a
 *    missing one on first write, but with a random colour and no description,
 *    which destroys the warm/cool palette that is the visual half of the
 *    `:` vs `/` guarantee.
 *  - **routing** (`needs:*`, `tier:*`) — obeyed, and describing the work
 *    rather than whether it happens (#303). Missing, work still runs, but
 *    only ever on the defaults.
 *
 * The rest — `bug`, `epic`, `feature`, `phase:*`, the component labels — are
 * ORGANISATIONAL CONVENTIONS OF THIS REPOSITORY. Nothing in the control loop
 * reads them, and writing somebody else's issue tracker a `phase:4` label
 * because they let Opifex watch their repository is presumptuous: it is
 * Opifex's roadmap, not theirs. So the boundary is explicit — `kindOf` derives
 * it from the prefix, `PROVISIONED_LABELS` contains only the three control-loop
 * kinds, and the spec asserts that no `other` label ever creeps in.
 *
 * The developer CLI still applies all 40, which is correct: it is run against
 * THIS repository by a human who wants this repository's conventions.
 */

import { INPUT_LABEL_PREFIX, MIRROR_LABEL_PREFIX } from './factory-labels';
import { NEEDS_LABEL_PREFIX, TIER_LABEL_PREFIX } from './ignored-labels';

/**
 * The kind a label belongs to, in the vocabulary `.github/labels.yml`'s header
 * and `scripts/sync-labels.mjs` already use.
 *
 * `other` is not a control-loop kind and is never provisioned — see the header.
 */
export type LabelKind = 'input' | 'mirror' | 'routing' | 'other';

/** The kinds the API provisions, in the order a report should present them. */
export const PROVISIONED_LABEL_KINDS = ['input', 'mirror', 'routing'] as const;

export type ProvisionedLabelKind = (typeof PROVISIONED_LABEL_KINDS)[number];

/** One label, completely: what GitHub needs to create it. */
export interface DeclaredLabel {
  readonly name: string;
  /** Six hex digits, lower case, no leading `#` — the form GitHub stores. */
  readonly color: string;
  /** At most 100 characters. GitHub answers 422 above that (#197). */
  readonly description: string;
  readonly kind: ProvisionedLabelKind;
}

/**
 * Which kind a label name belongs to. Derived from the prefix, never a list.
 *
 * The same classification `scripts/sync-labels.mjs`'s `labelKind` makes, and
 * for the same reasons: `factory` is matched case-sensitively and by its
 * SEPARATOR, because that is how the read boundary matches it, while
 * `needs:`/`tier:` are matched case-insensitively, because that is how
 * `NEEDS_BY_LABEL` and `MODEL_TIER_BY_LABEL` are looked up.
 */
export function kindOf(name: string): LabelKind {
  if (name.startsWith(MIRROR_LABEL_PREFIX)) return 'mirror';
  if (name.startsWith(INPUT_LABEL_PREFIX)) return 'input';

  const lower = name.toLowerCase();
  if (
    lower.startsWith(NEEDS_LABEL_PREFIX) ||
    lower.startsWith(TIER_LABEL_PREFIX)
  ) {
    return 'routing';
  }
  return 'other';
}

/**
 * The labels the API creates on a registered repository.
 *
 * Colours are the palette `.github/labels.yml`'s header explains: input warm
 * (you are steering the factory), mirror cool/grey (you are observing it),
 * routing green (you are describing the work itself). The distinction the
 * separator cannot carry — two of the three kinds use a colon — is carried
 * here, which is why colour is part of the taxonomy rather than decoration.
 *
 * Descriptions are the text GitHub shows in the label picker, and are
 * character-for-character the file's. That is the one place an operator reads
 * what a label MEANS at the moment they are about to apply it.
 */
export const PROVISIONED_LABELS: readonly DeclaredLabel[] = [
  // --- Input: Opifex OBEYS these (warm) ---------------------------------
  {
    name: 'factory:hold',
    color: 'b60205',
    description:
      'Human intent: stop the factory from acting on this issue. Obeyed by the reconciler.',
    kind: 'input',
  },
  {
    name: 'factory:ready',
    color: 'd93f0b',
    description:
      'Human intent: this issue is authorized for dispatch. Obeyed by the reconciler.',
    kind: 'input',
  },
  {
    name: 'factory:clear-quarantine',
    color: 'fbca04',
    description:
      'Human intent: release this issue/work order from quarantine. Obeyed by the reconciler.',
    kind: 'input',
  },

  // --- Mirror: Opifex WRITES these, never reads them as truth (cool) -----
  {
    name: 'factory/dispatched',
    color: '1d76db',
    description:
      'Mirror: a work order for this issue is currently running. Visibility only — do not hand-edit.',
    kind: 'mirror',
  },
  {
    name: 'factory/blocked',
    color: '5319e7',
    description:
      'Mirror: the run is parked — rate limit, stall, or approval. Visibility only.',
    kind: 'mirror',
  },
  {
    name: 'factory/review',
    color: '006b75',
    description:
      'Mirror: a pull request from this work order awaits review. Visibility only.',
    kind: 'mirror',
  },
  {
    name: 'factory/quarantine',
    color: '666666',
    description:
      'Mirror: quarantined after repeated failure. Visibility only — do not hand-edit.',
    kind: 'mirror',
  },
  {
    name: 'factory/label-ignored',
    color: '9e6a03',
    description:
      'Mirror: a needs:/tier:/factory: label was not understood and was ignored. Visibility only.',
    kind: 'mirror',
  },

  // --- Routing: obeyed, and about the WORK (green) -----------------------
  {
    name: 'needs:full-streaming',
    color: '1a7f37',
    description:
      'Routing input: the run must be observable per tool call. Matched against runner capability.',
    kind: 'routing',
  },
  {
    name: 'needs:cost-reporting',
    color: '1a7f37',
    description:
      'Routing input: the runner must report cost, or budget enforcement is meaningless.',
    kind: 'routing',
  },
  {
    name: 'needs:structured-rate-limits',
    color: '1a7f37',
    description:
      'Routing input: the runner must report rate limits structurally, so a park can carry a resume.',
    kind: 'routing',
  },
  {
    name: 'needs:own-infrastructure',
    color: '1a7f37',
    description:
      "Routing input: the work must not leave the operator's own infrastructure.",
    kind: 'routing',
  },
  {
    name: 'tier:small',
    color: '8fd9a8',
    description:
      'Routing input: prefer a small, cheap model class. At most one tier: label — two mean none.',
    kind: 'routing',
  },
  {
    name: 'tier:standard',
    color: '8fd9a8',
    description:
      'Routing input: prefer the standard model class. At most one tier: label — two mean none.',
    kind: 'routing',
  },
  {
    name: 'tier:large',
    color: '8fd9a8',
    description:
      'Routing input: prefer a large, costly model class. At most one tier: label — two mean none.',
    kind: 'routing',
  },
];

/** The declared names, for a fast membership test. */
export const PROVISIONED_LABEL_NAMES: ReadonlySet<string> = new Set(
  PROVISIONED_LABELS.map((label) => label.name),
);

/** GitHub's cap on a label description. Above it, 422 (#197). */
export const MAX_LABEL_DESCRIPTION_LENGTH = 100;

/**
 * Every way this declaration could be one GitHub will not accept.
 *
 * Pure, and returning ALL the problems rather than the first, because #197's
 * lesson was that discovering them one round trip at a time leaves a
 * half-applied taxonomy — the worst of the possible states, since the drift
 * report shrinks and nothing says the run did not finish. The spec runs this
 * over `PROVISIONED_LABELS` so a bad entry fails CI rather than a repository.
 */
export function validateDeclaration(
  labels: readonly DeclaredLabel[],
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const label of labels) {
    if (seen.has(label.name)) {
      problems.push(`${label.name}: declared more than once`);
    }
    seen.add(label.name);

    if (label.description.length > MAX_LABEL_DESCRIPTION_LENGTH) {
      problems.push(
        `${label.name}: description is ${label.description.length} characters, ` +
          `and GitHub allows ${MAX_LABEL_DESCRIPTION_LENGTH}`,
      );
    }
    if (!/^[0-9a-f]{6}$/.test(label.color)) {
      problems.push(
        `${label.name}: color '${label.color}' is not six lower-case hex digits`,
      );
    }
    if (kindOf(label.name) !== label.kind) {
      problems.push(
        `${label.name}: declared as '${label.kind}' but its prefix says '${kindOf(label.name)}'`,
      );
    }
  }

  return problems;
}
