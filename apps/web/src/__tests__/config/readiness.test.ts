/**
 * The readiness chain (#347, epic #332).
 *
 * The builder is pure, so the cases worth testing are the ones that are hard
 * to produce against a real deployment: a fleet that could not be read, a
 * runner that is available and switched off at the same time, a 403 on the
 * repository list. Each of those is a DIFFERENT claim about the world and the
 * chain must not collapse any two of them together.
 */

import { describe, expect, it } from 'vitest';

import {
  PRIMARY_RUNNER_KEY,
  buildReadinessChain,
  summariseReadiness,
  type ReadinessInputs,
  type ReadinessStepId,
} from '../../config/readiness';
import { CONTROL_CENTER_SECTIONS } from '../../config/controlCenter';
import type { FleetHealth } from '../../types/health';

/**
 * The reference deployment's fleet, verbatim from
 * `docs/RUNBOOK-enable-claude-code-local.md` step 3 — captured after the epic
 * #324 rebuild and before any flag was flipped.
 */
const RUNBOOK_FLEET: FleetHealth = {
  status: 'up',
  checked: true,
  registered: 1,
  routable: 1,
  enabled: 0,
  dispatchable: 0,
  runners: [
    {
      key: PRIMARY_RUNNER_KEY,
      version: '2.1.246',
      enabled: false,
      available: true,
      maxConcurrency: 2,
    },
  ],
  message:
    'All 1 registered runner(s) are disabled. Nothing will be dispatched ' +
    'until one is switched on — this is a configuration choice, not a failure.',
};

function inputs(overrides: Partial<ReadinessInputs> = {}): ReadinessInputs {
  return {
    fleet: RUNBOOK_FLEET,
    fleetError: null,
    repositories: { registered: 2, dispatchEnabled: 1 },
    repositoriesError: null,
    ...overrides,
  };
}

function step(id: ReadinessStepId, given: ReadinessInputs = inputs()) {
  const found = buildReadinessChain(given).find((entry) => entry.id === id);
  if (!found) throw new Error(`no step ${id}`);
  return found;
}

describe('readiness chain — shape', () => {
  it('is the runbook chain, in the runbook order', () => {
    // The order is the argument: each step is only meaningful once the one
    // above it holds, which is why the runbook insists on doing them in
    // sequence rather than flipping both enable flags at once.
    expect(buildReadinessChain(inputs()).map((entry) => entry.id)).toEqual([
      'binaries',
      'credential',
      'runner',
      'dispatch',
      'repository',
    ]);
  });

  it('numbers the steps from one, matching their order', () => {
    expect(buildReadinessChain(inputs()).map((entry) => entry.ordinal)).toEqual(
      [1, 2, 3, 4, 5],
    );
  });

  it('points every fix at a section the Control Center really has', () => {
    // A fix button that navigates to a section key nothing renders would be a
    // dead end, and the registry is the only place that knows.
    const keys = CONTROL_CENTER_SECTIONS.map((section) => section.key);
    for (const entry of buildReadinessChain(inputs())) {
      expect(keys, `${entry.id} points at ${entry.fix.section}`).toContain(
        entry.fix.section,
      );
    }
  });
});

