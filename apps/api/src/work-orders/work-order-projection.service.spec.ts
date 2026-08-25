import { INPUT_LABELS } from '../github/labels/factory-labels';
import type { NormalizedIssue } from '../github/read/github-read.types';
import { PrismaService } from '../prisma/prisma.service';
import {
  WorkOrderProjectionService,
  digestOf,
  type ExistingWorkOrder,
} from './work-order-projection.service';

/**
 * Prisma is a double; the projection is not.
 *
 * What is under test is what gets WRITTEN and what deliberately does not —
 * the projection's own rules already have their own suite, and re-asserting
 * them here would test the fixture rather than the persistence.
 */
describe('WorkOrderProjectionService', () => {
  const BASE = 'a3f91c2000000000000000000000000000000000';
  const REPOSITORY = {
    id: 'repo-uuid',
    owner: 'marinoscar',
    name: 'opifex',
    budgetCeilingUsd: 5,
  };

  const BODY = `## Problem statement

Searching for permits by address is not possible today.

## Proposed solution

Add a permit search prompt builder to the chat surface.

## Acceptance criteria

- [ ] Searching by a street address returns the matching permits
- [ ] An empty result set renders the documented empty state

## Affected component

\`apps/api/**\`

## Priority

P1
`;

  const label = (name: string) => ({
    name,
    color: 'ededed',
    description: null,
  });

  function issue(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
    return {
      number: 312,
      title: 'Add a permit search prompt builder',
      body: BODY,
      state: 'open',
      author: 'marinoscar',
      labels: [label('feature')],
      inputLabels: [INPUT_LABELS.READY],
      unknownInputLabels: [],
      ignoredLabels: [],
      ...overrides,
    } as NormalizedIssue;
  }

  let findUnique: jest.Mock;
  let create: jest.Mock;
  let update: jest.Mock;
  let service: WorkOrderProjectionService;

  beforeEach(() => {
    findUnique = jest.fn().mockResolvedValue(null);
    create = jest.fn().mockResolvedValue({});
    update = jest.fn().mockResolvedValue({});

    service = new WorkOrderProjectionService({
      workOrder: { findUnique, create, update },
    } as unknown as PrismaService);
  });

  const project = (
    issues: NormalizedIssue[] = [issue()],
    existingWorkOrders: ExistingWorkOrder[] = [],
  ) =>
    service.project({
      repository: REPOSITORY,
      issues,
      existingWorkOrders,
      baseCommit: BASE,
    });

  describe('writing rows', () => {
    it('creates a queued work order for an eligible issue', async () => {
      const result = await project();

      expect(result.created).toHaveLength(1);
      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0][0].data).toMatchObject({
        identity: 'wo_opifex_312_a3f91c2_a1',
        repositoryId: 'repo-uuid',
        status: 'queued',
        branch: 'factory/312-a3f91c2-a1',
      });
    });

    it('writes every field the row needs to rebuild the document', async () => {
      // #154 made the row round-trip. It only round-trips if the writer
      // actually populates needs, issueUrl and issueTitle — the three fields
      // whose absence made a stored work order undispatchable.
      await project([
        issue({
          labels: [label('feature'), label('needs:own-infrastructure')],
        }),
      ]);

      expect(create.mock.calls[0][0].data).toMatchObject({
        needs: ['own-infrastructure'],
        issueUrl: 'https://github.com/marinoscar/opifex/issues/312',
        issueTitle: 'Add a permit search prompt builder',
      });
    });

    it('writes the model tier the issue declared', async () => {
      // The end of the chain #273 was missing: without this the column stays
      // null, `rehydrateWorkOrder` rebuilds no tier, and `servesTier` takes
      // its "no tier stated" branch forever.
      await project([
        issue({ labels: [label('feature'), label('tier:large')] }),
      ]);

      expect(create.mock.calls[0][0].data.modelTier).toBe('large');
    });

    it('writes null when the issue declared no tier', async () => {
      // Null and absent mean the same thing here — the runner's own default.
      await project();
      expect(create.mock.calls[0][0].data.modelTier).toBeNull();
    });

    it('pins the base commit the caller resolved', async () => {
      await project();
      expect(create.mock.calls[0][0].data.baseCommit).toBe(BASE);
    });

    it('copies the repository budget onto the row', async () => {
      // Resolved at projection rather than read through, so changing a
      // repository's budget cannot retroactively change what an in-flight run
      // was authorised to spend.
      await project();
      expect(create.mock.calls[0][0].data.budgetCeilingUsd).toBe(5);
    });

    it('stamps queuedAt so the queue can be ordered oldest-first', async () => {
      await project();
      expect(create.mock.calls[0][0].data.queuedAt).toBeInstanceOf(Date);
    });
  });

  describe('an identity that already exists', () => {
    it('does not write a second row', async () => {
      findUnique.mockResolvedValue({ id: 'existing' });

      const result = await project();

      expect(create).not.toHaveBeenCalled();
      expect(result.created).toHaveLength(0);
      expect(result.alreadyPresent).toBe(1);
    });

    it('never updates the existing row', async () => {
      // An author can edit an issue body without the base commit moving, so
      // the next tick would project different prose under the same identity.
      // Updating would let the row diverge from the authorization record #63
      // already posted — the exact thing #63 exists to make impossible.
      findUnique.mockResolvedValue({ id: 'existing' });

      await project();

      expect(create).not.toHaveBeenCalled();
    });

    it('treats losing a concurrent create as an ordinary outcome', async () => {
      // Two ticks racing. The unique constraint is the real guard; the read is
      // only an optimisation, so losing the race is correct rather than an
      // error.
      create.mockRejectedValue(
        Object.assign(new Error('duplicate'), { code: 'P2002' }),
      );

      const result = await project();

      expect(result.created).toHaveLength(0);
      expect(result.alreadyPresent).toBe(1);
    });

    it('still surfaces a database error that is not a duplicate', async () => {
      create.mockRejectedValue(new Error('connection lost'));

      const result = await project();

      // Caught per issue rather than thrown, but not counted as present.
      expect(result.created).toHaveLength(0);
      expect(result.alreadyPresent).toBe(0);
    });
  });

  describe('issues that produce nothing', () => {
    it('counts a skip by its reason rather than writing', async () => {
      const result = await project([issue({ inputLabels: [] })]);

      expect(create).not.toHaveBeenCalled();
      expect(result.skipped['not-marked-ready']).toBe(1);
    });

    it('collects a rejection with its problems, for a comment', async () => {
      // VISION §10 makes spec quality the throughput ceiling, so the reason
      // has to reach the author rather than a log.
      const placeholder = BODY.replace(
        /## Acceptance criteria[\s\S]*?(?=## Affected)/,
        '## Acceptance criteria\n\n- [ ] TBD\n- [ ] It works nicely\n\n',
      );

      const result = await project([issue({ body: placeholder })]);

      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].issueNumber).toBe(312);
      expect(result.rejected[0].problems.length).toBeGreaterThan(0);
      expect(create).not.toHaveBeenCalled();
    });

    it('carries the body digest on a rejection', async () => {
      // So the caller can tell "I have already said this" from "they edited it
      // and it is still wrong" without re-reading the issue.
      const placeholder = BODY.replace(
        /## Acceptance criteria[\s\S]*?(?=## Affected)/,
        '## Acceptance criteria\n\n- [ ] TBD\n\n',
      );

      const result = await project([issue({ body: placeholder })]);

      expect(result.rejected[0].bodyDigest).toBe(digestOf(placeholder));
    });
  });

  describe('a held issue', () => {
    const heldIssue = () =>
      issue({ inputLabels: [INPUT_LABELS.READY, INPUT_LABELS.HOLD] });

    it('is written as a held work order rather than skipped', async () => {
      // WorkOrderStatus.held means "withheld by policy", which is a fact about
      // a work order that EXISTS. Skipping the issue leaves an operator unable
      // to tell paused work from work the factory could not read.
      const result = await project([heldIssue()]);

      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0][0].data.status).toBe('held');
      expect(result.heldOnCreate).toBe(1);
    });

    it('has no queuedAt, so lifting the hold does not jump the queue', async () => {
      // queuedAt orders the dispatch queue. A held work order stamped with a
      // queue time would outrank work that has actually been waiting.
      await project([heldIssue()]);

      expect(create.mock.calls[0][0].data.queuedAt).toBeNull();
    });

    it('carries the same document as an unheld one', async () => {
      await project([heldIssue()]);
      const heldData = create.mock.calls[0][0].data;

      create.mockClear();
      await project();
      const queuedData = create.mock.calls[0][0].data;

      expect(heldData.identity).toBe(queuedData.identity);
      expect(heldData.taskSpec).toBe(queuedData.taskSpec);
      expect(heldData.acceptanceCriteria).toEqual(
        queuedData.acceptanceCriteria,
      );
    });
  });

  describe('a hold applied or lifted after the work order exists', () => {
    const existing = (status: string): ExistingWorkOrder => ({
      id: 'wo-uuid',
      issueNumber: 312,
      status,
    });

    it('holds a queued work order when the label appears', async () => {
      // VISION §4: you can always fix the factory by editing GitHub. A hold
      // that only worked if applied before the creating tick would make that
      // false in the one case where somebody is urgently stopping something.
      const result = await project(
        [issue({ inputLabels: [INPUT_LABELS.READY, INPUT_LABELS.HOLD] })],
        [existing('queued')],
      );

      expect(update).toHaveBeenCalledTimes(1);
      expect(update.mock.calls[0][0]).toMatchObject({
        where: { id: 'wo-uuid' },
        data: { status: 'held', queuedAt: null },
      });
      expect(result.holdsApplied).toBe(1);
    });

    it('releases a held work order when the label goes away', async () => {
      // A hold that could be applied and never lifted is a trap.
      const result = await project([issue()], [existing('held')]);

      expect(update.mock.calls[0][0].data.status).toBe('queued');
      expect(update.mock.calls[0][0].data.queuedAt).toBeInstanceOf(Date);
      expect(result.holdsLifted).toBe(1);
    });

    it('does nothing when the row already agrees with the label', async () => {
      await project([issue()], [existing('queued')]);

      expect(update).not.toHaveBeenCalled();
    });

    it.each([
      'dispatched',
      'succeeded',
      'failed',
      'quarantined',
      'superseded',
      'cancelled',
    ])('never touches a %s work order', async (status) => {
      // A dispatched work order has a run against it and an authorization
      // record posted for it. Flipping that to held because a label appeared
      // would make the record describe something no longer true, which is
      // the one thing #63 exists to prevent. Stopping a run in flight is a
      // cancel (#66), not a status edit.
      await project(
        [issue({ inputLabels: [INPUT_LABELS.READY, INPUT_LABELS.HOLD] })],
        [existing(status)],
      );

      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('an issue that already has a work order', () => {
    const existing: ExistingWorkOrder = {
      id: 'wo-uuid',
      issueNumber: 312,
      status: 'queued',
    };

    it('is never projected again, even at a new base commit', async () => {
      // #155 left this open. Answering it: no. Re-projecting at the current
      // HEAD mints a new identity every time the default branch moves — on a
      // repository that merges twenty times a day, every ready issue would
      // accumulate twenty authorizations and, once dispatch is on, twenty
      // runs. That is not a queue filling up, it is a bill.
      const result = await service.project({
        repository: REPOSITORY,
        issues: [issue()],
        existingWorkOrders: [existing],
        baseCommit: 'ffffffffffffffffffffffffffffffffffffffff',
      });

      expect(create).not.toHaveBeenCalled();
      expect(findUnique).not.toHaveBeenCalled();
      expect(result.alreadyPresent).toBe(1);
    });

    it('does not even consult the generator for it', async () => {
      // A body that would be REJECTED must not produce a fresh complaint on
      // every tick once the work order already exists.
      const placeholder = BODY.replace(
        /## Acceptance criteria[\s\S]*?(?=## Affected)/,
        '## Acceptance criteria\n\n- [ ] TBD\n\n',
      );

      const result = await project([issue({ body: placeholder })], [existing]);

      expect(result.rejected).toHaveLength(0);
    });

    it('still projects a DIFFERENT issue in the same repository', async () => {
      const result = await project(
        [issue({ number: 312 }), issue({ number: 313 })],
        [existing],
      );

      expect(create).toHaveBeenCalledTimes(1);
      expect(result.created).toHaveLength(1);
      expect(result.created[0].issueNumber).toBe(313);
    });
  });

  describe('needsBaseCommit', () => {
    it('is false when every ready issue already has a work order', async () => {
      // The steady state, and the reason running this every 60 seconds is
      // affordable: resolving HEAD is a GitHub request against the budget
      // VISION §11 reserves for the operator.
      expect(
        WorkOrderProjectionService.needsBaseCommit(
          [issue()],
          [{ id: 'wo-uuid', issueNumber: 312, status: 'queued' }],
        ),
      ).toBe(false);
    });

    it('is true for a ready issue with no work order', () => {
      expect(WorkOrderProjectionService.needsBaseCommit([issue()], [])).toBe(
        true,
      );
    });

    it('is false when nothing is marked ready', () => {
      expect(
        WorkOrderProjectionService.needsBaseCommit(
          [issue({ inputLabels: [] })],
          [],
        ),
      ).toBe(false);
    });

    it('is false for a closed issue', () => {
      expect(
        WorkOrderProjectionService.needsBaseCommit(
          [issue({ state: 'closed' })],
          [],
        ),
      ).toBe(false);
    });

    it('is TRUE for a held issue with no work order', () => {
      // A held issue still produces a row — a held one — so the base commit is
      // still needed. Treating a hold as "nothing to do" here would disagree
      // with projectIssue and silently skip the work.
      expect(
        WorkOrderProjectionService.needsBaseCommit(
          [issue({ inputLabels: [INPUT_LABELS.READY, INPUT_LABELS.HOLD] })],
          [],
        ),
      ).toBe(true);
    });

    it('is false for an empty repository', () => {
      expect(WorkOrderProjectionService.needsBaseCommit([], [])).toBe(false);
    });
  });

  describe('one bad issue does not stop the others', () => {
    it('keeps projecting after a failure', async () => {
      // A repository with fifty issues and one that trips a parser must still
      // produce the other forty-nine. The alternative is a single malformed
      // body stopping the factory.
      create
        .mockRejectedValueOnce(new Error('database hiccup'))
        .mockResolvedValue({});

      const result = await project([
        issue({ number: 312 }),
        issue({ number: 313 }),
      ]);

      expect(create).toHaveBeenCalledTimes(2);
      expect(result.created).toHaveLength(1);
    });

    it('returns an empty result for a repository with no issues', async () => {
      const result = await project([]);

      expect(result.created).toHaveLength(0);
      expect(result.rejected).toHaveLength(0);
      expect(create).not.toHaveBeenCalled();
    });
  });
});
