import { GitHubReadService } from '../github/read/github-read.service';
import { PrismaService } from '../prisma/prisma.service';
import { MergeStateService } from './merge-state.service';

/**
 * #215. Two of VISION §10's metrics were null because "merge state is not
 * tracked anywhere", and one of them — first-pass acceptance — is the metric
 * §10 says decides the roadmap.
 */
describe('MergeStateService', () => {
  let findMany: jest.Mock;
  let update: jest.Mock;
  let getPullRequest: jest.Mock;
  let service: MergeStateService;

  const RUN = {
    id: 'run-1',
    pullRequestNumber: 42,
    workOrder: { repository: { owner: 'acme', name: 'app' } },
  };

  const pull = (overrides: Record<string, unknown> = {}) => ({
    number: 42,
    state: 'closed',
    merged: true,
    mergedAt: new Date('2026-08-24T10:00:00Z'),
    ...overrides,
  });

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([RUN]);
    update = jest.fn().mockResolvedValue({});
    getPullRequest = jest.fn().mockResolvedValue(pull());

    service = new MergeStateService(
      { run: { findMany, update } } as unknown as PrismaService,
      { getPullRequest } as unknown as GitHubReadService,
    );
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  });

  describe('what it asks for', () => {
    it('asks only about runs with a pull request and no settled state', () => {
      // Null is "open, or never read" — both want asking again. A settled run
      // never does, which is what makes the sweep idempotent.
      return service.settleOpen().then(() => {
        const [{ where }] = findMany.mock.calls[0];
        expect(where.pullRequestNumber).toEqual({ not: null });
        expect(where.pullRequestState).toBeNull();
      });
    });
  });

  describe('the three outcomes', () => {
    it('records a merge, with when it merged', async () => {
      await service.settleOpen();

      const [{ data }] = update.mock.calls[0];
      expect(data.pullRequestState).toBe('merged');
      expect(data.pullRequestMergedAt).toEqual(
        new Date('2026-08-24T10:00:00Z'),
      );
    });

    it('records a close WITHOUT merging as its own outcome', async () => {
      // Not a first-pass acceptance and not a failure of one — it is work that
      // was withdrawn. Folding it into either would make metric 3 wrong in the
      // one direction a roadmap metric must not be wrong in.
      getPullRequest.mockResolvedValue(pull({ merged: false, mergedAt: null }));

      await service.settleOpen();

      const [{ data }] = update.mock.calls[0];
      expect(data.pullRequestState).toBe('closed');
      expect(data.pullRequestMergedAt).toBeNull();
    });

    it('leaves an open pull request unsettled, so the next sweep asks again', async () => {
      // Recording "open" would need a third enum value that only ever means
      // "ask me later", which the null already says.
      getPullRequest.mockResolvedValue(pull({ state: 'open', merged: false }));

      const result = await service.settleOpen();

      expect(update).not.toHaveBeenCalled();
      expect(result).toEqual({ settled: 0, stillOpen: 1 });
    });
  });

  describe('failure', () => {
    it('leaves a run unsettled when its read fails', async () => {
      getPullRequest.mockRejectedValue(new Error('GitHub is down'));

      const result = await service.settleOpen();

      expect(update).not.toHaveBeenCalled();
      expect(result.settled).toBe(0);
    });

    it('one failure does not stop the sweep', async () => {
      findMany.mockResolvedValue([RUN, { ...RUN, id: 'run-2' }]);
      getPullRequest
        .mockRejectedValueOnce(new Error('GitHub is down'))
        .mockResolvedValue(pull());

      const result = await service.settleOpen();

      expect(result.settled).toBe(1);
      expect(update).toHaveBeenCalledTimes(1);
    });
  });
});
