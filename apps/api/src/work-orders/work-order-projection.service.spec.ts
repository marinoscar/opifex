import { INPUT_LABELS } from '../github/labels/factory-labels';
import type { NormalizedIssue } from '../github/read/github-read.types';
import { PrismaService } from '../prisma/prisma.service';
import { WorkOrderProjectionService } from './work-order-projection.service';

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

  const label = (name: string) => ({ name, color: 'ededed', description: null });

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
      ...overrides,
    } as NormalizedIssue;
  }

  let findUnique: jest.Mock;
  let create: jest.Mock;
  let service: WorkOrderProjectionService;

  beforeEach(() => {
    findUnique = jest.fn().mockResolvedValue(null);
    create = jest.fn().mockResolvedValue({});

    service = new WorkOrderProjectionService({
      workOrder: { findUnique, create },
    } as unknown as PrismaService);
  });

  const project = (issues: NormalizedIssue[] = [issue()]) =>
    service.project({ repository: REPOSITORY, issues, baseCommit: BASE });

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
        issue({ labels: [label('feature'), label('needs:own-infrastructure')] }),
      ]);

      expect(create.mock.calls[0][0].data).toMatchObject({
        needs: ['own-infrastructure'],
        issueUrl: 'https://github.com/marinoscar/opifex/issues/312',
        issueTitle: 'Add a permit search prompt builder',
      });
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
      create.mockRejectedValue(Object.assign(new Error('duplicate'), { code: 'P2002' }));

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

    it('never writes a row for a held issue', async () => {
      const result = await project([
        issue({ inputLabels: [INPUT_LABELS.READY, INPUT_LABELS.HOLD] }),
      ]);

      expect(create).not.toHaveBeenCalled();
      expect(result.skipped.held).toBe(1);
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

      const result = await project([issue({ number: 312 }), issue({ number: 313 })]);

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
