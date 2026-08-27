import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GitHubHttpService } from '../github/github-http.service';
import { GitHubNotFoundError } from '../github/github.errors';
import {
  ALL_INPUT_LABELS,
  ALL_MIRROR_LABELS,
  INPUT_LABELS,
} from '../github/labels/factory-labels';
import {
  MODEL_TIER_BY_LABEL,
  NEEDS_BY_LABEL,
} from '../github/labels/ignored-labels';
import { RateLimitService } from '../github/rate-limit.service';
import { GitHubReadService } from '../github/read/github-read.service';
import { PrismaService } from '../prisma/prisma.service';
import { RepositoriesService } from '../repositories/repositories.service';
import { makeOperatorSettings } from '../settings/operator-settings/operator-settings.test-double';
import { WorkOrderProjectionService } from '../work-orders/work-order-projection.service';
import { ReconcilerService } from './reconciler.service';
import { ReconcileLogService } from './log/reconcile-log.service';
import { TickLeaseService } from './tick-lease.service';

/**
 * The input labels are the operator's steering wheel (VISION §3.3):
 *
 * > You steer from GitHub. Machine state lives where machine state belongs.
 *
 * These exercise them through a WHOLE TICK rather than against the projection
 * directly, because the interesting half of #49 is the part the projection
 * cannot do: resolving who applied `factory:clear-quarantine` from the issue
 * timeline.
 */

function ghIssue(number: number, inputLabels: string[]) {
  return {
    number,
    title: `issue ${number}`,
    body: null,
    state: 'open' as const,
    author: 'marinoscar',
    labels: inputLabels.map((name) => ({
      name,
      color: 'ededed',
      description: null,
    })),
    inputLabels,
    unknownInputLabels: [],
    ignoredLabels: [],
    observedMirrorLabels: [],
    isPullRequest: false,
    url: `https://github.com/acme/app/issues/${number}`,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-02T00:00:00Z'),
  };
}

/**
 * A projection pass that produced nothing.
 *
 * These suites drive the tick with a live GitHub double and a Prisma double;
 * the projection has its own suite, and letting it run here would make every
 * label assertion depend on a work order write.
 */
function emptyProjection() {
  return {
    created: [],
    heldOnCreate: 0,
    alreadyPresent: 0,
    holdsApplied: 0,
    holdsLifted: 0,
    rejected: [],
    skipped: {},
  };
}

