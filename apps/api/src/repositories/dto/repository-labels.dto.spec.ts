import {
  LABEL_PROVISIONING_STATUSES,
  type LabelProvisioningReport,
} from '../../github/labels/label-provisioning.service';
import {
  labelProvisioningReportSchema,
  registeredRepositorySchema,
} from './repository-labels.dto';

/**
 * The schema and the interface the service actually returns must agree.
 *
 * Nothing else checks this. The global `ZodValidationPipe` validates INPUT;
 * a handler's return value is never parsed, and `@ApiDataResponse` only
 * publishes the schema — so a field renamed on `LabelProvisioningReport` and
 * not on `labelProvisioningReportSchema` typechecks, runs, serves the new name
 * to every client, and documents the old one. The generated SDK would then
 * carry a field that is never populated.
 *
 * These parse a real report through the schema, which is the cheapest way to
 * make that drift a failing test instead of a support question.
 */

/** A report as the service builds one after a successful read. */
function readReport(
  overrides: Partial<LabelProvisioningReport> = {},
): LabelProvisioningReport {
  return {
    repository: 'acme/app',
    ok: true,
    status: 'ok',
    attempted: true,
    detail: 'All 15 factory labels are present on acme/app.',
    checkedAt: '2026-08-28T02:00:00.000Z',
    declared: 15,
    present: 15,
    missing: 0,
    created: 15,
    updated: 0,
    unchanged: 0,
    failed: 0,
    labels: [
      {
        name: 'factory:ready',
        kind: 'input',
        stateBefore: 'missing',
        action: 'created',
        differences: [],
        detail: null,
      },
    ],
    ...overrides,
  };
}

/** A report whose read never happened: every count null, no labels. */
function unreadReport(): LabelProvisioningReport {
  return readReport({
    ok: false,
    status: 'refused',
    declared: null,
    present: null,
    missing: null,
    created: null,
    updated: null,
    unchanged: null,
    failed: null,
    labels: [],
  });
}

describe('labelProvisioningReportSchema', () => {
  it('accepts a report the service actually produces', () => {
    expect(() =>
      labelProvisioningReportSchema.parse(readReport()),
    ).not.toThrow();
  });

  it('accepts an unread report, with every count null', () => {
    // The whole point of the nullable fields. A schema that still required
    // numbers here would reject the most important failure response.
    expect(() =>
      labelProvisioningReportSchema.parse(unreadReport()),
    ).not.toThrow();
  });

  it('publishes `attempted`, not `applied`', () => {
    // `applied: true` on a refused repair that wrote nothing was the
    // objection: the name reads as a claim about the outcome, and the outcome
    // is `status`, `created` and `failed`.
    const parsed = labelProvisioningReportSchema.parse(readReport());

    expect(parsed).toHaveProperty('attempted');
    expect(parsed).not.toHaveProperty('applied');
  });

  it('publishes `stateBefore` on a label, not `state`', () => {
    // The field is deliberately not updated after a successful write, so a
    // present-tense name would be false exactly when a client reads it.
    const parsed = labelProvisioningReportSchema.parse(readReport());

    expect(parsed.labels[0]).toHaveProperty('stateBefore');
    expect(parsed.labels[0]).not.toHaveProperty('state');
  });

  it('rejects a count that is neither a number nor null', () => {
    // Guards the guard: `.nullable()` must not have been widened to
    // `.optional()` or `z.any()`, either of which would let an undefined count
    // through as if it were a considered null.
    expect(() =>
      labelProvisioningReportSchema.parse(
        readReport({ present: 'many' as unknown as number }),
      ),
    ).toThrow();
  });

  it('admits every status the service can emit', () => {
    // A status added to the service and not to the enum would be a response
    // the schema describes wrongly — and, since output is not parsed, only
    // discovered by whatever consumes the document.
    for (const status of LABEL_PROVISIONING_STATUSES) {
      expect(() =>
        labelProvisioningReportSchema.parse(readReport({ status })),
      ).not.toThrow();
    }
  });
});

describe('registeredRepositorySchema', () => {
  const repository = {
    id: '11111111-1111-4111-8111-111111111111',
    projectId: null,
    owner: 'acme',
    name: 'app',
    fullName: 'acme/app',
    defaultBranch: 'main',
    observeEnabled: true,
    dispatchEnabled: false,
    mirrorLabelsEnabled: false,
    specFeedbackEnabled: false,
    budgetCeilingUsd: null,
    wallClockTimeoutMinutes: null,
    pathConstraints: [],
    lastObservedAt: null,
    retiredAt: null,
    retiredById: null,
    createdAt: '2026-08-28T02:00:00.000Z',
    updatedAt: '2026-08-28T02:00:00.000Z',
  };

  it('carries the provisioning report alongside the repository', () => {
    const parsed = registeredRepositorySchema.parse({
      ...repository,
      labelProvisioning: unreadReport(),
    });

    expect(parsed.labelProvisioning?.status).toBe('refused');
    expect(parsed.labelProvisioning?.present).toBeNull();
  });

  it('admits a null report, for the case where provisioning itself threw', () => {
    expect(() =>
      registeredRepositorySchema.parse({
        ...repository,
        labelProvisioning: null,
      }),
    ).not.toThrow();
  });
});
