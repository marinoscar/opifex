import { GitBranchService } from '../github/git/git-branch.service';
import { GitHubReadService } from '../github/read/github-read.service';
import { GitHubWriteService } from '../github/write/github-write.service';
import { EXECUTION_RECORD_PATH } from './work-order-document';
import { generateWorkOrder, type IssueProjection } from './work-order-generator';
import { AUTHORIZATION_MARKER, WorkOrderRecordsService } from './work-order-records.service';

const BASE = 'a3f91c2000000000000000000000000000000000';

function issue(overrides: Partial<IssueProjection> = {}): IssueProjection {
  return {
    repository: { owner: 'marinoscar', name: 'opifex' },
    issueNumber: 312,
    title: 'Add widget listing',
    taskSpec: 'Add a paginated GET /api/widgets endpoint.',
    acceptanceCriteria: ['GET /api/widgets returns 200 with a paginated list'],
    pathConstraints: [],
    decisionRefs: [],
    issueUrl: 'https://github.com/marinoscar/opifex/issues/312',
    ...overrides,
  };
}

function workOrder(attempt = 1) {
  const result = generateWorkOrder({ issue: issue(), baseCommit: BASE, attempt });
  if (!result.ok) throw new Error('unreachable');
  return result.workOrder;
}

const DISPATCH = {
  runnerKey: 'claude-code-local',
  runnerVersion: '2.1.223',
  runId: '018f2c31-7a4e-7c3b-9f21-4d5e6a7b8c9d',
};

