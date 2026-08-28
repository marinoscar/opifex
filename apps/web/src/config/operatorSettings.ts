/**
 * How an operator setting is PRESENTED, given only what the API said
 * (#348, epic #332).
 *
 * ## Nothing here enumerates keys
 *
 * The acceptance criterion for #348 is that adding a key to
 * `apps/api/src/settings/operator-settings/operator-settings.registry.ts`
 * requires no frontend edit. Every function below therefore takes the entry
 * and reads its own fields — `type` chooses the control, `reload` chooses the
 * chip, `group` chooses the heading — and the only lookup tables are over
 * CLOSED vocabularies the API publishes (`RELOAD_SEMANTICS`,
 * `OperatorSettingSource`), each with a fallback so an unrecognised member
 * degrades to something readable rather than to a blank.
 *
 * `GROUP_LABELS` is the one table keyed by an open vocabulary, and it is
 * deliberately a preference rather than a requirement: a group the registry
 * grows tomorrow gets a title-cased heading and appears after the known ones.
 * A missing entry costs a nicer noun, never a hidden section — and
 * `__tests__/config/operatorSettings.test.ts` asserts exactly that.
 *
 * ## The reload chip is quoted, never inferred
 *
 * The three sentences below are the registry's own semantics, restated for an
 * operator. The UI never decides that a setting is live because it looks like
 * it should be: `reload` comes off the response, and a key whose consumer
 * cannot honour it is a bug in the consumer that the registry already tracks
 * (see the registry header on `github.*`, `reconciler.enabled` and the
 * supervisor model settings).
 */

import { PRIMARY_RUNNER_KEY } from './readiness';
import type { FleetHealth } from '../types/health';
import type {
  OperatorSetting,
  OperatorSettingSource,
  ReloadSemantics,
} from '../types/operatorSettings';

// ---------------------------------------------------------------------------
// Reload semantics
// ---------------------------------------------------------------------------

export interface ReloadPresentation {
  /** The chip's text. */
  label: string;
  /** What that actually means, on the chip's tooltip and in the row. */
  help: string;
  /** A MUI palette key, chosen by consequence rather than by good/bad. */
  color: 'success' | 'info' | 'warning' | 'default';
}

const RELOAD_PRESENTATION: Record<ReloadSemantics, ReloadPresentation> = {
  live: {
    label: 'live',
    help:
      'Nothing holds a copy of this value. The next read decides, and no work ' +
      'in flight contradicts it.',
    color: 'success',
  },
  'next-unit': {
    label: 'applies to new runs',
    help:
      'Work already in flight carries the old value — in an armed timer, in a ' +
      "spawned process's arguments, or as occupancy a lowered ceiling cannot " +
      'retroactively shrink. Nothing running is interrupted.',
    color: 'info',
  },
  restart: {
    label: 'restart required',
    help:
      'Nothing re-reads this while the process lives. The saved value is ' +
      'stored, and the API has to be restarted before it is in force.',
    color: 'warning',
  },
};

/**
 * The chip for a `reload` value, including one this build has never heard of.
 *
 * The fallback prints the raw string rather than guessing at a colour or
 * silently choosing `live`, which would be the UI inventing a claim about when
 * a change takes effect — the one thing this chip exists not to do.
 */
