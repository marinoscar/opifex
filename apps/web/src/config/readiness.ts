/**
 * The readiness chain — `docs/RUNBOOK-enable-claude-code-local.md`, rendered
 * live (#347, epic #332).
 *
 * The runbook is four ordered steps, and its whole design is that each one has
 * **an observable that proves it — not a list of variables to set and hope
 * about**. This module is that runbook as data: a pure function from whatever
 * the API actually said to a list of steps, each carrying the observation it
 * rests on and the endpoint that produced it.
 *
 * ## Four verdicts, because there are four different situations
 *
 * A three-state green/red/grey would have to fold two very different greys
 * together, and they call for opposite responses:
 *
 *  - `pass` — an observable says so.
 *  - `blocked` — an observable says the opposite.
 *  - `unverifiable` — **no endpoint exists that could answer this**, so
 *    nothing here can be green or red. Structural, not transient; it clears
 *    when #338 ships the probe, not when you reload.
 *  - `unknown` — an endpoint exists and this read did not get an answer: it
 *    failed, or this account is not allowed to ask.
 *
 * `unverifiable` is the load-bearing one, and it is the feature rather than a
 * gap. Epic #324's lesson, which the runbook's failure table calls "the
 * dangerous one": **`claude --version` succeeds without credentials.** So an
 * unauthenticated CLI registers as a healthy, available runner, dispatch
 * routes real work to it, and every run fails at auth after the work order was
 * already authorized. A UI that painted a green check on "credential
 * verifies" because the fleet reported `available: true` would be automating
 * exactly that mistake. Until something actually authenticates, this screen
 * says it does not know.
 *
 * ## Configured and observed are never merged
 *
 * Epic #332's first rule. A step carries `observed` and `configured`
 * separately and renders them side by side; the fleet payload is the one place
 * the API already keeps them apart, with `available` (a probe found this) next
 * to `enabled` (a human permitted this). Nothing here derives one from the
 * other.
 */

import type { ControlCenterSectionKey } from './controlCenter';
import type { FleetHealth, FleetRunnerHealth } from '../types/health';

export type ReadinessVerdict = 'pass' | 'blocked' | 'unverifiable' | 'unknown';

export type ReadinessStepId =
  'binaries' | 'credential' | 'runner' | 'dispatch' | 'repository';

/**
 * One fact, and where it came from.
 *
 * `source` is a real endpoint path and is rendered on screen. A reader must be
 * able to run the same request and get the same sentence — a claim whose
 * origin is not stated is a claim nobody can check.
 */
export interface ReadinessFact {
  source: string;
  statement: string;
}

/** Where to go to change the answer. */
export interface ReadinessFix {
  label: string;
  /** The Control Center section that owns the setting, when one does. */
  section: ControlCenterSectionKey;
  /**
   * What it takes TODAY, when the owning section is still planned. Rendered
   * verbatim so nobody has to guess whether the button they cannot find is
   * missing or unbuilt.
   */
  today?: string;
}

export interface ReadinessStep {
  id: ReadinessStepId;
  /** 1-based, and the order is the runbook's order. */
  ordinal: number;
  title: string;
  /** Why this link in the chain exists at all. */
  purpose: string;
  verdict: ReadinessVerdict;
  /** What a probe found. Null when nothing probed it. */
  observed: ReadinessFact | null;
  /** What a human permitted. Null when no endpoint reports it. */
  configured: ReadinessFact | null;
  /** The sentence explaining this verdict. */
  detail: string;
  /**
   * Something true that the verdict does NOT cover.
   *
   * Step 1 has one because the fleet probes `claude` and nothing probes `git`,
   * so a green there is green about one of the two required binaries.
   */
  caveat?: string;
  fix: ReadinessFix;
}

/** Everything the chain is built from. Every field may be absent or failed. */
export interface ReadinessInputs {
  fleet: FleetHealth | null;
  /** Why the readiness payload could not be read, if it could not. */
  fleetError: string | null;
  repositories: { registered: number; dispatchEnabled: number } | null;
  /** Why the repository counts could not be read, if they could not. */
  repositoriesError: string | null;
}

/** The runner this deployment ships, and the one the runbook is about. */
export const PRIMARY_RUNNER_KEY = 'claude-code-local';

const READY = 'GET /api/health/ready → info.fleet';
const REPOS = 'GET /api/repositories';