describe('factory input labels, through a whole tick', () => {
  let github: { listIssues: jest.Mock; wasLabelAppliedByHuman: jest.Mock };
  let prisma: {
    repository: { update: jest.Mock };
    workOrder: { findMany: jest.Mock };
  };
  let service: ReconcilerService;

  function tickWith(inputLabels: string[], workOrders: unknown[] = []) {
    github.listIssues.mockResolvedValue({
      issues: [ghIssue(312, inputLabels)],
      truncated: false,
      allFromCache: false,
    });
    prisma.workOrder.findMany.mockResolvedValue(workOrders);
    return service.tick();
  }

  function quarantinedWorkOrder() {
    return {
      id: 'wo',
      identity: 'wo_app_312_a3f91c2_a1',
      issueNumber: 312,
      attempt: 1,
      status: 'quarantined',
      runs: [],
    };
  }

  beforeEach(() => {
    github = {
      listIssues: jest.fn(),
      wasLabelAppliedByHuman: jest.fn().mockResolvedValue(false),
    };
    prisma = {
      repository: { update: jest.fn().mockResolvedValue({}) },
      workOrder: { findMany: jest.fn().mockResolvedValue([]) },
    };

    service = new ReconcilerService(
      makeOperatorSettings({
        overrides: {
          'reconciler.enabled': true,
          'github.rateLimitReserve': 100,
        },
      }),
      {
        withLease: jest.fn(async (work: () => Promise<unknown>) => ({
          acquired: true,
          result: await work(),
        })),
      } as unknown as TickLeaseService,
      {
        listObserved: jest.fn().mockResolvedValue([
          {
            id: 'repo',
            owner: 'acme',
            name: 'app',
            observeEnabled: true,
            dispatchEnabled: true,
            budgetCeilingUsd: null,
          },
        ]),
      } as unknown as RepositoriesService,
      github as unknown as GitHubReadService,
      {
        canSpend: jest.fn().mockReturnValue(true),
      } as unknown as GitHubHttpService,
      new RateLimitService(),
      prisma as unknown as PrismaService,
      // Recording is a separate concern from reconciling — these suites are
      // about what the tick DECIDES, and #50's own spec covers persistence.
      {
        record: jest.fn().mockResolvedValue(undefined),
      } as unknown as ReconcileLogService,
      // These tests are about what an input LABEL makes the tick decide. The
      // projection has its own suite; a double keeps a work order write out of
      // assertions about intents.
      {
        project: jest.fn().mockResolvedValue(emptyProjection()),
      } as unknown as WorkOrderProjectionService,
    );
  });

  describe('factory:hold', () => {
    it('takes effect on the next tick and overrides everything', async () => {
      const record = await tickWith([INPUT_LABELS.HOLD, INPUT_LABELS.READY]);

      expect(record.projections[0].issues[0].intent).toBe('hold');
      expect(record.actions.map((a) => a.type)).toEqual(['hold']);
    });

    it('is honoured as promptly when REMOVED as when added', async () => {
      // #49. True because the projection is recomputed from scratch — there is
      // no held-state to clear, which is the reconciler-vs-queue property.
      const held = await tickWith([INPUT_LABELS.HOLD, INPUT_LABELS.READY]);
      const released = await tickWith([INPUT_LABELS.READY]);

      expect(held.projections[0].issues[0].intent).toBe('hold');
      expect(released.projections[0].issues[0].intent).toBe('dispatch');
    });
  });

  describe('factory:ready', () => {
    it('authorizes a dispatch', async () => {
      const record = await tickWith([INPUT_LABELS.READY]);

      expect(record.actions.map((a) => a.type)).toContain('dispatch');
    });

    it('does nothing on its own without the label', async () => {
      expect((await tickWith([])).actions).toEqual([]);
    });
  });

  describe('factory:clear-quarantine', () => {
    it('is not consulted at all when nothing is quarantined', async () => {
      // A timeline call per issue would be ruinous against the rate-limit
      // budget, so it is asked only where the answer could matter.
      await tickWith([INPUT_LABELS.CLEAR_QUARANTINE]);

      expect(github.wasLabelAppliedByHuman).not.toHaveBeenCalled();
    });

    it('is not consulted when quarantined but the label is absent', async () => {
      await tickWith([], [quarantinedWorkOrder()]);

      expect(github.wasLabelAppliedByHuman).not.toHaveBeenCalled();
    });

    it('releases the quarantine when a HUMAN applied it', async () => {
      github.wasLabelAppliedByHuman.mockResolvedValue(true);

      const record = await tickWith(
        [INPUT_LABELS.CLEAR_QUARANTINE],
        [quarantinedWorkOrder()],
      );

      expect(github.wasLabelAppliedByHuman).toHaveBeenCalledWith(
        { owner: 'acme', name: 'app' },
        312,
        INPUT_LABELS.CLEAR_QUARANTINE,
      );
      expect(record.actions.map((a) => a.type)).toContain('release-quarantine');
    });

    it('REFUSES when a bot applied it', async () => {
      // VISION §8's never-trustable rule, and the reason the timeline is read
      // at all: the label list can only say the label is present.
      github.wasLabelAppliedByHuman.mockResolvedValue(false);

      const record = await tickWith(
        [INPUT_LABELS.CLEAR_QUARANTINE],
        [quarantinedWorkOrder()],
      );

      expect(record.projections[0].issues[0].intent).toBe('quarantined');
      expect(record.actions.map((a) => a.type)).not.toContain(
        'release-quarantine',
      );
    });

    it('reports the refusal in the record rather than failing silently', async () => {
      // #49 requires it be "rejected and reported" — a silent refusal is
      // indistinguishable from a bug. Asserted on the RECORD rather than on a
      // log line: the record is what the observation week is reviewed from,
      // and a log message nobody persists is not a report.
      github.wasLabelAppliedByHuman.mockResolvedValue(false);

      const record = await tickWith(
        [INPUT_LABELS.CLEAR_QUARANTINE],
        [quarantinedWorkOrder()],
      );

      const projected = record.projections[0].issues[0];
      expect(projected.intent).toBe('quarantined');
      expect(projected.reason).toContain('no human applied it');
      // The evidence carries the label that was ignored, so a reviewer can
      // see WHAT was refused, not just that something was.
      expect(record.actions[0]?.evidence.inputLabels).toContain(
        INPUT_LABELS.CLEAR_QUARANTINE,
      );
    });

    it('FAILS CLOSED when the timeline read errors', async () => {
      // The cost of being wrong is either a quarantine that waits one more
      // tick, or one released without a human. VISION §8 is unambiguous about
      // which is unacceptable.
      github.wasLabelAppliedByHuman.mockRejectedValue(
        new GitHubNotFoundError('Not Found', 404, 'GET', '/timeline'),
      );

      const record = await tickWith(
        [INPUT_LABELS.CLEAR_QUARANTINE],
        [quarantinedWorkOrder()],
      );

      expect(record.projections[0].issues[0].intent).toBe('quarantined');
      // And the tick itself still completes — one unverifiable issue must not
      // take down the sweep.
      expect(record.outcome).toBe('completed');
    });

    it('is dominated by factory:hold', async () => {
      github.wasLabelAppliedByHuman.mockResolvedValue(true);

      const record = await tickWith(
        [INPUT_LABELS.CLEAR_QUARANTINE, INPUT_LABELS.HOLD],
        [quarantinedWorkOrder()],
      );

      expect(record.projections[0].issues[0].intent).toBe('hold');
    });
  });
});

