/**
 * How an entry is presented, given only the response (#348, epic #332).
 *
 * The load-bearing case is the LAST one in each block: a group, a reload
 * value or a setting type this build has never seen still renders. That is
 * what "adding a key in the backend needs no frontend change" means when the
 * backend adds something this release did not anticipate — the alternative is
 * a section that silently omits the new key, which nothing would fail over.
 */

import { describe, expect, it } from 'vitest';

import {
  groupLabel,
  groupSettings,
  observedFor,
  provenanceOf,
  reloadPresentation,
} from '../../config/operatorSettings';
import { OPERATOR_SETTINGS_FIXTURE } from '../mocks/operatorSettings';
import type { FleetHealth } from '../../types/health';
import type { OperatorSetting } from '../../types/operatorSettings';

const SETTINGS: OperatorSetting[] = OPERATOR_SETTINGS_FIXTURE;

function entry(key: string): OperatorSetting {
  const found = SETTINGS.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`no setting ${key}`);
  return found;
}

const FLEET: FleetHealth = {
  status: 'up',
  checked: true,
  runners: [
    {
      key: 'claude-code-local',
      version: '2.1.246',
      enabled: false,
      available: true,
      maxConcurrency: 2,
    },
  ],
};

describe('reloadPresentation', () => {
  it('renders all three states the API publishes', () => {
    expect(reloadPresentation('live').label).toBe('live');
    expect(reloadPresentation('next-unit').label).toBe('applies to new runs');
    expect(reloadPresentation('restart').label).toBe('restart required');
  });

  it('prints an unrecognised value rather than guessing at one', () => {
    const unknown = reloadPresentation('on-tuesdays');

    expect(unknown.label).toBe('on-tuesdays');
    expect(unknown.color).toBe('default');
    expect(unknown.help).toContain('will not guess');
  });
});

describe('provenanceOf', () => {
  it('says overridden here for a stored value', () => {
    expect(provenanceOf(entry('github.requestTimeoutMs')).label).toBe(
      'overridden here',
    );
  });

  it('says from environment, and names the variable', () => {
    const provenance = provenanceOf(entry('runners.claudeCodeLocal.enabled'));

    expect(provenance.label).toBe('from environment');
    expect(provenance.detail).toContain('CLAUDE_CODE_ENABLED');
  });

  it('does not claim an unset variable supplied the value', () => {
    // `source: 'default'` means neither layer set anything. Calling that "from
    // environment" would name a variable that is not exported.
    expect(provenanceOf(entry('github.apiBaseUrl')).label).toBe(
      'built-in default',
    );
  });
});

describe('groupSettings', () => {
  it('groups in the declared order and keeps registry order inside', () => {
    const groups = groupSettings(SETTINGS);

    expect(groups.map((group) => group.group)).toEqual([
      'github',
      'runner',
      'dispatch',
    ]);
    expect(groups[0].entries.map((setting) => setting.key)).toEqual([
      'github.token',
      'github.requestTimeoutMs',
      'github.apiBaseUrl',
    ]);
  });

  it('renders a group this build has never heard of, after the known ones', () => {
    const invented: OperatorSetting = {
      ...entry('github.apiBaseUrl'),
      key: 'weather.forecastHorizonDays',
      group: 'weather_service',
    } as OperatorSetting;

    const groups = groupSettings([...SETTINGS, invented]);
    const last = groups[groups.length - 1];

    expect(last.group).toBe('weather_service');
    expect(last.label).toBe('Weather service');
    expect(last.entries).toHaveLength(1);
  });

  it('loses nothing it was given', () => {
    const total = groupSettings(SETTINGS).reduce(
      (count, group) => count + group.entries.length,
      0,
    );

    expect(total).toBe(SETTINGS.length);
  });
});

describe('groupLabel', () => {
  it('prefers the declared name and title-cases anything else', () => {
    expect(groupLabel('runner')).toBe('Execution');
    expect(groupLabel('costCeilings')).toBe('Cost Ceilings');
  });
});

describe('observedFor', () => {
  it('reads the runner enablement back off the fleet', () => {
    const observed = observedFor(
      entry('runners.claudeCodeLocal.enabled'),
      FLEET,
    );

    expect(observed?.statement).toBe('claude-code-local enabled: false');
    expect(observed?.source).toBe('GET /api/health/ready → info.fleet');
    // The fixture is configured `true` and observed `false`, which is exactly
    // the divergence this screen exists to make sayable.
    expect(observed?.disagrees).toBe(true);
  });

  it('returns nothing for a key nothing probes, and for a secret', () => {
    expect(observedFor(entry('github.requestTimeoutMs'), FLEET)).toBeNull();
    expect(observedFor(entry('github.token'), FLEET)).toBeNull();
  });

  it('returns nothing when the fleet could not be read', () => {
    expect(
      observedFor(entry('runners.claudeCodeLocal.enabled'), null),
    ).toBeNull();
  });
});