/**
 * Pick the runner the chain is about.
 *
 * Prefers `claude-code-local` by key and falls back to the only runner present
 * — a fleet of one is what this build ships, and a second runner (Phase 8)
 * would need its own chain rather than borrowing this one silently.
 */
function primaryRunner(fleet: FleetHealth | null): FleetRunnerHealth | null {
  const runners = fleet?.runners ?? [];
  return (
    runners.find((runner) => runner.key === PRIMARY_RUNNER_KEY) ??
    (runners.length === 1 ? runners[0] : null)
  );
}

function binariesStep(inputs: ReadinessInputs): ReadinessStep {
  const base = {
    id: 'binaries' as const,
    ordinal: 1,
    title: 'The binaries are installed',
    purpose:
      'ADR-0008 makes the agent a child process of the API process, so the ' +
      'CLI and git have to exist in this container.',
    caveat:
      'This covers the Claude CLI only. Nothing probes git, and git is the ' +
      'blocker that fires FIRST — the workspace service shells out to it for ' +
      'clone, checkout and commit before the CLI is ever invoked, so a ' +
      'missing git kills a run at provisioning and never shows up here. ' +
      "Check it directly: docker exec <api> sh -lc 'git --version'.",
    fix: {
      label: 'Rebuild the API image with both binaries',
      section: 'settings' as const,
      today:
        'Both are installed in the Dockerfile base stage (#325). If one is ' +
        'missing the fix is an image rebuild, not a setting.',
    },
  };

  if (!inputs.fleet || !inputs.fleet.checked) {
    return {
      ...base,
      verdict: 'unknown',
      observed: null,
      configured: null,
      detail:
        inputs.fleetError ??
        inputs.fleet?.message ??
        'The fleet could not be read, so the version probe reported nothing.',
    };
  }

  const runner = primaryRunner(inputs.fleet);

  if (!runner) {
    return {
      ...base,
      verdict: 'blocked',
      observed: {
        source: READY,
        statement: `registered: ${inputs.fleet.registered ?? 0}`,
      },
      configured: null,
      detail:
        'No runner is registered, so nothing has probed the binaries. ' +
        'Registration converges on a 60-second tick — if it stays at zero, ' +
        'the API log names what RunnerRegistrationService could not register.',
    };
  }

  if (!runner.available) {
    return {
      ...base,
      verdict: 'blocked',
      observed: {
        source: READY,
        statement:
          `${runner.key} available: false` +
          (runner.unavailableReason ? ` — ${runner.unavailableReason}` : ''),
      },
      configured: null,
      detail:
        'The runner probed itself and reported it cannot work. When the ' +
        'reason names `claude --version`, the CLI is missing or not on PATH ' +
        'and nothing will be dispatched.',
    };
  }

  if (!runner.version) {
    return {
      ...base,
      verdict: 'unknown',
      observed: {
        source: READY,
        statement: `${runner.key} reports no version`,
      },
      configured: null,
      detail:
        'The runner is available but published no version string, so the ' +
        'probe that would prove the CLI ran has nothing to show.',
    };
  }

  return {
    ...base,
    verdict: 'pass',
    observed: {
      source: READY,
      statement: `${runner.key} version ${runner.version}`,
    },
    configured: null,
    detail:
      'This is not configuration — it is what `claude --version` printed, ' +
      'carried through probeVersion() into the capability manifest.',
  };
}

/**
 * Step 2, and it is `unverifiable` unconditionally until #338 lands a probe.
 *
 * See the module header. Nothing in `apps/api` today authenticates the
 * credential, and the one signal that looks like it does — `available: true`
 * — is produced by a command that succeeds without one.
 */