describe('readiness chain — configured and observed stay apart', () => {
  it('reports available and enabled as two separate facts', () => {
    // Epic #332's first rule, and epic #324's finding. This is the exact
    // payload the runbook records: the container CAN work and nobody has
    // permitted it to. Merging them into one boolean loses the whole message.
    const runner = step('runner');

    expect(runner.observed?.statement).toContain('available: true');
    expect(runner.configured?.statement).toContain('enabled: 0');
    expect(runner.verdict).toBe('blocked');
  });

  it('names the endpoint behind every fact it states', () => {
    for (const entry of buildReadinessChain(inputs())) {
      for (const fact of [entry.observed, entry.configured]) {
        if (fact) expect(fact.source).toMatch(/^GET \/api\//);
      }
    }
  });

  it('reads the version as an observation, not as configuration', () => {
    const binaries = step('binaries');
    expect(binaries.verdict).toBe('pass');
    expect(binaries.observed?.statement).toContain('2.1.246');
    // Nothing CONFIGURES a version. Leaving the configured half empty is the
    // honest answer, and the card renders that emptiness explicitly.
    expect(binaries.configured).toBeNull();
  });
});

describe('readiness chain — the unverifiable steps', () => {
  it('never claims the credential authenticates', () => {
    // The #324 lesson: `claude --version` succeeds without credentials, so a
    // green check inferred from `available: true` would be automating the
    // deceptive failure. Even with a perfectly healthy fleet this stays amber.
    const credential = step(
      'credential',
      inputs({
        fleet: {
          ...RUNBOOK_FLEET,
          enabled: 1,
          dispatchable: 1,
          runners: [
            { ...RUNBOOK_FLEET.runners![0], enabled: true, available: true },
          ],
        },
      }),
    );

    expect(credential.verdict).toBe('unverifiable');
    expect(credential.observed).toBeNull();
    expect(credential.caveat).toContain('says NOTHING about the credential');
  });

  it('never claims dispatch is on', () => {
    // No endpoint publishes DISPATCH_ENABLED. Inferring it from a queue that
    // is not draining would be a restatement dressed as an observation.
    const dispatch = step('dispatch');
    expect(dispatch.verdict).toBe('unverifiable');
    expect(dispatch.observed).toBeNull();
    expect(dispatch.configured).toBeNull();
  });

  it('keeps "no probe exists" distinct from "this read failed"', () => {
    // Two greys with two different remedies: one clears when #338 ships, the
    // other when the request succeeds. A shared verdict would ask the operator
    // to guess which they are looking at.
    const chain = buildReadinessChain(
      inputs({ repositoriesError: 'needs projects:read' }),
    );

    expect(chain.find((e) => e.id === 'dispatch')?.verdict).toBe(
      'unverifiable',
    );
    expect(chain.find((e) => e.id === 'repository')?.verdict).toBe('unknown');
  });
});

describe('readiness chain — the binaries step', () => {
  it('blocks and quotes the reason when the runner reports unavailable', () => {
    const binaries = step(
      'binaries',
      inputs({
        fleet: {
          ...RUNBOOK_FLEET,
          runners: [
            {
              key: PRIMARY_RUNNER_KEY,
              version: null,
              enabled: false,
              available: false,
              unavailableReason: 'claude --version failed',
              maxConcurrency: 2,
            },
          ],
        },
      }),
    );

    expect(binaries.verdict).toBe('blocked');
    expect(binaries.observed?.statement).toContain('claude --version failed');
  });

  it('blocks when nothing is registered at all', () => {
    const binaries = step(
      'binaries',
      inputs({
        fleet: { ...RUNBOOK_FLEET, registered: 0, routable: 0, runners: [] },
      }),
    );
    expect(binaries.verdict).toBe('blocked');
  });

  it('says out loud that nothing probes git', () => {
    // git is the blocker that fires FIRST and never appears in the health
    // payload — the version probe passes and the fleet looks fine while a run
    // dies at workspace provisioning. A green step 1 that did not say so
    // would be the most misleading thing on the screen.
    expect(step('binaries').caveat).toContain('git');
  });

  it('reports "could not read" rather than a failure when the fleet is unreadable', () => {
    const binaries = step(
      'binaries',
      inputs({ fleet: null, fleetError: 'the API answered 503' }),
    );
    expect(binaries.verdict).toBe('unknown');
    expect(binaries.detail).toContain('503');
  });
});

describe('readiness chain — the runner step', () => {
  it('passes only when a runner is both permitted and capable', () => {
    const runner = step(
      'runner',
      inputs({
        fleet: {
          ...RUNBOOK_FLEET,
          enabled: 1,
          dispatchable: 1,
          message: undefined,
          runners: [
            { ...RUNBOOK_FLEET.runners![0], enabled: true, available: true },
          ],
        },
      }),
    );
    expect(runner.verdict).toBe('pass');
  });

  it('says "switched off" specifically when enablement is what is missing', () => {
    // Pins the enabled===0 branch on its own. Without this the case is only
    // covered incidentally by a fixture where dispatchable is also zero, and
    // deleting the branch entirely would still leave the suite green — which
    // mutation testing found it doing.
    const off = step(
      'runner',
      inputs({ fleet: { ...RUNBOOK_FLEET, message: undefined } }),
    );

    expect(off.verdict).toBe('blocked');
    expect(off.detail).toContain('switched off');
  });

  it('separates "switched off" from "cannot work right now"', () => {
    // Both are `blocked` and both need a different action: one is a flag, the
    // other is a container. The detail is what carries the difference.
    const off = step('runner');
    const spent = step(
      'runner',
      inputs({
        fleet: {
          ...RUNBOOK_FLEET,
          enabled: 1,
          dispatchable: 0,
          message: 'All 1 enabled runner(s) report they cannot take work.',
          runners: [
            {
              ...RUNBOOK_FLEET.runners![0],
              enabled: true,
              available: false,
              unavailableReason: 'rate limited',
            },
          ],
        },
      }),
    );

    expect(off.detail).not.toEqual(spent.detail);
    expect(spent.detail).toContain('cannot take work');
  });
});

describe('readiness chain — the repository step', () => {
  it('passes when at least one repository may be dispatched into', () => {
    expect(step('repository').verdict).toBe('pass');
  });

  it('blocks differently for "none registered" and "none enabled"', () => {
    const none = step(
      'repository',
      inputs({ repositories: { registered: 0, dispatchEnabled: 0 } }),
    );
    const registeredOnly = step(
      'repository',
      inputs({ repositories: { registered: 3, dispatchEnabled: 0 } }),
    );

    expect(none.verdict).toBe('blocked');
    expect(registeredOnly.verdict).toBe('blocked');
    expect(none.detail).not.toEqual(registeredOnly.detail);
    expect(registeredOnly.configured?.statement).toBe('0 of 3 registered');
  });

  it('reports a forbidden read as unknown, never as zero', () => {
    // A 403 is bad news about the ACCOUNT. Rendering it as "0 repositories"
    // would be a measurement nobody took, shown to somebody who would act on
    // it.
    const forbidden = step(
      'repository',
      inputs({
        repositories: null,
        repositoriesError: 'needs `projects:read`, which this account lacks',
      }),
    );

    expect(forbidden.verdict).toBe('unknown');
    expect(forbidden.detail).toContain('projects:read');
    expect(forbidden.configured).toBeNull();
  });
});

describe('summariseReadiness', () => {
  it('counts each verdict rather than concluding', () => {
    // No overall "ready" boolean exists on purpose: two of the five steps have
    // no probe behind them, so any single verdict would rest on facts nobody
    // checked.
    const summary = summariseReadiness(buildReadinessChain(inputs()));

    expect(summary).toEqual({
      pass: 2,
      blocked: 1,
      unverifiable: 2,
      unknown: 0,
      total: 5,
    });
  });

  it('accounts for every step exactly once', () => {
    const summary = summariseReadiness(
      buildReadinessChain(
        inputs({ fleet: null, fleetError: 'down', repositoriesError: '403' }),
      ),
    );
    expect(
      summary.pass + summary.blocked + summary.unverifiable + summary.unknown,
    ).toBe(summary.total);
  });
});
