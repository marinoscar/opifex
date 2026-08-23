/**
 * The event vocabulary, in the operator's words rather than the wire's.
 *
 * Shared between the dashboard's activity feed and a run's own timeline (#83),
 * because two renderings of the same six types that drifted apart would be
 * worse than one: an operator comparing a feed row against a timeline row would
 * be comparing two different claims about one event.
 *
 * ## `source` is rendered, always, and that is not decoration
 *
 * VISION §9:
 *
 * > Every event carries a `source` field distinguishing runner-reported from
 * > git-derived from control-plane-synthesized. **A synthesized event must
 * > never masquerade as a report.**
 *
 * Two independent liveness sources only buy anything if the operator can tell
 * which one spoke. An operator debugging a false stall needs to know whether
 * the runner SAID it was blocked or Opifex INFERRED it, and those two lead to
 * opposite actions.
 */

import type { RunEventSource, RunEventType } from '../types/cockpit';

/** VISION §9's own vocabulary, reused verbatim. */
export const EVENT_SOURCE_LABELS: Record<RunEventSource, string> = {
  runner: 'runner-reported',
  git: 'git-derived',
  'control-plane': 'control-plane-synthesized',
};

/**
 * One line on what each source means, for a tooltip.
 *
 * The distinction the operator actually acts on: a claim the runner made about
 * itself, a fact derived from the repository, or a conclusion Opifex reached.
 */
export const EVENT_SOURCE_DESCRIPTIONS: Record<RunEventSource, string> = {
  runner: 'The runner reported this about itself.',
  git: 'Derived from the repository — the runner did not say it.',
  'control-plane':
    'Opifex concluded this. No runner reported it, and it is not a fact from git.',
};

/**
 * How each source is drawn, so the three are distinguishable at a glance.
 *
 * Colour is never the only signal — each also carries its label — because a
 * distinction that exists only in hue is one an operator with a colour-vision
 * deficiency does not have. Grey for a synthesized event on purpose: it is the
 * one that must not look like a report.
 */
export const EVENT_SOURCE_COLORS: Record<
  RunEventSource,
  'primary' | 'info' | 'default'
> = {
  runner: 'primary',
  git: 'info',
  'control-plane': 'default',
};

/**
 * Event type as a short human phrase.
 *
 * The wire form (`run.blocked`) is kept out of the row on purpose: it is a
 * protocol identifier, and six of them stacked in a column read as noise. A
 * type is NOT a status — `types/cockpit.ts` explains why those vocabularies are
 * held apart — so it deliberately does not render through `StatusChip`.
 */
export const EVENT_TYPE_LABELS: Record<RunEventType, string> = {
  'run.started': 'Started',
  'run.heartbeat': 'Heartbeat',
  'run.progress': 'Progress',
  'run.blocked': 'Blocked',
  'run.completed': 'Completed',
  'run.failed': 'Failed',
};
