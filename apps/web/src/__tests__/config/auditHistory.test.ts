/**
 * The rule that a secret is never valued (#351, epic #332).
 *
 * These are the tests that make the History section's central claim
 * checkable, and they are deliberately pure: the claim is a property of a
 * function, so it can be asserted without a DOM, at every input shape, rather
 * than only at the two or three that happen to be rendered in a component
 * test.
 *
 * The fixtures use REAL secret-shaped material — a `ghp_` token, an
 * `sk-ant-` key — because a test that redacts `'secret'` proves nothing about
 * a string that looks like a credential.
 */

import { describe, expect, it } from 'vitest';

import {
  AUDIT_TARGET_TYPES,
  auditChangesOf,
  auditTargetTypeLabel,
  describeAuditActor,
  describeAuditChanges,
  describeSecretEffect,
  formatAuditValue,
  isSecretFieldName,
  looksMasked,
  secretEffectOf,
} from '../../config/auditHistory';

/** A plausible GitHub token, and its masked form as the API would serve it. */
const PLAINTEXT_TOKEN = 'ghp_Kx7Vd2Nq9Zb4Mr6Wt3Jc8Ly5Hs';
const MASKED_TOKEN = '********Ly5Hs';

describe('isSecretFieldName', () => {
  it('matches the API denylist through every separator style', () => {
    // `redact.ts` normalises by stripping `-`, `_`, `.` and whitespace and
    // lowercasing, so all four of these are one entry. If this file's mirror
    // ever normalises differently, a `github.token` would slip past.
    for (const name of [
      'api_key',
      'apiKey',
      'API-KEY',
      'github.token',
      'GITHUB_TOKEN',
      'supervisor.model.apiKey',
      'runners.claudeCodeLocal.oauthToken',
      'passphrase',
      'ciphertext',
    ]) {
      expect(isSecretFieldName(name), name).toBe(true);
    }
  });

  it('leaves ordinary setting names alone', () => {
    // Over-masking is its own failure: an audit log where everything reads
    // "changed" answers nothing. `redact.ts` omits bare `key` for exactly this
    // reason, and this mirror must omit it too.
    for (const name of [
      'dispatch.enabled',
      'reconciler.intervalMs',
      'key',
      'keyVersion',
      'settingKey',
      'publicKey',
      'email',
      'roles',
    ]) {
      expect(isSecretFieldName(name), name).toBe(false);
    }
  });

  it('asks every name it is given and takes one match as enough', () => {
    // The settings shape stores the value under `from`/`to`, which say nothing
    // about what they hold; the setting key beside them is what knows.
    expect(isSecretFieldName('from', 'github.token')).toBe(true);
    expect(isSecretFieldName('from', 'dispatch.enabled')).toBe(false);
    expect(isSecretFieldName(null, undefined)).toBe(false);
  });
});

describe('looksMasked', () => {
  it('recognises the mask with and without its revealed suffix', () => {
    expect(looksMasked('********')).toBe(true);
    expect(looksMasked(MASKED_TOKEN)).toBe(true);
  });

  it('does not treat an ordinary value as masked', () => {
    expect(looksMasked('dispatch')).toBe(false);
    expect(looksMasked(42)).toBe(false);
    expect(looksMasked(null)).toBe(false);
  });
});

describe('secretEffectOf', () => {
  it('reads set and cleared off the action, which is where they are recorded', () => {
    expect(secretEffectOf('operator_settings:set')).toBe('set');
    expect(secretEffectOf('operator_settings:clear')).toBe('cleared');
  });

  it('says only "changed" for an action that does not name a direction', () => {
    // The honest answer. A row from a writer with its own verb records that
    // something moved and not which way.
    expect(secretEffectOf('user:update')).toBe('changed');
    expect(describeSecretEffect(secretEffectOf('user:update'))).toBe(
      'Secret changed',
    );
  });
});