export function reloadPresentation(reload: string): ReloadPresentation {
  return (
    RELOAD_PRESENTATION[reload as ReloadSemantics] ?? {
      label: reload,
      help:
        'This build does not recognise that reload semantics, so it will not ' +
        'guess when the change takes effect.',
      color: 'default',
    }
  );
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export interface ProvenancePresentation {
  label: string;
  detail: string;
}

/**
 * Where the value in force came from, in the operator's words.
 *
 * Three layers, not two. The issue names "from environment" and "overridden
 * here", and `default` is the third the API really returns: nobody has set
 * this anywhere, and saying "from environment" there would name a variable
 * that is not set.
 */
export function provenanceOf(entry: OperatorSetting): ProvenancePresentation {
  const source: OperatorSettingSource = entry.source;

  if (source === 'database') {
    return {
      label: 'overridden here',
      detail:
        `Stored in this deployment's settings, which takes precedence over ` +
        `${entry.envVar}.`,
    };
  }

  if (source === 'env') {
    return {
      label: 'from environment',
      detail: `Read from ${entry.envVar}. Nothing is stored here for this key.`,
    };
  }

  return {
    label: 'built-in default',
    detail: `Neither ${entry.envVar} nor a stored value is set, so the code's own default applies.`,
  };
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

/**
 * Nicer headings for the groups that exist today, and an ORDER for them.
 *
 * A group absent from this table still renders — see `groupSettings` — which
 * is the difference between a preference and a registry.
 */
const GROUP_LABELS: Record<string, string> = {
  github: 'GitHub',
  runner: 'Execution',
  dispatch: 'Dispatch',
  reconciler: 'Observation',
  // The credential slots, one per model provider (#422). "Model credentials"
  // rather than "Models", because what is filed here is a key and a host and
  // not a choice of model — the model itself is a supervisor setting.
  models: 'Model credentials',
  supervisor: 'Supervisor',
  promotion: 'Autonomy',
  notifications: 'Notifications',
};

/** The order known groups appear in. Unknown ones follow, as they arrive. */
const GROUP_ORDER: readonly string[] = [
  'github',
  'runner',
  'dispatch',
  'reconciler',
  'models',
  'supervisor',
  'promotion',
  'notifications',
];

/** A heading for a group name, title-casing one nobody has named yet. */
export function groupLabel(group: string): string {
  return GROUP_LABELS[group] ?? titleCase(group);
}

function titleCase(value: string): string {
  const spaced = value
    .replace(/[._-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export interface SettingsGroupView {
  group: string;
  label: string;
  entries: OperatorSetting[];
}

/**
 * The response, grouped for rendering — and nothing dropped.
 *
 * Known groups come first in `GROUP_ORDER`, then any group the response
 * carried that this build has never seen, in the order the API listed them
 * (which is registry order). Entries keep their response order within a group,
 * because that order is the registry's and the registry's order is considered.
 */
export function groupSettings(
  settings: readonly OperatorSetting[],
): SettingsGroupView[] {
  const byGroup = new Map<string, OperatorSetting[]>();

  for (const entry of settings) {
    const bucket = byGroup.get(entry.group);
    if (bucket) bucket.push(entry);
    else byGroup.set(entry.group, [entry]);
  }

  const known = GROUP_ORDER.filter((group) => byGroup.has(group));
  const unknown = [...byGroup.keys()].filter(
    (group) => !GROUP_ORDER.includes(group),
  );

  return [...known, ...unknown].map((group) => ({
    group,
    label: groupLabel(group),
    entries: byGroup.get(group) ?? [],
  }));
}

// ---------------------------------------------------------------------------
// The observed counterpart
// ---------------------------------------------------------------------------

/** One thing a probe actually found, and the endpoint that reported it. */
export interface ObservedFact {
  statement: string;
  source: string;
  /**
   * True when the observation contradicts the configured value — the sentence
   * epic #332 exists to make sayable. Never used to CHANGE the configured
   * value shown, only to draw attention to the pair.
   */
  disagrees: boolean;
}

const FLEET_SOURCE = 'GET /api/health/ready → info.fleet';

/**
 * What the fleet observed about a setting, when it observed anything.
 *
 * The fleet payload is the only place the API publishes an observation of a
 * managed setting today: `enabled` is a human's permission and `maxConcurrency`
 * is the limit the runner registered itself with, both read back from the
 * runner rather than from the configuration that produced them.
 *
 * A key with no observation returns null and the row simply shows its
 * configured value — which is the honest rendering, and is what every key a
 * later release adds will get until something probes it. Nothing here is
 * required for a key to render.
 */
export function observedFor(
  entry: OperatorSetting,
  fleet: FleetHealth | null,
): ObservedFact | null {
  if (entry.secret) return null;

  const runner =
    fleet?.runners?.find((candidate) => candidate.key === PRIMARY_RUNNER_KEY) ??
    (fleet?.runners?.length === 1 ? fleet.runners[0] : null);

  if (!runner) return null;

  if (entry.key === 'runners.claudeCodeLocal.enabled') {
    return {
      statement: `${runner.key} enabled: ${runner.enabled}`,
      source: FLEET_SOURCE,
      disagrees: runner.enabled !== (entry.value === true),
    };
  }

  if (entry.key === 'runners.claudeCodeLocal.maxConcurrency') {
    return {
      statement: `${runner.key} registered maxConcurrency: ${runner.maxConcurrency}`,
      source: FLEET_SOURCE,
      disagrees: runner.maxConcurrency !== entry.value,
    };
  }

  if (entry.key === 'runners.claudeCodeLocal.binary') {
    return {
      statement: runner.version
        ? `${runner.key} reports version ${runner.version}`
        : `${runner.key} reports no version`,
      source: FLEET_SOURCE,
      // A version string is not comparable to a binary path, so this pair is
      // shown side by side and never judged. `claude --version` succeeding
      // says nothing about the credential either — see `config/readiness.ts`.
      disagrees: false,
    };
  }

  return null;
}
