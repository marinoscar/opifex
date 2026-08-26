/**
 * Writing a credential, and the sentence a save owes the operator
 * (#349, epic #332).
 *
 * `buildSecretWrite` takes a CALLBACK rather than a value, which is the whole
 * point: the credential is created at the moment the body is, and no caller
 * has to hold it. The tests below therefore pass a closure over a local, and
 * one of them asserts the callback is not consulted at all on the path that
 * cannot use it — a clear must not read a field that is not open.
 */

import { describe, expect, it, vi } from 'vitest';

import { buildSecretWrite, rotationNotice } from '../../config/secretRotation';
import { OPERATOR_SETTINGS_FIXTURE } from '../mocks/operatorSettings';
import type { SecretOperatorSetting } from '../../types/operatorSettings';

function secret(key: string): SecretOperatorSetting {
  const entry = OPERATOR_SETTINGS_FIXTURE.find(
    (candidate) => candidate.key === key,
  );
  if (!entry || !entry.secret) throw new Error(`no secret setting ${key}`);
  return entry;
}

describe('buildSecretWrite', () => {
  it('sends the typed value under the one key, and nothing else', () => {
    const result = buildSecretWrite(
      secret('github.token'),
      { kind: 'replace' },
      () => 'ghp_typed_by_the_operator',
    );

    expect(result).toEqual({
      ok: true,
      patch: { 'github.token': 'ghp_typed_by_the_operator' },
    });
  });

  it('does not trim, because a credential is an opaque string', () => {
    // Trimming produces a stored value that is not the one that was pasted,
    // which then fails at the service with no explanation this screen has.
    const result = buildSecretWrite(
      secret('github.token'),
      { kind: 'replace' },
      () => ' ghp_with_space ',
    );

    expect(result.ok && result.patch['github.token']).toBe(' ghp_with_space ');
  });

  it('refuses an empty field and points at Clear instead', () => {
    const result = buildSecretWrite(
      secret('github.token'),
      { kind: 'replace' },
      () => '',
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.problem).toMatch(/GITHUB_TOKEN/);
    expect(!result.ok && result.problem).toMatch(/Clear/);
  });

  it('clears with a JSON null, which deletes the row', () => {
    // Not the string 'null' — that is the OTHER meaning, a stored null, and
    // `types/operatorSettings.ts` keeps them apart deliberately.
    const result = buildSecretWrite(
      secret('runners.claudeCodeLocal.oauthToken'),
      { kind: 'clear' },
      () => {
        throw new Error('a clear must not read the field');
      },
    );

    expect(result).toEqual({
      ok: true,
      patch: { 'runners.claudeCodeLocal.oauthToken': null },
    });
  });

  it('refuses to clear a key that has nothing stored', () => {
    // `github.token` in the fixture reads from the environment. Sending null
    // would be a write that changes nothing and puts a key in an audit row
    // the operator did not change.
    const read = vi.fn(() => '');
    const result = buildSecretWrite(
      secret('github.token'),
      { kind: 'clear' },
      read,
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.problem).toMatch(/already reads from/i);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('rotationNotice', () => {
  it('says the old GitHub token is still valid, and where to revoke it', () => {
    const notice = rotationNotice('github.token');

    expect(notice.body).toMatch(/does NOT revoke the old one/);
    expect(notice.body).toMatch(/GitHub/);
    expect(notice.body).toMatch(/already under way/i);
  });

  it('never leaves a credential with no notice at all', () => {
    // Silence is the "Saved, therefore the old one is dead" reading. A secret
    // key added to the registry later gets the generic truth rather than
    // nothing.
    const notice = rotationNotice('some.credential.nobody.has.written.yet');

    expect(notice.title).toMatch(/not been revoked/i);
    expect(notice.body).toMatch(/keeps working until you revoke it/i);
  });
});
