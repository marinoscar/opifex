/**
 * Repository and project rows in the API's own serialisation (#404, #405,
 * #406).
 *
 * Written against `apps/api/src/repositories/dto/repository.dto.ts` and
 * `apps/api/src/projects/dto/project.dto.ts`, not against what the UI happens
 * to read. Two details are load-bearing and are the reason this file exists
 * rather than each test building its own object:
 *
 *  - **`retiredAt` and `retiredById` are present and null**, never absent. The
 *    fields are required-and-nullable on the wire. A fixture that omitted them
 *    would make `retiredAt !== null` true for `undefined`, and every card in
 *    every test would silently render as retired — a fixture bug that would
 *    look like a component bug.
 *  - **`budgetCeilingUsd` is a STRING or null.** The column is a Postgres
 *    `DECIMAL` and the API refuses to round it through a JS number, so a
 *    fixture using `50` would test a shape the API never sends.
 *
 * The ids are real v4 UUIDs because the API's own schemas are `z.uuid()`, and
 * a fixture id that zod would reject is a fixture that can never travel the
 * path being asserted.
 */

import type { RepositorySummary } from '../../types/cockpit';
import type { Project } from '../../types/projects';
import type {
  LabelProvisioningReport,
  LabelProvisioningStatus,
  LabelState,
  ProvisionedLabelKind,
} from '../../types/repositoryLabels';

export const REPOSITORY_ID = '11111111-1111-4111-8111-111111111111';
export const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
export const OTHER_PROJECT_ID = '33333333-3333-4333-8333-333333333333';

export function repositoryFixture(
  overrides: Partial<RepositorySummary> = {},
): RepositorySummary {
  return {
    id: REPOSITORY_ID,
    projectId: null,
    owner: 'acme',
    name: 'widgets',
    fullName: 'acme/widgets',
    defaultBranch: 'main',
    observeEnabled: false,
    dispatchEnabled: false,
    mirrorLabelsEnabled: false,
    specFeedbackEnabled: false,
    budgetCeilingUsd: null,
    wallClockTimeoutMinutes: null,
    pathConstraints: [],
    lastObservedAt: null,
    retiredAt: null,
    retiredById: null,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
    ...overrides,
  };
}

