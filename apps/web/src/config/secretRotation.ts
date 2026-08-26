/**
 * Writing a credential, and what saving one does NOT do (#349, epic #332).
 *
 * ## The value never becomes state
 *
 * `SettingsDraft` holds what every non-secret control holds, and `buildPatch`
 * skips secrets outright. That is not a gap this issue fills in — it is the
 * rule this module keeps. What is drafted for a secret is an INTENT
 * (`replace` or `clear`) and nothing else; the value itself lives only in the
 * uncontrolled input the operator typed it into, is read once by a callback at
 * submit time, and goes straight into the request body.
 *
 * That is the difference between a credential that exists in the DOM for as
 * long as a field is open and one that exists in a React state object which
 * anything may spread, log, serialise into a devtools snapshot, or hand to an
 * error reporter along with the rest of a component's props. The first is
 * unavoidable for a field somebody types into. The second is a choice, and
 * this is it being declined.
 *
 * ## Saving is not revoking, and the screen has to say so
 *
 * The API stores a credential. It does not, and cannot, tell GitHub or
 * Anthropic that the previous one should stop working. An operator who has
 * just replaced a leaked token and sees "Saved" has been told something true
 * and has heard something false, and for a leaked token that gap is the whole
 * incident. So a save reports what actually happened and names the step that
 * has not been taken.
 */

import type {
  OperatorSettingsPatch,
  SecretOperatorSetting,
} from '../types/operatorSettings';

/** What the operator means to do to a stored credential. */
export type SecretIntent = { kind: 'replace' } | { kind: 'clear' };

/** Keyed by setting key. Absent means this credential is untouched. */
export type SecretIntents = Record<string, SecretIntent>;

export interface SecretWriteOk {
  ok: true;
  /** The one-key body. Built at submit time and not held anywhere. */
  patch: OperatorSettingsPatch;
}

export interface SecretWriteProblem {
  ok: false;
  problem: string;
}

/**
 * The single-key patch for one credential, or why it cannot be sent.
 *
 * `readValue` is a callback rather than a parameter on purpose: the caller
 * reads its own input element inside it, so the value is created at the moment
 * it is needed and is referenced exactly once. A `value: string` parameter
 * would put the credential in whatever variable the caller kept it in, which
 * is the thing this module's header is about.
 *
 * One key per request, never merged with a ceiling change, because a secret
 * write additionally needs `operator_settings:write_secret`: a combined patch
 * would fail the ceiling edit as well for an operator who holds only
 * `system_settings:write`, and the API applies keys in sequence rather than
 * in one transaction.
 */
export function buildSecretWrite(
  entry: SecretOperatorSetting,
  intent: SecretIntent,
  readValue: () => string,
): SecretWriteOk | SecretWriteProblem {
  if (intent.kind === 'clear') {
    if (entry.source !== 'database') {
      return {
        ok: false,
        problem:
          `Nothing is stored here for ${entry.key}, so there is nothing to ` +
          `clear — it already reads from ${entry.envVar}.`,
      };
    }
    // JSON null: delete the row. The key then resolves to whatever the
    // environment says, and only to the code's default if it says nothing.
    return { ok: true, patch: { [entry.key]: null } };
  }

  const value = readValue();

  if (value === '') {
    return {
      ok: false,
      problem:
        'This needs a value. To stop overriding it and fall back to ' +
        `${entry.envVar}, use "Clear" instead of saving an empty field.`,
    };
  }

  // Deliberately NOT trimmed. A credential is an opaque string, and silently
  // altering one produces a stored value that does not match what the
  // operator pasted — which then fails at the service with no explanation
  // this screen could give.
  return { ok: true, patch: { [entry.key]: value } };
}

// ---------------------------------------------------------------------------
// What a save did not do
// ---------------------------------------------------------------------------

export interface RotationNotice {
  /** The alert's heading. Says the thing that is easy to assume wrongly. */
  title: string;
  /** The full explanation, shown after a successful save. */
  body: string;
  /** The short version, shown beside the field before saving. */
  caution: string;
}

/**
 * The generic truth about rotating any credential stored here.
 *
 * Applies to a secret key that arrives in the registry later and that nobody
 * has written a specific notice for — which is the case that must not fall
 * through to silence, since silence is exactly the "Saved, therefore the old
 * one is dead" reading.
 */
const GENERIC_NOTICE: RotationNotice = {
  title: 'The previous credential has not been revoked',
  body:
    'Saving stores the new credential here and nothing more. The service ' +
    'that issued the old one has not been told anything, so it keeps working ' +
    'until you revoke it there.',
  caution:
    'Saving replaces the stored credential. It does not revoke the old one.',
};

/**
 * GitHub, where a rotation has a second half the screen cannot perform.
 *
 * Two separate reasons the old token is still live, and neither is hedging:
 *
 *  1. GitHub is the only place a personal access token is revoked. Storing a
 *     new one here changes what Opifex authenticates with; it changes nothing
 *     about what the old string can still do.
 *  2. A run that is already under way was handed the old token. The git
 *     credential helper `RunWorkspaceService` writes into the workspace reads
 *     it out of the run's environment, so until those runs finish, the old
 *     token is not merely valid — it is in use.
 */
const GITHUB_NOTICE: RotationNotice = {
  title: 'The old token is still valid, and may still be in use',
  body:
    'Saving stores the new token here. It does NOT revoke the old one: that ' +
    'happens only in GitHub, under Settings → Developer settings → Personal ' +
    'access tokens, and until you do it there the old token can still read ' +
    'and write everything it could before. A run that is already under way ' +
    'was also started with the old token — the git credential helper in its ' +
    'workspace reads the value it was given — so treat the old token as ' +
    'live until those runs have finished and you have revoked it at GitHub.',
  caution:
    'Saving stores the new token here. It does not revoke the old one at ' +
    'GitHub, and a run already under way keeps using it.',
};

const NOTICES: Record<string, RotationNotice> = {
  'github.token': GITHUB_NOTICE,
};

/** What replacing THIS credential leaves undone. Never null — see above. */
export function rotationNotice(key: string): RotationNotice {
  return NOTICES[key] ?? GENERIC_NOTICE;
}
