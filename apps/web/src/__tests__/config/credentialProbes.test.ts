/**
 * Probe descriptors, witnesses and staleness (#349, epic #332).
 *
 * The staleness rule is the one worth pinning: a probe result is an
 * observation, and the moment the configuration it tested moves, it stops
 * describing the deployment. These tests move each dependency in turn — the
 * secret's `updatedAt`, its `hint`, its `source`, and a NON-subject key the
 * answer still depends on — because an implementation that only compared the
 * subject key would pass a weaker version of every one of them.
 */

import { describe, expect, it } from 'vitest';

import {
  credentialProbes,
  formatDuration,
  probeFreshness,
  probeWitness,
  probesForSetting,
  rateLimitSentence,
  settingWitness,
  type ProbeObservation,
} from '../../config/credentialProbes';
import { OPERATOR_SETTINGS_FIXTURE } from '../mocks/operatorSettings';
import type { OperatorSetting } from '../../types/operatorSettings';

const SETTINGS = OPERATOR_SETTINGS_FIXTURE;

/**
 * The descriptors for the fixture's configuration.
 *
 * A function of the document since #422: `supervisor-model`'s subject is the
 * slot of whichever provider is selected, so there is no list to import.
 */
const PROBES = credentialProbes(SETTINGS);

function descriptor(name: string) {
  const found = PROBES.find((probe) => probe.name === name);
  if (!found) throw new Error(`no descriptor for ${name}`);
  return found;
}

/** The same document with one key replaced by a modified copy. */
function withEntry(key: string, change: Partial<OperatorSetting>) {
  return SETTINGS.map((entry) =>
    entry.key === key ? ({ ...entry, ...change } as OperatorSetting) : entry,
  );
}

function observation(name: string): ProbeObservation {
  return {
    probe: descriptor(name).name,
    witness: probeWitness(descriptor(name), SETTINGS),
    outcome: {
      state: 'answered',
      result: {
        probe: descriptor(name).name,
        ok: true,
        detail: 'It worked.',
        checkedAt: '2026-08-20T12:00:00.000Z',
        skipped: false,
      },
    },
  };
}

describe('the probe registry', () => {
  it('puts every probe on the card of a key the API publishes', () => {
    // A descriptor whose subject is not a real setting key renders a Test
    // button on nothing, which is invisible rather than broken — so it is
    // asserted here instead.
    for (const probe of PROBES) {
      expect(
        SETTINGS.some((entry) => entry.key === probe.subject),
        `${probe.name} names ${probe.subject}`,
      ).toBe(true);
    }
  });

  it('names its subject among the settings its answer depends on, or says why not', () => {
    // `claude-cli` is the deliberate exception and the reason the section
    // shows it: it tests the BINARY, which is why its green tick says nothing
    // about the credential it sits under.
    for (const probe of PROBES) {
      if (probe.name === 'claude-cli') {
        expect(probe.dependsOn).not.toContain(probe.subject);
        continue;
      }
      expect(probe.dependsOn).toContain(probe.subject);
    }
  });

  it('carries a cost note on exactly the probes that spend', () => {
    for (const probe of PROBES) {
      expect(probe.costNote === null).toBe(!probe.spends);
    }
    expect(
      PROBES.filter((probe) => probe.spends).map((probe) => probe.name),
    ).toEqual(['claude-credential', 'supervisor-model']);
  });

  it('groups the two Claude questions onto one card', () => {
    expect(
      probesForSetting('runners.claudeCodeLocal.oauthToken', SETTINGS).map(
        (p) => p.name,
      ),
    ).toEqual(['claude-cli', 'claude-credential']);
    expect(
      probesForSetting('runners.claudeCodeLocal.binary', SETTINGS),
    ).toEqual([]);
  });
});

describe('the model probe follows the provider (#422)', () => {
  /** The fixture with a different provider selected. */
  function selecting(provider: string) {
    return withEntry('supervisor.model.provider', { value: provider });
  }

  it('tests the SELECTED provider’s slot and no other', () => {
    expect(descriptor('supervisor-model').subject).toBe(
      'models.anthropic.apiKey',
    );

    const openai = credentialProbes(selecting('openai')).find(
      (probe) => probe.name === 'supervisor-model',
    );
    expect(openai?.subject).toBe('models.openai.apiKey');
  });

  it('puts the billed button on that card only', () => {
    // The unselected provider's key is on screen and rotatable; what it must
    // NOT have is a button that spends money testing a credential nothing is
    // currently using.
    expect(
      probesForSetting('models.anthropic.apiKey', SETTINGS).map((p) => p.name),
    ).toEqual(['supervisor-model']);
    expect(probesForSetting('models.openai.apiKey', SETTINGS)).toEqual([]);

    const openaiSelected = selecting('openai');
    expect(
      probesForSetting('models.openai.apiKey', openaiSelected).map(
        (p) => p.name,
      ),
    ).toEqual(['supervisor-model']);
    expect(probesForSetting('models.anthropic.apiKey', openaiSelected)).toEqual(
      [],
    );
  });

  it('names the provider and the slot in what it says it will do', () => {
    const openai = credentialProbes(selecting('openai')).find(
      (probe) => probe.name === 'supervisor-model',
    );

    // The old text said "Anthropic" whichever provider was selected, which
    // after the split is a sentence about the wrong vendor's money.
    expect(openai?.question).toContain('openai');
    expect(openai?.question).toContain('models.openai.apiKey');
    expect(openai?.costNote).toContain('models.openai.apiKey');
    expect(openai?.question).not.toContain('Anthropic');
  });

  it('depends on the provider and on the host the key is sent to', () => {
    // Switching provider or repointing the endpoint makes an answer a fact
    // about a different call — the same reason `github-token` depends on
    // `github.apiBaseUrl`.
    expect(descriptor('supervisor-model').dependsOn).toEqual([
      'models.anthropic.apiKey',
      'models.anthropic.baseUrl',
      'supervisor.model.provider',
      'supervisor.model.name',
    ]);
  });

  it('goes stale the moment the provider changes', () => {
    const before = observation('supervisor-model');
    expect(probeFreshness(before, SETTINGS).state).toBe('current');
    expect(probeFreshness(before, selecting('openai')).state).toBe('stale');
  });

  it('offers no model probe at all when the provider is not published', () => {
    // Nothing in the response then says which credential a Test button would
    // spend money on, and guessing would be the one thing this module must
    // not do.
    const withoutProvider = SETTINGS.filter(
      (entry) => entry.key !== 'supervisor.model.provider',
    );

    expect(
      credentialProbes(withoutProvider).map((probe) => probe.name),
    ).not.toContain('supervisor-model');
    expect(
      probesForSetting('models.anthropic.apiKey', withoutProvider),
    ).toEqual([]);
  });
});