describe('conformance with .github/labels.yml', () => {
  /**
   * #49's last acceptance criterion: "The labels' behaviour matches
   * `.github/labels.yml`'s stated descriptions exactly."
   *
   * The taxonomy file is what a human reads before hand-applying a label, so a
   * label defined there and unimplemented here is a promise the factory does
   * not keep — and one implemented here but undocumented there is behaviour
   * nobody can discover.
   */
  const labelsYml = readFileSync(
    join(__dirname, '..', '..', '..', '..', '.github', 'labels.yml'),
    'utf8',
  );

  const declared = [
    ...labelsYml.matchAll(/^- name: "(factory[:/][^"]+)"$/gm),
  ].map((m) => m[1]);

  it('finds the factory labels in the taxonomy file', () => {
    // Guards the guard: a parser that matched nothing would make every
    // assertion below pass vacuously.
    expect(declared.length).toBeGreaterThanOrEqual(7);
  });

  it('implements every input label the taxonomy declares', () => {
    const declaredInputs = declared.filter((name) =>
      name.startsWith('factory:'),
    );

    expect(declaredInputs.sort()).toEqual([...ALL_INPUT_LABELS].sort());
  });

  it('implements every mirror label the taxonomy declares', () => {
    const declaredMirrors = declared.filter((name) =>
      name.startsWith('factory/'),
    );

    expect(declaredMirrors.sort()).toEqual([...ALL_MIRROR_LABELS].sort());
  });

  it('describes each input label as obeyed by the reconciler', () => {
    // The taxonomy's own promise. If a label stopped being obeyed, this is
    // the line that would have to change with it.
    for (const label of ALL_INPUT_LABELS) {
      const block = labelsYml.slice(labelsYml.indexOf(`- name: "${label}"`));
      expect(block.slice(0, 300)).toMatch(/Obeyed by the reconciler/);
    }
  });

  it('describes each mirror label as visibility-only', () => {
    for (const label of ALL_MIRROR_LABELS) {
      const block = labelsYml.slice(labelsYml.indexOf(`- name: "${label}"`));
      expect(block.slice(0, 300)).toMatch(/Visibility only/);
    }
  });
});

describe('routing labels in .github/labels.yml', () => {
  /**
   * #303. The `needs:` (#64) and `tier:` (#273) vocabularies were implemented
   * in code and declared nowhere, so `scripts/sync-labels.mjs` — whose entire
   * purpose is making sure the labels an operator needs exist on a repository
   * — could not create them. A label that does not exist cannot be put on an
   * issue, so the tier never reached a work order and `servesTier` never
   * refused anything: #273's complaint, arriving again by a different route.
   *
   * This is the assertion that stops it reopening. The vocabularies live in
   * `ignored-labels.ts`; adding an entry there without declaring it here now
   * fails, in both directions — a label declared in the file that the factory
   * does not understand is the mirror-image bug, an operator applying
   * something that will be ignored with the taxonomy's blessing.
   */
  const labelsYml = readFileSync(
    join(__dirname, '..', '..', '..', '..', '.github', 'labels.yml'),
    'utf8',
  );

  const declared = [
    ...labelsYml.matchAll(/^- name: "((?:needs|tier):[^"]+)"$/gm),
  ].map((m) => m[1]);

  const implemented = [
    ...Object.keys(NEEDS_BY_LABEL),
    ...Object.keys(MODEL_TIER_BY_LABEL),
  ];

  it('finds routing labels in the taxonomy file at all', () => {
    // Guards the guard, as above: a parser that matched nothing would make
    // every assertion below pass against an empty file, which is exactly the
    // state #303 found.
    expect(declared.length).toBeGreaterThanOrEqual(7);
  });

  it('declares every needs: label the factory understands', () => {
    const declaredNeeds = declared.filter((name) => name.startsWith('needs:'));

    expect(declaredNeeds.sort()).toEqual(Object.keys(NEEDS_BY_LABEL).sort());
  });

  it('declares every tier: label the factory understands', () => {
    const declaredTiers = declared.filter((name) => name.startsWith('tier:'));

    expect(declaredTiers.sort()).toEqual(
      Object.keys(MODEL_TIER_BY_LABEL).sort(),
    );
  });

  it('declares no routing label the factory would ignore', () => {
    // The other direction. A `tier:huge` in the file would be created by the
    // sync script, applied by an operator who read the taxonomy, and then
    // silently ignored — worse than never having offered it.
    expect(declared.sort()).toEqual([...implemented].sort());
  });

  it('describes each routing label as routing input', () => {
    // The taxonomy's own promise, in the register the two existing families
    // already use ("Obeyed by the reconciler", "Visibility only"). These are
    // input a human sets, not state Opifex writes, and the description is
    // where an operator finds that out.
    for (const label of implemented) {
      const block = labelsYml.slice(labelsYml.indexOf(`- name: "${label}"`));
      expect(block.slice(0, 300)).toMatch(/Routing input/);
    }
  });
});
