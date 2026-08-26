/**
 * The spend ceilings, and the three states a figure can be in
 * (#349, #345, ADR-0018).
 *
 * `classifyCeiling` mirrors `parseHardCeiling` in
 * `apps/api/src/budget/hard-spend-ceiling.ts`, and the tests that matter are
 * the ones about the state a NUMBER could not carry: `50O` is malformed, not
 * unset and not zero, because somebody who mistyped a ceiling believes they
 * set one. The API keeps them apart at the registry by declaring these keys as
 * strings; a UI that parsed them into numbers would put the collapse back.
 */

import { describe, expect, it } from 'vitest';

import {
  CEILING_ADR,
  CEILING_DEFINITIONS,
  classifyCeiling,
  describeCeilingChange,
  describeClassification,
} from '../../config/spendCeilings';
import { OPERATOR_SETTINGS_FIXTURE } from '../mocks/operatorSettings';
import type { OperatorSetting } from '../../types/operatorSettings';

function entry(key: string): OperatorSetting {
  const found = OPERATOR_SETTINGS_FIXTURE.find(
    (candidate) => candidate.key === key,
  );
  if (!found) throw new Error(`no setting ${key}`);
  return found;
}

const DISPATCH = CEILING_DEFINITIONS[0];

describe('classifyCeiling', () => {
  it('reads an empty figure as unset rather than as zero', () => {
    // `Number('')` is 0, and a ceiling of zero means "spend nothing" — a real
    // instruction that must not be reachable from a blank field.
    expect(classifyCeiling('')).toEqual({ kind: 'unset' });
    expect(classifyCeiling('   ')).toEqual({ kind: 'unset' });
  });

  it('keeps a mistyped figure distinguishable from an unset one', () => {
    expect(classifyCeiling('50O')).toEqual({ kind: 'malformed', text: '50O' });
    expect(classifyCeiling('-5')).toEqual({ kind: 'malformed', text: '-5' });
    expect(classifyCeiling('abc')).toEqual({ kind: 'malformed', text: 'abc' });
  });

  it('accepts zero and fractional amounts as amounts', () => {
    expect(classifyCeiling('0')).toEqual({ kind: 'amount', usd: 0, text: '0' });
    expect(classifyCeiling('12.5')).toEqual({
      kind: 'amount',
      usd: 12.5,
      text: '12.5',
    });
  });

  it('quotes the offending text back rather than saying "expected number"', () => {
    const sentence = describeClassification(classifyCeiling('50O'), DISPATCH);

    expect(sentence).toContain('"50O"');
    expect(sentence).toMatch(/refused/i);
  });

  it('says an unset ceiling refuses rather than permits', () => {
    const sentence = describeClassification(classifyCeiling(''), DISPATCH);

    expect(sentence).toMatch(/REFUSES every dispatch/);
    expect(sentence).toMatch(/not an unlimited one/);
  });
});

describe('describeCeilingChange', () => {
  const usd = entry('dispatch.hardSpendCeilingUsd');
  const window = entry('dispatch.hardSpendCeilingWindowDays');

  it('reports nothing for a value that has not moved', () => {
    expect(describeCeilingChange(DISPATCH, 'usd', usd, '25')).toBeNull();
  });

  it('names a raise as a raise, with both figures', () => {
    const change = describeCeilingChange(DISPATCH, 'usd', usd, '100');

    expect(change?.from).toBe('25');
    expect(change?.to).toBe('100');
    expect(change?.consequence).toMatch(/RAISES the limit from \$25 to \$100/);
  });

  it('says a lowered ceiling does not recall a run already under way', () => {
    const change = describeCeilingChange(DISPATCH, 'usd', usd, '5');

    expect(change?.consequence).toMatch(/LOWERS/);
    expect(change?.consequence).toMatch(/not recalled/);
  });

  it('says removing the ceiling refuses everything rather than lifting it', () => {
    const change = describeCeilingChange(DISPATCH, 'usd', usd, '');

    expect(change?.to).toBe('(not set)');
    expect(change?.consequence).toMatch(/does not lift it/);
    expect(change?.consequence).toMatch(/REFUSES every dispatch/);
  });

  it('warns that a mistyped figure is neither a ceiling nor "no ceiling"', () => {
    const change = describeCeilingChange(DISPATCH, 'usd', usd, '50O');

    expect(change?.consequence).toMatch(/malformed/);
    expect(change?.consequence).toMatch(/refuse to spend/);
  });

  it('says a SHORTER window permits more spend per month', () => {
    // The one an operator is most likely to get backwards, and the registry
    // calls it "as much a budget change as the figure is".
    const change = describeCeilingChange(DISPATCH, 'window', window, '7');

    expect(change?.consequence).toMatch(/MORE spend per month/);
  });

  it('says a LONGER window permits less, and recovers more slowly', () => {
    const change = describeCeilingChange(DISPATCH, 'window', window, '90');

    expect(change?.consequence).toMatch(/less spend per month/);
    expect(change?.consequence).toMatch(/take longer/);
  });
});

describe('the ceiling definitions', () => {
  it('names keys the API actually publishes', () => {
    for (const definition of CEILING_DEFINITIONS) {
      expect(() => entry(definition.usdKey)).not.toThrow();
      expect(() => entry(definition.windowKey)).not.toThrow();
    }
  });

  it('declares supervisor spend as not observable, rather than reusing the factory figure', () => {
    // GET /api/cost/summary reports the dispatch ceiling only, and the
    // supervisor is metered on a separate key (ADR-0015). Showing the factory
    // total next to the supervisor ceiling would be a number that is about
    // something else.
    const supervisor = CEILING_DEFINITIONS.find(
      (definition) => definition.id === 'supervisor',
    );

    expect(supervisor?.spendSource.kind).toBe('not-observable');
  });

  it('links the ADR that makes these editable at all', () => {
    expect(CEILING_ADR.id).toBe('ADR-0018');
    expect(CEILING_ADR.path).toContain('docs/adr/0018-');
  });
});