function credentialStep(inputs: ReadinessInputs): ReadinessStep {
  const runner = primaryRunner(inputs.fleet);

  return {
    id: 'credential',
    ordinal: 2,
    title: 'The credential authenticates',
    purpose:
      'A container cannot complete an interactive `claude auth login`, so the ' +
      'credential arrives through the environment and has to be tested.',
    verdict: 'unverifiable',
    observed: null,
    configured: null,
    detail:
      'No endpoint verifies this yet, so this screen will not claim it. ' +
      '`claude --version` succeeds WITHOUT credentials — which is the probe ' +
      'step 1 rests on — so an unauthenticated CLI registers as a healthy, ' +
      'available runner and every dispatched run then fails at auth, after ' +
      'the work order was already authorized. That is the deceptive failure ' +
      'the runbook warns about; a missing binary is the honest one. ' +
      "Test it directly: docker exec <api> sh -lc 'claude -p " +
      '--output-format=text "reply with the single word: ok"\'.',
    caveat: runner?.available
      ? `${runner.key} reports available: true, and that says NOTHING about ` +
        'the credential. It is the version probe, and the version probe ' +
        'passes unauthenticated.'
      : undefined,
    fix: {
      label: 'Set and test the Claude credential',
      section: 'credentials',
      today:
        'Connect on the Claude credential signs in to a Claude account for ' +
        'you and seals the token it produces — no shell, no TTY, no .env ' +
        'edit (#386). A token you already hold can still be pasted there ' +
        'instead. Either way the Credentials section then tests it with a ' +
        'real non-interactive invocation, which is the only check that ' +
        'distinguishes a working credential from a CLI that answers ' +
        '--version without one. CLAUDE_CODE_OAUTH_TOKEN (your subscription ' +
        'quota) or ANTHROPIC_API_KEY (per-token billing) in ' +
        'infra/compose/.env remains the layer underneath, and that one still ' +
        'needs a container recreate. This step reports what /health/ready ' +
        'observed and does not run the probe itself, so it stays "not yet ' +
        'verifiable" here (#349).',
    },
  };
}

function runnerStep(inputs: ReadinessInputs): ReadinessStep {
  const base = {
    id: 'runner' as const,
    ordinal: 3,
    title: 'The runner is enabled and dispatchable',
    purpose:
      'Availability is OBSERVED and enablement is PERMISSION. They move ' +
      'independently, which is why the runbook turns this on while dispatch ' +
      'is still off.',
    fix: {
      label: 'Enable the runner',
      section: 'settings' as const,
      today:
        'CLAUDE_CODE_LOCAL_ENABLED=true in infra/compose/.env, then recreate ' +
        'the api container. #348 brings this key here.',
    },
  };

  if (!inputs.fleet || !inputs.fleet.checked) {
    return {
      ...base,
      verdict: 'unknown',
      observed: null,
      configured: null,
      detail:
        inputs.fleetError ??
        inputs.fleet?.message ??
        'The fleet could not be read.',
    };
  }

  const {
    registered = 0,
    routable = 0,
    enabled = 0,
    dispatchable = 0,
  } = inputs.fleet;
  const runner = primaryRunner(inputs.fleet);

  const observed: ReadinessFact = {
    source: READY,
    statement:
      `registered: ${registered}, routable: ${routable}, ` +
      `dispatchable: ${dispatchable}` +
      (runner ? ` — ${runner.key} available: ${runner.available}` : ''),
  };
  const configured: ReadinessFact = {
    source: READY,
    statement:
      `enabled: ${enabled}` +
      (runner ? ` — ${runner.key} enabled: ${runner.enabled}` : ''),
  };

  if (registered === 0 || routable === 0) {
    return {
      ...base,
      verdict: 'blocked',
      observed,
      configured,
      detail:
        inputs.fleet.message ??
        'Routing can see no runner, so every work order queues. This is a ' +
          'deployment whose code and database disagree — registration is ' +
          'unconditional — rather than a setting.',
    };
  }

  if (enabled === 0) {
    return {
      ...base,
      verdict: 'blocked',
      observed,
      configured,
      detail:
        inputs.fleet.message ??
        'Every registered runner is switched off. Nothing will be ' +
          'dispatched until one is enabled — a configuration choice, not a ' +
          'failure.',
    };
  }

  if (dispatchable === 0) {
    return {
      ...base,
      verdict: 'blocked',
      observed,
      configured,
      detail:
        inputs.fleet.message ??
        'A runner is enabled and none reports it can take work right now. ' +
          'Each names its own reason above.',
    };
  }

  return {
    ...base,
    verdict: 'pass',
    observed,
    configured,
    detail:
      'Permitted and capable at the same time. These are two separate facts ' +
      'and both had to be true.',
  };
}

/**
 * Step 4, and it is `unverifiable` until #338 exposes the flag.
 *
 * `DISPATCH_ENABLED` is read by `RunExecutorService` out of config and is
 * published by no endpoint. The queue's `waitingOn` is prose written for a
 * human, and inferring a global flag from it would be a restatement dressed as
 * an observation — the thing this screen exists not to do.
 */
