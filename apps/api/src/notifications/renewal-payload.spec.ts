import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildRenewalPayload,
  type GrantForRenewalNotification,
} from './renewal-payload';

/**
 * The renewal prompt on the phone (#115, VISION §8).
 *
 * Two things this payload must do, and both are things a well-meaning edit
 * would remove:
 *
 *  1. **Carry the grant's record.** A prompt that said only "grant expiring,
 *     renew?" asks the operator to re-approve BLIND, which is precisely how
 *     blanket trust gets granted — one uninformed yes at a time.
 *  2. **Say plainly that silence revokes.** VISION §8's "silence revokes" is
 *     a mechanism only if the operator is told that doing nothing is a
 *     decision. Softening `ifIgnored` into "you may want to review this"
 *     describes a system that keeps grants alive out of politeness. This one
 *     does not.
 */

const NOW = new Date('2026-08-24T12:00:00.000Z');
const APP = 'https://opifex.example';

function grant(
  overrides: Partial<GrantForRenewalNotification> = {},
): GrantForRenewalNotification {
  return {
    id: 'grant-1',
    actionClass: 're-dispatch',
    actionClassTitle: 'Re-dispatch after transient failure',
    repositoryId: 'repo-1',
    expiresAt: new Date(NOW.getTime() + 36 * 3600_000),
    createdAt: new Date(NOW.getTime() - 12 * 24 * 3600_000),
    spentUsd: 12.5,
    budgetCeilingUsd: 25,
    remainingBudgetUsd: 12.5,
    actionsAuthorized: 9,
    actionsFailed: 2,
    failureRate: 2 / 9,
    ...overrides,
  };
}

describe('buildRenewalPayload (#115)', () => {
  it('carries the four things VISION §8 requires', () => {
    const payload = buildRenewalPayload(grant(), APP, NOW);

    expect(payload.body).not.toHaveLength(0);
    expect(payload.why).not.toHaveLength(0);
    expect(payload.blastRadius).not.toHaveLength(0);
    expect(payload.ifIgnored).not.toHaveLength(0);
    expect(payload.raisedAt).toBe(NOW.toISOString());
    expect(payload.kind).toBe('trust_grant_expiring');
  });

  it('carries the RECORD: what it authorized, what it cost, how often it failed', () => {
    const payload = buildRenewalPayload(grant(), APP, NOW);

    // What it authorized.
    expect(payload.why).toContain('9 action(s)');
    // What it cost, against its ceiling — the fraction is what makes a $25
    // grant and a $250 grant comparable.
    expect(payload.why).toContain('$12.50');
    expect(payload.why).toContain('$25.00');
    // Its failure rate, as a number the operator can check.
    expect(payload.why).toContain('2 failed (22%)');
    // And when the trust started, so "9 actions" has a period attached to it.
    expect(payload.why).toContain(grant().createdAt.toISOString());
  });

  it('says a grant that authorized NOTHING authorized nothing, rather than reporting 0 failures', () => {
    // 0/0 is no evidence. "0 failures" would read as a clean record where
    // there is no record at all, and a clean record is an argument for
    // renewing.
    const payload = buildRenewalPayload(
      grant({
        actionsAuthorized: 0,
        actionsFailed: 0,
        failureRate: null,
        spentUsd: 0,
        remainingBudgetUsd: 25,
      }),
      APP,
      NOW,
    );

    expect(payload.why).toContain('authorized NOTHING');
    expect(payload.why).not.toContain('0 failed');
    expect(payload.why).toContain('letting it lapse costs you nothing');
  });

  it('states that silence revokes, names the instant, and promises no second prompt', () => {
    const payload = buildRenewalPayload(grant(), APP, NOW);

    expect(payload.ifIgnored).toContain('is NOT ');
    expect(payload.ifIgnored).toContain('renewed');
    expect(payload.ifIgnored).toContain(grant().expiresAt.toISOString());
    expect(payload.ifIgnored).toContain('silence revokes');
    expect(payload.ifIgnored).toContain('only prompt you will get');
    // And it does not hedge into a promise that something will catch it.
    expect(payload.ifIgnored).not.toMatch(/remind|again later|follow up/i);
  });

  it('is NORMAL priority: a batched decision, not an interruption', () => {
    // VISION §8's goal is "not fewer decisions but decisions batched and moved
    // off the critical path". The outcome of ignoring this is safe, bounded
    // and already decided, so an interruption buys nothing but the
    // interruption — and an operator who learns to swipe trust notifications
    // away swipes the real escalation with them.
    expect(buildRenewalPayload(grant(), APP, NOW).priority).toBe('normal');
  });

  it('mints no escalation and no receipt token', () => {
    // A grant approaching expiry is not a stall. An escalation row would put
    // it into the stop-to-notified percentiles that measure how long a BROKEN
    // RUN went unnoticed, and a receipt token would be a credential naming
    // nothing.
    const payload = buildRenewalPayload(grant(), APP, NOW);

    expect(payload.escalationId).toBeUndefined();
    expect(payload.receiptId).toBeUndefined();
  });

  it('names the scope in the blast radius: one class, one repository', () => {
    const payload = buildRenewalPayload(grant(), APP, NOW);

    expect(payload.blastRadius).toContain(
      'Re-dispatch after transient failure',
    );
    expect(payload.blastRadius).toContain('repo-1');
    expect(payload.blastRadius).toContain('cannot widen');
  });

  it('deep-links to the one grant', () => {
    expect(buildRenewalPayload(grant(), APP, NOW).url).toBe(
      'https://opifex.example/trust/grants/grant-1',
    );
  });

  it('falls back to the raw class id when the caller could not resolve a title', () => {
    // An unresolved class is registry drift, and the raw id is the single most
    // useful thing the notification can show in that case. "An unknown action"
    // would be the least.
    const payload = buildRenewalPayload(
      grant({ actionClass: 'nonexistent-class', actionClassTitle: null }),
      APP,
      NOW,
    );

    expect(payload.title).toContain('nonexistent-class');
  });

  it('renders the time left coarsely', () => {
    expect(buildRenewalPayload(grant(), APP, NOW).body).toContain('1 day');
  });

  it('does not import the action-class registry', () => {
    // The governing test for #94 forbids anything under `src/notifications/`
    // importing `src/supervisor/`, because "escalation to a human" is on
    // VISION §7's left-hand column and the erosion arrives "one convenient
    // dependency at a time, each individually reasonable". This is exactly
    // such a dependency — the registry is a frozen array with no I/O — and it
    // was caught once already in #98. Asserted here as well as there so the
    // failure names THIS file.
    const source = readFileSync(join(__dirname, 'renewal-payload.ts'), 'utf8');
    const imports = [
      ...source.matchAll(/^\s*import\s[\s\S]*?from\s+'([^']+)';/gm),
    ].map((match) => match[1]!);

    expect(imports.filter((path) => path.includes('supervisor'))).toEqual([]);
  });
});