describe('auditChangesOf — the settings shape', () => {
  it('renders a non-secret change with both sides and their sources', () => {
    const [change] = auditChangesOf({
      action: 'operator_settings:set',
      meta: {
        key: 'dispatch.enabled',
        from: false,
        to: true,
        fromSource: 'env',
        toSource: 'database',
      },
    });

    expect(change).toEqual({
      field: 'dispatch.enabled',
      secret: false,
      from: 'false',
      to: 'true',
      effect: null,
      fromSource: 'env',
      toSource: 'database',
    });
  });

  it('withholds both sides of a secret key and says what happened instead', () => {
    const [change] = auditChangesOf({
      action: 'operator_settings:set',
      meta: {
        key: 'github.token',
        from: '********',
        to: MASKED_TOKEN,
        fromSource: 'env',
        toSource: 'database',
      },
    });

    expect(change.secret).toBe(true);
    expect(change.from).toBeNull();
    expect(change.to).toBeNull();
    expect(change.effect).toBe('set');
    expect(describeSecretEffect(change.effect!)).toBe('Secret set');
  });

  it('drops the four characters the API deliberately reveals', () => {
    // `maskSecret` reveals the last four of anything 16 characters or longer,
    // which is useful where an operator is matching a value they hold and is
    // four characters of a credential anywhere else. This is the assertion
    // that makes "never a masked value either" more than a comment.
    const changes = auditChangesOf({
      action: 'operator_settings:set',
      meta: { key: 'github.token', from: '********', to: MASKED_TOKEN },
    });

    expect(JSON.stringify(changes)).not.toContain('Ly5Hs');
    expect(JSON.stringify(changes)).not.toContain('********');
  });

  it('refuses a plaintext the API should never have served', () => {
    // The API redacts on write (#337) and again on read (#338). This asserts
    // the browser does not depend on either: a denylist fails open silently,
    // so the UI judges from the SETTING KEY rather than from whether the
    // value arrived masked.
    const changes = auditChangesOf({
      action: 'operator_settings:set',
      meta: { key: 'github.token', from: null, to: PLAINTEXT_TOKEN },
    });

    expect(JSON.stringify(changes)).not.toContain(PLAINTEXT_TOKEN);
    expect(changes[0].secret).toBe(true);
  });

  it('treats a masked value under an unrecognised name as secret anyway', () => {
    // The other direction: a field name this mirror does not know, holding a
    // value the API DID recognise. The two judgements are OR-ed, so either one
    // firing is enough.
    const [change] = auditChangesOf({
      action: 'operator_settings:set',
      meta: { key: 'runners.claudeCodeLocal.handshake', to: MASKED_TOKEN },
    });

    expect(change.secret).toBe(true);
    expect(change.to).toBeNull();
  });

  it('never infers that a secret was previously empty', () => {
    // `maskSecretValue(null)` and `maskSecretValue('ghp_…')` are the same
    // `********`, so "was there a value before?" is unanswerable from the row.
    // A `cleared` here would be a fact nobody recorded.
    const [change] = auditChangesOf({
      action: 'operator_settings:set',
      meta: { key: 'github.token', from: '********', to: '********' },
    });

    expect(change.effect).toBe('set');
    expect(change.from).toBeNull();
  });

  it('reports a cleared secret as cleared', () => {
    const [change] = auditChangesOf({
      action: 'operator_settings:clear',
      meta: {
        key: 'runners.claudeCodeLocal.oauthToken',
        from: '********pJ4c',
        to: '********',
      },
    });

    expect(change.effect).toBe('cleared');
    expect(describeSecretEffect(change.effect!)).toBe('Secret cleared');
  });

  it('keeps anything else the writer recorded alongside the change', () => {
    const changes = auditChangesOf({
      action: 'operator_settings:set',
      meta: {
        key: 'dispatch.enabled',
        from: false,
        to: true,
        revision: 12,
      },
    });

    expect(changes.map((change) => change.field)).toEqual([
      'dispatch.enabled',
      'revision',
    ]);
    expect(changes[1].to).toBe('12');
  });
});

