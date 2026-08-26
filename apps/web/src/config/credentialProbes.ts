/**
 * The Test buttons, and what makes one of their answers go stale
 * (#349, epic #332).
 *
 * ## A probe result is an OBSERVATION, not a stored setting
 *
 * This is the distinction the section is built around, and it is the same one
 * epic #332's first rule states: configured and observed are never merged. A
 * saved value is a fact about what this deployment will do next. A probe
 * result is a fact about what happened when somebody pressed a button at
 * 14:32 — and the moment the value it tested changes, it stops describing
 * the deployment and starts describing its past. It is still worth showing
 * (a token that worked five minutes ago is evidence), but showing it as
 * CURRENT would be the screen making a claim nobody checked.
 *
 * So every observation carries a WITNESS: a fingerprint of the settings its
 * answer depended on, sampled when it ran. `probeFreshness` compares that
 * against the document on screen now. Nothing here infers staleness from a
 * clock — an answer does not become wrong after ten minutes, it becomes wrong
 * when the configuration under it moves.
 *
 * ## Why this file names setting keys, when #348 forbade it
 *
 * `config/operatorSettings.ts` renders the Configuration section from the
 * response alone, so a key added to the backend registry needs no frontend
 * change. That property cannot hold here, and the reason is worth stating
 * rather than quietly breaking: **the API does not publish which settings a
 * probe reads.** `PROBE_NAMES` is a closed vocabulary, but the edge from
 * `claude-credential` to `runners.claudeCodeLocal.oauthToken` exists only in
 * `operator-probes.service.ts`. Guessing it from key names would be worse
 * than declaring it.
 *
 * The declaration degrades safely in both directions: a probe whose subject
 * key is not in the response renders nothing, and a secret with no probe
 * renders a card with no Test button rather than an empty panel — which is
 * how a credential added later behaves until somebody writes a probe for it.
 */

import type { OperatorProbeName } from '../types/operatorProbes';
import type { OperatorProbeOutcome } from '../services/api';
import type { OperatorSetting } from '../types/operatorSettings';

export interface ProbeDescriptor {
  name: OperatorProbeName;
  /** The setting whose card this button belongs on. */
  subject: string;
  /** The button's text. */
  label: string;
  /** What pressing it actually does. Never "checks the credential". */
  question: string;
  /**
   * Every setting key whose value the answer depends on — including ones
   * that are not the subject, because a GitHub token probe against a wrong
   * base URL is not a fact about the token.
   */
  dependsOn: readonly string[];
  /** Spends real quota and real money on every press. */
  spends: boolean;
  /** What it costs, in the operator's terms. Null when it costs nothing. */
  costNote: string | null;
}

/**
 * The probes this section offers, and what each one is really asking.
 *
 * `git` is deliberately absent: it tests a binary rather than a credential,
 * and the Readiness section already asks it as step 1. `claude-cli` IS here,
 * next to the Claude credential, precisely because its green tick is the
 * deceptive one — `claude --version` succeeds with no credential at all, so
 * the pair of buttons on that card is the finding epic #324 documented,
 * rendered as two separate questions.
 */
export const CREDENTIAL_PROBES: readonly ProbeDescriptor[] = [
  {
    name: 'github-token',
    subject: 'github.token',
    label: 'Test token',
    question:
      'Reads GET /rate_limit with the configured token, which every valid ' +
      'token can reach and which GitHub does not charge against the budget ' +
      'it reports.',
    dependsOn: ['github.token', 'github.apiBaseUrl'],
    spends: false,
    costNote: null,
  },
  {
    name: 'github-repo',
    subject: 'github.token',
    label: 'Test repository access',
    question:
      'Reads a registered repository with the same token — the check that ' +
      'catches a fine-grained token that is valid and does not cover that ' +
      'repository.',
    dependsOn: ['github.token', 'github.apiBaseUrl'],
    spends: false,
    costNote: null,
  },
  {
    name: 'claude-cli',
    subject: 'runners.claudeCodeLocal.oauthToken',
    label: 'Test the binary',
    question:
      'Runs claude --version. It says the binary is installed and runnable, ' +
      'and it says NOTHING about the credential — it succeeds with no ' +
      'credential at all, which is how an unauthenticated CLI registers as a ' +
      'healthy runner and then fails every run at auth.',
    dependsOn: ['runners.claudeCodeLocal.binary'],
    spends: false,
    costNote: null,
  },
  {
    name: 'claude-credential',
    subject: 'runners.claudeCodeLocal.oauthToken',
    label: 'Test the credential (spends quota)',
    question:
      'Runs a real, minimal, non-interactive claude --print. Nothing short ' +
      'of a real invocation distinguishes a working credential from a CLI ' +
      'that only answers --version.',
    dependsOn: [
      'runners.claudeCodeLocal.oauthToken',
      'runners.claudeCodeLocal.binary',
    ],
    spends: true,
    costNote:
      'This spends real quota and real money: it is one billed model call ' +
      'against the same Claude account a dispatched run uses.',
  },
  {
    name: 'supervisor-model',
    subject: 'supervisor.model.apiKey',
    label: 'Test the key (spends money)',
    question:
      'Makes one minimal Anthropic call through the supervisor’s own ' +
      'adapter, capped at four output tokens. It also catches a key that is ' +
      'set while no model name is, which otherwise records a failure once an ' +
      'hour with nobody looking.',
    dependsOn: ['supervisor.model.apiKey', 'supervisor.model.name'],
    spends: true,
    costNote:
      'This spends real money: a billed Anthropic API call on the ' +
      'separately metered supervisor key (ADR-0015).',
  },
];