describe('WorkOrderRecordsService', () => {
  let reads: { listIssueComments: jest.Mock };
  let writes: { postAuthorizationRecord: jest.Mock; guardedWrite: jest.Mock };
  let branches: { createFactoryBranch: jest.Mock };
  let service: WorkOrderRecordsService;

  beforeEach(() => {
    reads = { listIssueComments: jest.fn().mockResolvedValue([]) };
    writes = {
      postAuthorizationRecord: jest
        .fn()
        .mockResolvedValue({ action: 'comment.authorization-record', performed: true, noop: false }),
      guardedWrite: jest.fn(async (action, description, execute) => ({
        action,
        description,
        performed: true,
        ...(await execute()),
      })),
    };
    branches = {
      createFactoryBranch: jest
        .fn()
        .mockResolvedValue({ write: { noop: false, performed: true }, commitSha: 'c1', created: true }),
    };

    service = new WorkOrderRecordsService(
      reads as unknown as GitHubReadService,
      writes as unknown as GitHubWriteService,
      branches as unknown as GitBranchService,
    );
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  });

  describe('both records, from one serialization', () => {
    it('writes the authorization record and the execution record', async () => {
      const result = await service.write({ workOrder: workOrder(), ...DISPATCH });

      expect(writes.postAuthorizationRecord).toHaveBeenCalled();
      expect(branches.createFactoryBranch).toHaveBeenCalled();
      expect(result.executionCommitSha).toBe('c1');
    });

    it('gives both records the SAME bytes', async () => {
      // #63: "the two records are verifiably identical in content." Only
      // structural if one function produces the string and both writes use
      // it — two call sites serializing independently would break on key
      // order, silently, because both documents would still look right.
      const result = await service.write({ workOrder: workOrder(), ...DISPATCH });

      const [, , posted] = writes.postAuthorizationRecord.mock.calls[0];
      const [{ content }] = branches.createFactoryBranch.mock.calls[0];

      expect(content).toBe(result.document);
      expect(posted).toEqual(JSON.parse(result.document));
    });

    it('commits the record at the fixed path', async () => {
      await service.write({ workOrder: workOrder(), ...DISPATCH });

      const [{ path }] = branches.createFactoryBranch.mock.calls[0];
      expect(path).toBe(EXECUTION_RECORD_PATH);
    });

    it('creates the branch the work order names, from its pinned base', async () => {
      await service.write({ workOrder: workOrder(), ...DISPATCH });

      expect(branches.createFactoryBranch.mock.calls[0][0]).toMatchObject({
        branch: 'factory/312-a3f91c2-a1',
        baseCommit: BASE,
      });
    });

    it('carries the trailers into the commit message', async () => {
      await service.write({ workOrder: workOrder(), ...DISPATCH });

      const [{ commitMessage }] = branches.createFactoryBranch.mock.calls[0];
      expect(commitMessage).toContain('Runner: claude-code-local@2.1.223');
      expect(commitMessage).toContain(`Run-Id: ${DISPATCH.runId}`);
    });
  });

  describe('the authorization record is posted once', () => {
    it('does not post a second time', async () => {
      // VISION §5 warns that issue-comment volume is how agent-driven
      // traceability inverts into noise. A reconciler re-derives its
      // conclusions every tick, so this is the ordinary path, not the edge.
      reads.listIssueComments.mockResolvedValue([
        {
          id: 1,
          body: `${AUTHORIZATION_MARKER}\n\`\`\`json\n{"identity":"wo_opifex_312_a3f91c2_a1"}\n\`\`\``,
          url: 'https://github.com/marinoscar/opifex/issues/312#issuecomment-1',
          author: 'opifex',
          createdAt: '2026-08-22T00:00:00Z',
        },
      ]);

      const result = await service.write({ workOrder: workOrder(), ...DISPATCH });

      expect(writes.postAuthorizationRecord).not.toHaveBeenCalled();
      expect(result.authorization.noop).toBe(true);
    });

    it('reports the no-op rather than skipping silently', async () => {
      // The diff log is the deliverable of the observation week. A write that
      // did not happen because it was already true is a different fact from
      // one that was never attempted.
      reads.listIssueComments.mockResolvedValue([
        { id: 1, body: `${AUTHORIZATION_MARKER} wo_opifex_312_a3f91c2_a1`, url: 'u', author: null, createdAt: '' },
      ]);

      await service.write({ workOrder: workOrder(), ...DISPATCH });

      expect(writes.guardedWrite).toHaveBeenCalled();
    });

    it('DOES post for a different attempt at the same issue', async () => {
      // Scoped to the identity, not the issue: attempt 2 is a different work
      // order and deserves its own authorization.
      reads.listIssueComments.mockResolvedValue([
        { id: 1, body: `${AUTHORIZATION_MARKER} wo_opifex_312_a3f91c2_a1`, url: 'u', author: null, createdAt: '' },
      ]);

      await service.write({ workOrder: workOrder(2), ...DISPATCH });

      expect(writes.postAuthorizationRecord).toHaveBeenCalled();
    });

    it('ignores an unrelated comment carrying the marker', async () => {
      reads.listIssueComments.mockResolvedValue([
        { id: 1, body: `${AUTHORIZATION_MARKER} wo_opifex_999_bbbbbbb_a1`, url: 'u', author: null, createdAt: '' },
      ]);

      await service.write({ workOrder: workOrder(), ...DISPATCH });

      expect(writes.postAuthorizationRecord).toHaveBeenCalled();
    });

    it('ignores a comment that merely mentions the identity', async () => {
      // A human discussing the work order in prose is not an authorization
      // record. The marker is what makes it one.
      reads.listIssueComments.mockResolvedValue([
        { id: 1, body: 'I think wo_opifex_312_a3f91c2_a1 looks wrong', url: 'u', author: 'a', createdAt: '' },
      ]);

      await service.write({ workOrder: workOrder(), ...DISPATCH });

      expect(writes.postAuthorizationRecord).toHaveBeenCalled();
    });

    it('treats an edited-into-invalid record as still posted', async () => {
      // Substring rather than a parse: posting a second one would not fix a
      // comment somebody mangled.
      reads.listIssueComments.mockResolvedValue([
        { id: 1, body: `${AUTHORIZATION_MARKER}\n\`\`\`json\n{ broken wo_opifex_312_a3f91c2_a1`, url: 'u', author: null, createdAt: '' },
      ]);

      await service.write({ workOrder: workOrder(), ...DISPATCH });

      expect(writes.postAuthorizationRecord).not.toHaveBeenCalled();
    });
  });

  describe('re-dispatching the same work order', () => {
    it('reports that nothing needed writing', async () => {
      reads.listIssueComments.mockResolvedValue([
        { id: 1, body: `${AUTHORIZATION_MARKER} wo_opifex_312_a3f91c2_a1`, url: 'u', author: null, createdAt: '' },
      ]);
      branches.createFactoryBranch.mockResolvedValue({
        write: { noop: true, performed: true },
        commitSha: 'existing',
        created: false,
      });

      const result = await service.write({ workOrder: workOrder(), ...DISPATCH });

      expect(result.alreadyRecorded).toBe(true);
      expect(result.executionCommitSha).toBe('existing');
    });

    it('is not "already recorded" when only one half existed', async () => {
      // A half-written pair is the interesting case — it means a previous
      // dispatch failed between the two — and collapsing it into "already
      // done" would hide that.
      branches.createFactoryBranch.mockResolvedValue({
        write: { noop: true, performed: true },
        commitSha: 'existing',
        created: false,
      });

      expect((await service.write({ workOrder: workOrder(), ...DISPATCH })).alreadyRecorded).toBe(
        false,
      );
    });
  });
});
