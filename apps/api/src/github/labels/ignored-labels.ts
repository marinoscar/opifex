/**
 * The routing-label vocabularies (`needs:`, `tier:`), and the classification
 * that makes an ignored declaration audible.
 *
 * ## Why these live here and not next to the code that reads them
 *
 * `issue-projection.ts` owns what a `needs:` or `tier:` label MEANS to a work
 * order. This file owns what the label vocabulary IS. Those were the same
 * thing until #297, and could not stay that way: the projection resolves a
 * label into a value and the read boundary has to classify the same label as
 * understood or not, and two copies of the vocabulary would eventually
 * disagree — reporting a perfectly valid `tier:standard` as a typo, or
 * staying silent about a real one. A single source of truth is the only
 * version of this that cannot rot.
 *
 * The `import type` from `runners/` is erased at compile time, so this
 * introduces no runtime edge from `github/` into the runner layer.
 *
 * ## Three families, one rule
 *
 * Routing input reaches an issue through three label prefixes:
 *
 *  - `factory:` — human intent, a CLOSED set of three (`factory-labels.ts`)
 *  - `needs:`   — runner capability requirements (#64)
 *  - `tier:`    — which class of model the work wants (#273)
 *
 * All three fail the same way and for the same good reason: an unrecognised
 * value is IGNORED rather than rejected, because a spelling mistake must not
 * cost a work order. #273 settled the harder case too — two contradictory
 * `tier:` labels mean no tier, because picking the largest spends money
 * nobody asked for and picking the smallest can park an order forever behind
 * a constraint nobody chose.
 *
 * That behaviour is right and #297 does not change it. What #297 changes is
 * that ignoring is no longer SILENT: the offending labels are classified here
 * and carried on `NormalizedIssue`, and the projection turns a non-empty list
 * into the `factory/label-ignored` mirror label.
 *
 * ## Why a mirror label rather than a comment
 *
 * A comment was the tempting channel, and `SpecFeedbackExecutor` is the
 * mechanism that already exists — but it dedupes on the BODY DIGEST, and a
 * label change does not change the body. The first mistake would be reported
 * and a repeat, or the same one after a body edit, met with silence. That is
 * worse than never reporting, because it teaches that silence means accepted.
 *
 * A mirror label sidesteps the problem entirely because a label is STATE
 * rather than an event. The projection recomputes from scratch every tick and
 * the diff engine adds what is missing and removes what is stale, so:
 *
 *  - a bad label is reported once, then the add is a no-op every tick after
 *  - correcting the label REMOVES the report, with no bookkeeping anywhere
 *  - making the same mistake again is a fresh fact and reports again
 *
 * No new table, no digest, no dedupe key at all: the dedupe key is the label
 * itself, compared against what GitHub already has.
 *
 * ## Why one label and not one per family
 *
 * A single `factory/label-ignored` cannot say WHICH label was wrong, and that
 * was the strongest objection to this channel. It is survivable here for a
 * reason specific to this failure: the offender is a LABEL, so it is sitting
 * in the same label list, two inches away, and an issue carrying
 * `tier:small`, `tier:large` and `factory/label-ignored` is self-explanatory
 * in a way a rejected spec never is. The precise finding — family, kind and
 * the exact offending names — is carried on the projection's `reason` and the
 * action evidence, which is where #47 already puts "why did Opifex do that".
 *
 * The alternative, a label per family per kind, would grow the mirror
 * vocabulary from four to ten for a distinction the issue's own label list
 * already makes.
 */

import type { ModelTier, RunnerNeed } from '../../runners/runner.types';
import { INPUT_LABEL_PREFIX, isInputLabel } from './factory-labels';

/** Runner capability requirements (#64). */
export const NEEDS_LABEL_PREFIX = 'needs:';

/** Which class of model the work wants (#273). */
export const TIER_LABEL_PREFIX = 'tier:';

/**
 * The recognised `needs:` labels.
 *
 * Keyed by the lower-cased label name, because GitHub label names are
 * case-preserving and an operator who typed `Needs:Cost-Reporting` meant the
 * same thing. Reporting that as a typo would be pedantry with a cost.
 */
export const NEEDS_BY_LABEL: Record<string, RunnerNeed> = {
  'needs:full-streaming': 'full-streaming',
  'needs:cost-reporting': 'cost-reporting',
  'needs:structured-rate-limits': 'structured-rate-limits',
  'needs:own-infrastructure': 'own-infrastructure',
};

/** The recognised `tier:` labels, lower-cased for the same reason. */
export const MODEL_TIER_BY_LABEL: Record<string, ModelTier> = {
  'tier:small': 'small',
  'tier:standard': 'standard',
  'tier:large': 'large',
};