describe('settingWitness', () => {
  it('never includes anything that could be a secret value', () => {
    // The witness exists to notice a rotation. It is built from what the API
    // publishes about a secret and nothing else, so there is no path by which
    // a value could reach it — asserted rather than assumed, since a witness
    // is exactly the sort of "just fingerprint the value" helper that grows a
    // leak later.
    const secret = SETTINGS.find((entry) => entry.key === 'github.token');
    const witness = settingWitness(secret);

    expect(witness).toContain('secret');
    expect(witness).not.toContain('value');
  });

  it('reads an absent key as absent rather than as unchanged', () => {
    expect(settingWitness(undefined)).toBe('absent');
  });
});

describe('probeFreshness', () => {
  it('is current while nothing the probe read has moved', () => {
    expect(probeFreshness(observation('github-token'), SETTINGS)).toEqual({
      state: 'current',
    });
  });

  it('goes stale when the secret it tested is rotated', () => {
    const rotated = withEntry('github.token', {
      hint: '****************9999',
      updatedAt: '2026-08-21T09:00:00.000Z',
      source: 'database',
    });

    const freshness = probeFreshness(observation('github-token'), rotated);

    expect(freshness.state).toBe('stale');
    expect(freshness.state === 'stale' && freshness.reason).toMatch(
      /describes the previous value/i,
    );
  });

  it('goes stale when the secret it tested is cleared back to the environment', () => {
    const cleared = withEntry('runners.claudeCodeLocal.oauthToken', {
      source: 'env',
      updatedAt: null,
    });

    expect(
      probeFreshness(observation('claude-credential'), cleared).state,
    ).toBe('stale');
  });

  it('goes stale when a NON-subject dependency moves', () => {
    // The GitHub token probe reads the base URL too. An answer obtained
    // against api.github.com is not an answer about a GitHub Enterprise host,
    // and a staleness check that only watched the token would say it was.
    const moved = withEntry('github.apiBaseUrl', {
      value: 'https://github.example.com/api/v3',
      source: 'database',
    } as Partial<OperatorSetting>);

    expect(probeFreshness(observation('github-token'), moved).state).toBe(
      'stale',
    );
  });

  it('goes stale on an unsaved edit, and says it is about the stored value', () => {
    const freshness = probeFreshness(observation('github-token'), SETTINGS, [
      'github.token',
    ]);

    expect(freshness.state).toBe('stale');
    expect(freshness.state === 'stale' && freshness.reason).toMatch(
      /unsaved change to github\.token/i,
    );
  });

  it('does not stale on an unsaved edit to a key the probe never reads', () => {
    expect(
      probeFreshness(observation('github-token'), SETTINGS, [
        'dispatch.hardSpendCeilingUsd',
      ]).state,
    ).toBe('current');
  });

  it('refuses to call an unknown probe current', () => {
    const unknown: ProbeObservation = {
      ...observation('github-token'),
      probe: 'invented-probe' as ProbeObservation['probe'],
    };

    expect(probeFreshness(unknown, SETTINGS).state).toBe('stale');
  });
});

describe('the allowance', () => {
  it('states what is left, over what window, from the API alone', () => {
    expect(
      rateLimitSentence({
        limit: 5,
        windowSeconds: 3600,
        remaining: 3,
        resetSeconds: 2820,
      }),
    ).toBe('3 of 5 left in this 60 minutes window, resetting in 47 minutes.');
  });

  it('reads a spent allowance as zero rather than as absent', () => {
    expect(
      rateLimitSentence({
        limit: 5,
        windowSeconds: 3600,
        remaining: 0,
        resetSeconds: 60,
      }),
    ).toContain('0 of 5 left');
  });

  it('formats a duration the way an operator would say it', () => {
    expect(formatDuration(45)).toBe('45 seconds');
    expect(formatDuration(600)).toBe('10 minutes');
    expect(formatDuration(7200)).toBe('2 hours');
  });
});