export function projectFixture(overrides: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID,
    slug: 'billing-platform',
    name: 'Billing Platform',
    description: 'Everything that takes money.',
    repositoryCount: 0,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Label provisioning reports (#415)
// ---------------------------------------------------------------------------

/**
 * The declared taxonomy, name and kind, exactly as
 * `apps/api/src/github/labels/label-taxonomy.ts` declares it.
 *
 * Copied rather than approximated because "15 of 15" is a number the UI puts
 * on screen, and a fixture that declared three labels would let a component
 * that hard-coded a count pass. If the API's taxonomy grows, this list and the
 * tests that read it are meant to be updated together.
 */
export const DECLARED_LABELS: readonly (readonly [
  string,
  ProvisionedLabelKind,
])[] = [
  ['factory:hold', 'input'],
  ['factory:ready', 'input'],
  ['factory:clear-quarantine', 'input'],
  ['factory/dispatched', 'mirror'],
  ['factory/blocked', 'mirror'],
  ['factory/review', 'mirror'],
  ['factory/quarantine', 'mirror'],
  ['factory/label-ignored', 'mirror'],
  ['needs:full-streaming', 'routing'],
  ['needs:cost-reporting', 'routing'],
  ['needs:structured-rate-limits', 'routing'],
  ['needs:own-infrastructure', 'routing'],
  ['tier:small', 'routing'],
  ['tier:standard', 'routing'],
  ['tier:large', 'routing'],
];

export interface LabelReportOptions {
  repository?: string;
  /** True when the call TRIED to write. Not a claim that anything landed. */
  attempted?: boolean;
  /** Observed as absent from GitHub BEFORE the call. */
  missing?: readonly string[];
  /** Observed as present and out of date, with what differs. */
  drifted?: Readonly<Record<string, string[]>>;
  /** What this call created. Must be named in `missing`. */
  created?: readonly string[];
  /** What this call updated. Must be named in `drifted`. */
  updated?: readonly string[];
  /** What this call tried to write and could not, with GitHub's reason. */
  failed?: Readonly<Record<string, string>>;
  detail?: string;
  checkedAt?: string;
  status?: LabelProvisioningStatus;
}

/**
 * A report from a SUCCESSFUL read of GitHub's labels, so its counts are real.
 *
 * Every count is derived from the named labels rather than passed in, so a
 * test cannot assert against a report whose summary and per-label array
 * disagree — which is a shape the API never produces and which would let a
 * component that reads the wrong one of the two pass. The derivations mirror
 * `label-provisioning.service.ts`'s `answer()`: `present` counts everything
 * that was not missing plus everything this call created, and `unchanged`
 * counts what was already correct.
 *
 * `stateBefore` is left as it was OBSERVED even where `action` says the label
 * was created, because that is what the API does and its field name says so.
 * A fixture that "helpfully" flipped it to `present` after a create would hide
 * exactly the bug that rule exists to catch.
 */
export function labelReportFixture(
  options: LabelReportOptions = {},
): LabelProvisioningReport {
  const missing = options.missing ?? [];
  const drifted = options.drifted ?? {};
  const created = options.created ?? [];
  const updated = options.updated ?? [];
  const failed = options.failed ?? {};

  const labels: LabelState[] = DECLARED_LABELS.map(([name, kind]) => {
    const stateBefore: LabelState['stateBefore'] = missing.includes(name)
      ? 'missing'
      : name in drifted
        ? 'drifted'
        : 'present';
    const action: LabelState['action'] =
      name in failed
        ? 'failed'
        : created.includes(name)
          ? 'created'
          : updated.includes(name)
            ? 'updated'
            : 'none';

    return {
      name,
      kind,
      stateBefore,
      action,
      differences: drifted[name] ?? [],
      detail: failed[name] ?? null,
    };
  });

  const stillMissing = missing.filter((name) => !created.includes(name));
  const present = DECLARED_LABELS.length - stillMissing.length;
  const stillDrifted = Object.keys(drifted).filter(
    (name) => !updated.includes(name),
  );
  const status =
    options.status ??
    (stillMissing.length === 0 &&
    stillDrifted.length === 0 &&
    Object.keys(failed).length === 0
      ? 'ok'
      : 'incomplete');

  return {
    repository: options.repository ?? 'acme/widgets',
    ok: status === 'ok',
    status,
    attempted: options.attempted ?? false,
    detail:
      options.detail ??
      `GitHub answered: ${present} of ${DECLARED_LABELS.length} declared labels are on the repository.`,
    checkedAt: options.checkedAt ?? '2026-08-23T10:00:00.000Z',
    declared: DECLARED_LABELS.length,
    present,
    missing: stillMissing.length,
    created: created.length,
    updated: updated.length,
    unchanged: labels.filter((label) => label.stateBefore === 'present').length,
    failed: Object.keys(failed).length,
    labels,
  };
}

/**
 * A **write-phase** refusal: the labels were read, and GitHub then refused the
 * write (or rate-limited it, or went away) partway through.
 *
 * The shape that keeps `wasRead` honest. `status` is a failure word and the
 * counts are REAL — this call knows exactly what is on the repository and may
 * have created some labels before being cut off — so a gate keyed on `status`
 * would blank a genuine observation. `failed` is 0 rather than the number left
 * over: the service only marks a label `failed` when GitHub refused that
 * particular label, and a refusal about the REPOSITORY stops the loop, leaving
 * the remainder untouched with `action: 'none'`.
 *
 * Built on `labelReportFixture` so the count derivation lives in exactly one
 * place, and the difference between this and a read-phase failure is visible
 * as what it is: which fields are null.
 */
export function labelWriteRefusalFixture(
  options: LabelReportOptions & { status?: LabelProvisioningStatus } = {},
): LabelProvisioningReport {
  return labelReportFixture({
    status: 'refused',
    attempted: true,
    detail:
      'The factory labels could not be created: the credential is not ' +
      'permitted to write labels on this repository.',
    ...options,
  });
}

/**
 * A **read-phase** failure — the labels were never obtained, so **every count
 * is null and `labels` is empty**. That is the whole point of a separate
 * builder for it.
 *
 * Null is not zero: `present: null` beside `declared: null` says nobody was
 * able to look, and a renderer that printed "0 of 15 labels present" from a
 * report like this would state a fact nobody established. Constructing it here
 * once, correctly, keeps the trap intact — building it by hand in each test is
 * how a stray count or a stray label creeps in and quietly removes it.
 */
export function labelFailureFixture(
  status: LabelProvisioningStatus,
  detail: string,
  options: {
    repository?: string;
    attempted?: boolean;
    checkedAt?: string;
  } = {},
): LabelProvisioningReport {
  return {
    repository: options.repository ?? 'acme/widgets',
    ok: false,
    status,
    attempted: options.attempted ?? false,
    detail,
    checkedAt: options.checkedAt ?? '2026-08-23T10:00:00.000Z',
    declared: null,
    present: null,
    missing: null,
    created: null,
    updated: null,
    unchanged: null,
    failed: null,
    labels: [],
  };
}