/**
 * One declaration the factory could not act on.
 *
 * Data rather than a formatted string, because it has two audiences with
 * opposite needs: the projection renders it into a `reason` a human reads,
 * and a test asserts on the finding without depending on wording.
 */
export interface IgnoredLabel {
  /** The family: `factory:`, `needs:` or `tier:`. */
  prefix: string;
  kind: IgnoredLabelKind;
  /**
   * The offending label names, exactly as they appear on the issue, sorted.
   *
   * Sorted because the diff engine requires identical inputs to produce an
   * identical action list — an unstable order here would make two otherwise
   * identical ticks diff against each other.
   */
  labels: string[];
}

export type IgnoredLabelKind =
  /** A value in a known family that is not one the factory understands. */
  | 'unrecognised'
  /** Two mutually exclusive declarations in the same family. */
  | 'contradiction';

/**
 * Classify every routing label the factory will not act on.
 *
 * Pure, and takes label NAMES rather than a `NormalizedIssue`, so it can run
 * at the read boundary before a normalized issue exists. Mirror labels must
 * already be filtered out by the caller: `factory/` is Opifex's own output
 * and classifying it as human input would be the feedback loop VISION §3.3
 * forbids.
 *
 * Returns an empty array for the overwhelmingly common case, so a caller can
 * treat non-empty as "there is something to say".
 */
export function classifyIgnoredLabels(labelNames: string[]): IgnoredLabel[] {
  const found: IgnoredLabel[] = [];

  // `factory:` — a closed set of three human intents. Anything else is a typo
  // and always has been (`isUnknownInputLabel`); until #297 the finding was
  // recorded on `unknownInputLabels` and read by nothing at all.
  const unknownFactory = labelNames.filter(
    (name) => name.startsWith(INPUT_LABEL_PREFIX) && !isInputLabel(name),
  );
  if (unknownFactory.length > 0) {
    found.push(unrecognised(INPUT_LABEL_PREFIX, unknownFactory));
  }

  // `needs:` — a set, so several are perfectly valid and only unrecognised
  // values are a problem. There is no contradiction to detect: asking for
  // both streaming and cost reporting is a coherent request.
  const unknownNeeds = labelNames.filter(
    (name) =>
      name.toLowerCase().startsWith(NEEDS_LABEL_PREFIX) &&
      NEEDS_BY_LABEL[name.toLowerCase()] === undefined,
  );
  if (unknownNeeds.length > 0) {
    found.push(unrecognised(NEEDS_LABEL_PREFIX, unknownNeeds));
  }

  // `tier:` — at most one. Both failure modes are possible and they are
  // reported separately, because they call for different corrections: a typo
  // is fixed by retyping, a contradiction by removing one of two labels.
  const tierLabels = labelNames.filter((name) =>
    name.toLowerCase().startsWith(TIER_LABEL_PREFIX),
  );
  const unknownTiers = tierLabels.filter(
    (name) => MODEL_TIER_BY_LABEL[name.toLowerCase()] === undefined,
  );
  if (unknownTiers.length > 0) {
    found.push(unrecognised(TIER_LABEL_PREFIX, unknownTiers));
  }

  const declaredTiers = tierLabels.filter(
    (name) => MODEL_TIER_BY_LABEL[name.toLowerCase()] !== undefined,
  );
  // By VALUE, not by label: `tier:small` and `Tier:Small` are one declaration
  // said twice, which is not a contradiction and must not read as one.
  const distinctTiers = new Set(
    declaredTiers.map((name) => MODEL_TIER_BY_LABEL[name.toLowerCase()]),
  );
  if (distinctTiers.size > 1) {
    found.push({
      prefix: TIER_LABEL_PREFIX,
      kind: 'contradiction',
      labels: [...declaredTiers].sort(),
    });
  }

  return found;
}

function unrecognised(prefix: string, labels: string[]): IgnoredLabel {
  return { prefix, kind: 'unrecognised', labels: [...labels].sort() };
}

/**
 * The findings as one clause, for a projection `reason`.
 *
 * Names the offending labels rather than saying "a routing label was wrong",
 * because #47 requires a reviewer be able to reconstruct the decision from
 * the log entry alone. It also states the consequence — the default applies —
 * since the whole complaint in #297 is that the operator believes they set
 * something they did not.
 */
export function describeIgnoredLabels(ignored: IgnoredLabel[]): string {
  const clauses = ignored.map((finding) =>
    finding.kind === 'contradiction'
      ? `${finding.labels.join(' and ')} contradict each other`
      : `${finding.labels.join(', ')} ${finding.labels.length > 1 ? 'are' : 'is'} not a recognised ${finding.prefix} label`,
  );

  return `ignored labels: ${clauses.join('; ')} — the default applies`;
}