describe('auditChangesOf — every other writer', () => {
  it('lists a flat meta field by field', () => {
    const changes = auditChangesOf({
      action: 'allowlist:add',
      meta: { email: 'newcomer@example.com' },
    });

    expect(changes).toEqual([
      {
        field: 'email',
        secret: false,
        from: null,
        to: 'newcomer@example.com',
        effect: null,
      },
    ]);
  });

  it('does not claim a before-state the row never recorded', () => {
    // `from: null` means "not recorded", and the cell renders nothing for it.
    // Printing "not set → x" would assert the field was previously empty.
    const [change] = auditChangesOf({
      action: 'user:roles_update',
      meta: { roles: ['admin'] },
    });

    expect(change.from).toBeNull();
    expect(change.to).toBe('["admin"]');
  });

  it('withholds a secret-named field from any writer, not just settings', () => {
    const [change] = auditChangesOf({
      action: 'user:update',
      meta: { apiKey: 'sk-ant-api03-0Vb7Qn4Xz2Lp9Rk1' },
    });

    expect(change.secret).toBe(true);
    expect(change.to).toBeNull();
    expect(change.effect).toBe('changed');
  });

  it('has nothing to say about a scalar or an absent meta, and says so', () => {
    expect(auditChangesOf({ action: 'user:update', meta: null })).toEqual([]);
    expect(auditChangesOf({ action: 'user:update', meta: 'a note' })).toEqual(
      [],
    );
    expect(auditChangesOf({ action: 'user:update', meta: [1, 2] })).toEqual([]);
  });
});

describe('describeAuditChanges — the CSV scalar', () => {
  it('carries no value the screen refused to draw', () => {
    // The export is the easier of the two to leak by accident: nobody reads a
    // CSV before it lands in a downloads folder.
    const text = describeAuditChanges(
      auditChangesOf({
        action: 'operator_settings:set',
        meta: { key: 'github.token', from: '********', to: MASKED_TOKEN },
      }),
    );

    expect(text).toBe('github.token: secret set');
    expect(text).not.toContain('Ly5Hs');
    expect(text).not.toContain('*');
  });

  it('writes a non-secret change as a readable before and after', () => {
    expect(
      describeAuditChanges(
        auditChangesOf({
          action: 'operator_settings:set',
          meta: { key: 'reconciler.intervalMs', from: 60000, to: 30000 },
        }),
      ),
    ).toBe('reconciler.intervalMs: 60000 → 30000');
  });
});

describe('formatAuditValue', () => {
  it('distinguishes an absent value from an empty string', () => {
    // Two different facts about a setting, and a formatter that collapsed them
    // would make a cleared string look like one that was never written.
    expect(formatAuditValue(null)).toBe('not set');
    expect(formatAuditValue(undefined)).toBe('not set');
    expect(formatAuditValue('')).toBe('""');
  });

  it('prints booleans and numbers as themselves', () => {
    expect(formatAuditValue(false)).toBe('false');
    expect(formatAuditValue(0)).toBe('0');
  });

  it('truncates visibly rather than filling a cell with a document', () => {
    const long = formatAuditValue('x'.repeat(500));
    expect(long.endsWith('…')).toBe(true);
    expect(long.length).toBeLessThan(140);
  });

  it('survives a value that cannot be serialised', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(formatAuditValue(cyclic)).toBe('[unprintable]');
  });
});

describe('describeAuditActor', () => {
  it('keeps the three kinds of actor apart', () => {
    expect(
      describeAuditActor({
        actorUserId: 'u1',
        actor: { email: 'a@example.com', displayName: 'Admin User' },
      }),
    ).toBe('Admin User');

    // A person acted and the account is gone — not the same claim as nobody
    // human having acted, which is the next case.
    expect(describeAuditActor({ actorUserId: 'u1', actor: null })).toBe(
      'Deleted account',
    );
    expect(describeAuditActor({ actorUserId: null, actor: null })).toBe(
      'Opifex itself',
    );
  });

  it('falls back to the email when the account has no display name', () => {
    expect(
      describeAuditActor({
        actorUserId: 'u1',
        actor: { email: 'a@example.com', displayName: null },
      }),
    ).toBe('a@example.com');
  });
});

describe('AUDIT_TARGET_TYPES', () => {
  it('offers operator settings first, since that is what this section is for', () => {
    expect(AUDIT_TARGET_TYPES[0].value).toBe('operator_settings');
  });

  it('names a type it does not know rather than hiding the row', () => {
    // The endpoint's `targetType` is a free string on purpose — a closed enum
    // would stop matching the first time a writer added a kind.
    expect(auditTargetTypeLabel('operator_settings')).toBe('Operator settings');
    expect(auditTargetTypeLabel('something_new')).toBe('something_new');
  });
});