function dispatchStep(): ReadinessStep {
  return {
    id: 'dispatch',
    ordinal: 4,
    title: 'Dispatch is enabled',
    purpose:
      'The queue drains to no runner at all while this is off, whatever the ' +
      'fleet says. It is deliberately independent of the runner switch.',
    verdict: 'unverifiable',
    observed: null,
    configured: null,
    detail:
      'No endpoint reports the global dispatch flag today, so this screen ' +
      'does not guess. It could be inferred from work orders sitting in the ' +
      'queue, and that would be wrong: a work order waits for a dozen ' +
      'reasons and only one of them is this. #338 publishes the flag.',
    fix: {
      label: 'Enable dispatch',
      section: 'settings',
      today:
        'DISPATCH_ENABLED=true in infra/compose/.env, then recreate the api ' +
        'container. Turn it on only after step 2 passes — see ' +
        'docs/RUNBOOK-observation-week.md.',
    },
  };
}

function repositoryStep(inputs: ReadinessInputs): ReadinessStep {
  const base = {
    id: 'repository' as const,
    ordinal: 5,
    title: 'At least one repository may be dispatched into',
    purpose:
      'Per-repository dispatch is how the observation week ends — one ' +
      'repository at a time rather than globally.',
    fix: {
      label: 'Enable a repository',
      section: 'repositories' as const,
      today:
        'The enablement ladder lives on the Projects destination (#406). ' +
        'The Repositories section here points at it.',
    },
  };

  if (inputs.repositoriesError) {
    return {
      ...base,
      verdict: 'unknown',
      observed: null,
      configured: null,
      detail: inputs.repositoriesError,
    };
  }

  if (!inputs.repositories) {
    return {
      ...base,
      verdict: 'unknown',
      observed: null,
      configured: null,
      detail: 'The repository list has not been read yet.',
    };
  }

  const { registered, dispatchEnabled } = inputs.repositories;

  const configured: ReadinessFact = {
    source: `${REPOS}?dispatchEnabled=true`,
    statement: `${dispatchEnabled} of ${registered} registered`,
  };

  if (registered === 0) {
    return {
      ...base,
      verdict: 'blocked',
      observed: null,
      configured,
      detail:
        'No repository is registered. Opifex only observes repositories it ' +
        'has been told about, and registration verifies the repository is ' +
        'reachable with the configured token before accepting it.',
    };
  }

  if (dispatchEnabled === 0) {
    return {
      ...base,
      verdict: 'blocked',
      observed: null,
      configured,
      detail:
        `${registered} repositor${registered === 1 ? 'y is' : 'ies are'} ` +
        'registered and none may be dispatched into, so the factory has ' +
        'nowhere to work even with everything above green.',
    };
  }

  return {
    ...base,
    verdict: 'pass',
    observed: null,
    configured,
    detail:
      'This is a PERMISSION and nothing probes it — the count says what an ' +
      'operator allowed, not that a run has ever succeeded there.',
  };
}

/**
 * The chain, in the runbook's order.
 *
 * Pure, so the interesting cases — a fleet that could not be read, a runner
 * available but disabled, a 403 on repositories — are unit-testable without a
 * React tree or a server.
 */
export function buildReadinessChain(inputs: ReadinessInputs): ReadinessStep[] {
  return [
    binariesStep(inputs),
    credentialStep(inputs),
    runnerStep(inputs),
    dispatchStep(),
    repositoryStep(inputs),
  ];
}

/**
 * A one-line summary of the chain, for the section header.
 *
 * Counts rather than a single verdict: "3 of 5 verified, 2 not yet verifiable"
 * is a sentence an operator can act on, and a single amber dot is not.
 */
export interface ReadinessSummary {
  pass: number;
  blocked: number;
  unverifiable: number;
  unknown: number;
  total: number;
}

export function summariseReadiness(steps: ReadinessStep[]): ReadinessSummary {
  return {
    pass: steps.filter((step) => step.verdict === 'pass').length,
    blocked: steps.filter((step) => step.verdict === 'blocked').length,
    unverifiable: steps.filter((step) => step.verdict === 'unverifiable')
      .length,
    unknown: steps.filter((step) => step.verdict === 'unknown').length,
    total: steps.length,
  };
}
