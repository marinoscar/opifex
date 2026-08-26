/**
 * The patch a draft becomes (#348, epic #332).
 *
 * The first test is the one the issue names as an acceptance criterion, and
 * the reason it is a criterion rather than an optimisation: an absent row means
 * "fall through to the environment", so a body carrying every rendered key
 * would materialise today's defaults into rows and freeze this deployment
 * against every later change to a default. Asserting `Object.keys(changes)` —
 * rather than asserting that the changed key is present — is what makes the
 * test fail when an untouched key sneaks in.
 */

import { describe, expect, it } from 'vitest';

import {
  baselineFieldValue,
  buildPatch,
  changedCount,
  isChanged,
  toWireValue,
} from '../../config/operatorSettingsDraft';
import { OPERATOR_SETTINGS_FIXTURE } from '../mocks/operatorSettings';
import type {
  OperatorSetting,
  PlainOperatorSetting,
} from '../../types/operatorSettings';

const SETTINGS: OperatorSetting[] = OPERATOR_SETTINGS_FIXTURE;

function plain(key: string): PlainOperatorSetting {
  const entry = SETTINGS.find((candidate) => candidate.key === key);
  if (!entry || entry.secret) throw new Error(`no plain setting ${key}`);
  return entry;
}

describe('buildPatch', () => {
  it('carries only the keys that changed', () => {
    const { changes, problems } = buildPatch(SETTINGS, {
      'github.requestTimeoutMs': { kind: 'edit', value: '20000' },
    });

    expect(Object.keys(changes)).toEqual(['github.requestTimeoutMs']);
    expect(changes['github.requestTimeoutMs']).toBe(20000);
    expect(problems).toEqual({});
  });

  it('leaves out a row whose draft is the value it already had', () => {
    // Typing 15000 over a 15000 must not create a row. A row that merely
    // restates the current value is the freeze described in the header, in
    // miniature, and the operator gets no signal that it happened.
    const { changes } = buildPatch(SETTINGS, {
      'github.requestTimeoutMs': { kind: 'edit', value: '15000' },
      'runners.claudeCodeLocal.enabled': { kind: 'edit', value: true },
    });

    expect(changes).toEqual({});
  });

  it('sends null for a revert, and only where there is a row to delete', () => {
    const { changes } = buildPatch(SETTINGS, {
      // `source: 'database'` — there is a stored row.
      'github.requestTimeoutMs': { kind: 'revert' },
      // `source: 'env'` — reverting deletes nothing, so it is not a change.
      'runners.claudeCodeLocal.enabled': { kind: 'revert' },
    });

    expect(changes).toEqual({ 'github.requestTimeoutMs': null });
  });

  it('stores an explicit null as the STRING null, which is not the revert', () => {
    // `dispatch.maxConcurrent` accepts null as a real value meaning "no
    // ceiling". Clearing a ceiling of 4 therefore STORES a null; a JSON null
    // there would delete the row and fall back to the environment, which is
    // the opposite intention.
    const ceilingSet: OperatorSetting[] = SETTINGS.map((entry) =>
      entry.key === 'dispatch.maxConcurrent' && !entry.secret
        ? { ...entry, value: 4, source: 'database' as const }
        : entry,
    );

    const { changes } = buildPatch(ceilingSet, {
      'dispatch.maxConcurrent': { kind: 'edit', value: '' },
    });

    expect(changes).toEqual({ 'dispatch.maxConcurrent': 'null' });
  });

  it('does not store a null over a value that is already null', () => {
    // The fixture's ceiling is null from the default. Clearing a field that is
    // already empty changes nothing, so it must not create a row restating the
    // default — the same rule as typing a value over itself.
    const { changes } = buildPatch(SETTINGS, {
      'dispatch.maxConcurrent': { kind: 'edit', value: '' },
    });

    expect(changes).toEqual({});
  });

  it('never sends a secret, whatever the draft says', () => {
    const { changes, problems } = buildPatch(SETTINGS, {
      'github.token': { kind: 'edit', value: 'ghp_something' },
      'github.requestTimeoutMs': { kind: 'revert' },
    });

    expect(Object.keys(changes)).toEqual(['github.requestTimeoutMs']);
    expect(problems).toEqual({});
  });

  it('drops a draft for a key the response no longer publishes', () => {
    const { changes } = buildPatch(SETTINGS, {
      'retired.setting': { kind: 'edit', value: 'x' },
    });

    expect(changes).toEqual({});
  });

  it('reports a rejected value instead of sending it', () => {
    const { changes, problems } = buildPatch(SETTINGS, {
      'github.requestTimeoutMs': { kind: 'edit', value: '12' },
    });

    expect(changes).toEqual({});
    expect(problems['github.requestTimeoutMs']).toContain('at least 1000');
  });
});

describe('toWireValue', () => {
  it('parses an integer rather than sending its text', () => {
    expect(
      toWireValue(plain('github.requestTimeoutMs'), {
        kind: 'edit',
        value: '20000',
      }),
    ).toEqual({ ok: true, value: 20000 });
  });

  it('refuses a non-integer, a value under min and a value over max', () => {
    const entry = plain('github.requestTimeoutMs');
    for (const value of ['1.5', '999', '999999']) {
      expect(toWireValue(entry, { kind: 'edit', value })).toMatchObject({
        ok: false,
      });
    }
  });

  it('refuses an emptied field that cannot hold null, naming the revert', () => {
    const result = toWireValue(plain('github.apiBaseUrl'), {
      kind: 'edit',
      value: '   ',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('Revert to');
  });

  it('refuses an enum value the API did not offer', () => {
    expect(
      toWireValue(plain('runners.claudeCodeLocal.permissionMode'), {
        kind: 'edit',
        value: 'anythingGoes',
      }),
    ).toMatchObject({ ok: false });
  });

  it('sends a boolean as a boolean', () => {
    expect(
      toWireValue(plain('runners.claudeCodeLocal.enabled'), {
        kind: 'edit',
        value: false,
      }),
    ).toEqual({ ok: true, value: false });
  });
});

describe('baselineFieldValue', () => {
  it('renders a null value as an empty field, not as the text "null"', () => {
    // The string 'null' in a text box would be indistinguishable from an
    // operator having typed it, and would then be sent as a four-character
    // string on the next save.
    expect(baselineFieldValue(plain('dispatch.maxConcurrent'))).toBe('');
  });

  it('gives a boolean setting a boolean', () => {
    expect(baselineFieldValue(plain('runners.claudeCodeLocal.enabled'))).toBe(
      true,
    );
  });
});

describe('isChanged and changedCount', () => {
  it('counts only rows that differ', () => {
    const draft = {
      'github.requestTimeoutMs': { kind: 'edit' as const, value: '20000' },
      'github.apiBaseUrl': {
        kind: 'edit' as const,
        value: 'https://api.github.com',
      },
    };

    expect(changedCount(SETTINGS, draft)).toBe(1);
    expect(
      isChanged(plain('github.apiBaseUrl'), draft['github.apiBaseUrl']),
    ).toBe(false);
  });
});