/** The probes that belong on one setting's card, in declaration order. */
export function probesForSetting(key: string): ProbeDescriptor[] {
  return CREDENTIAL_PROBES.filter((probe) => probe.subject === key);
}

// ---------------------------------------------------------------------------
// Witnesses and staleness
// ---------------------------------------------------------------------------

/**
 * One setting, fingerprinted as far as a probe can tell it apart.
 *
 * A secret's value is not available and must never be — so the fingerprint
 * is made of `configured`, `source`, `hint` and `updatedAt`, which is exactly
 * the set of things that change when a credential is rotated or cleared. That
 * is enough: replacing a token with a DIFFERENT token moves `updatedAt` and
 * the hint, and replacing it with the same one moves `updatedAt` anyway.
 *
 * A key the response does not carry fingerprints as `absent`, so a key that
 * appears or disappears between two reads also stales an answer that depended
 * on it.
 */
export function settingWitness(entry: OperatorSetting | undefined): string {
  if (!entry) return 'absent';

  if (entry.secret) {
    return [
      'secret',
      String(entry.configured),
      entry.source,
      entry.hint ?? '',
      entry.updatedAt ?? '',
    ].join('|');
  }

  return [
    'plain',
    JSON.stringify(entry.value),
    entry.source,
    entry.updatedAt ?? '',
  ].join('|');
}

/** The configuration one probe's answer depended on, as one string. */
export function probeWitness(
  descriptor: ProbeDescriptor,
  settings: readonly OperatorSetting[],
): string {
  return descriptor.dependsOn
    .map((key) => {
      const entry = settings.find((candidate) => candidate.key === key);
      return `${key}=${settingWitness(entry)}`;
    })
    .join('&');
}

/** One probe answer, and the configuration it was an answer about. */
export interface ProbeObservation {
  probe: OperatorProbeName;
  outcome: OperatorProbeOutcome;
  /** `probeWitness` at the moment the probe ran. */
  witness: string;
}

export type ProbeFreshness =
  { state: 'current' } | { state: 'stale'; reason: string };

/**
 * Is this answer still about the deployment as it stands?
 *
 * Two ways it is not, and they are different sentences because they are
 * different situations for the operator:
 *
 *  - The SAVED configuration moved underneath it. The answer describes a
 *    value that is no longer in force.
 *  - There is an unsaved edit on screen. The answer still describes what is
 *    stored — but not what the operator is about to store, which is what
 *    they are looking at the field for.
 *
 * Neither hides the result. A stale observation is still the last thing
 * anybody actually measured, and deleting it would replace evidence with
 * nothing.
 */
export function probeFreshness(
  observation: ProbeObservation,
  settings: readonly OperatorSetting[],
  pendingKeys: readonly string[] = [],
): ProbeFreshness {
  const descriptor = CREDENTIAL_PROBES.find(
    (candidate) => candidate.name === observation.probe,
  );

  // A probe this build does not declare cannot have its dependencies checked,
  // and claiming freshness for it would be the one thing this module exists
  // not to do.
  if (!descriptor) {
    return {
      state: 'stale',
      reason:
        'This build does not know what configuration that probe reads, so ' +
        'it cannot say whether the answer still applies.',
    };
  }

  if (probeWitness(descriptor, settings) !== observation.witness) {
    return {
      state: 'stale',
      reason:
        'The configuration this tested has changed since it ran. The result ' +
        'below describes the previous value, not the one in force now.',
    };
  }

  const pending = descriptor.dependsOn.filter((key) =>
    pendingKeys.includes(key),
  );

  if (pending.length > 0) {
    return {
      state: 'stale',
      reason:
        `There is an unsaved change to ${pending.join(', ')} on this screen. ` +
        'The result below is about the value that is stored, not the one you ' +
        'are about to save.',
    };
  }

  return { state: 'current' };
}

// ---------------------------------------------------------------------------
// The allowance on the two probes that spend
// ---------------------------------------------------------------------------

/**
 * "3 of 5 left in this window, resets in about 47 minutes."
 *
 * Built entirely from what the API reported. The limit and the window are the
 * server's policy and this screen has no independent knowledge of either, so
 * before the first result it says it does not know rather than printing a
 * number it would be guessing.
 */
export function rateLimitSentence(rateLimit: {
  limit: number;
  windowSeconds: number;
  remaining: number;
  resetSeconds: number;
}): string {
  return (
    `${rateLimit.remaining} of ${rateLimit.limit} left in this ` +
    `${formatDuration(rateLimit.windowSeconds)} window, resetting in ` +
    `${formatDuration(rateLimit.resetSeconds)}.`
  );
}

/** Seconds as something an operator reads: "45 seconds", "47 minutes". */
export function formatDuration(seconds: number): string {
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? '1 hour' : `${hours} hours`;
}
