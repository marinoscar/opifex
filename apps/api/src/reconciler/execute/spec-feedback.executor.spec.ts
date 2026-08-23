import { GitHubWriteService } from '../../github/write/github-write.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { TickRejection } from '../reconciler.types';
import { SpecFeedbackExecutor } from './spec-feedback.executor';

/**
 * The property that matters here is "once, not once per tick".
 *
 * The reconciler recomputes from scratch every 60 seconds, so every one of
 * these tests is really asking: what happens on the SECOND pass? A suite that
 * only checked the first post would pass while the executor buried an issue
 * under 1,440 identical comments a day.
 */
describe('SpecFeedbackExecutor', () => {
  const REPOSITORY = { id: 'repo-uuid', owner: 'marinoscar', name: 'opifex' };

  function rejection(overrides: Partial<TickRejection> = {}): TickRejection {
    return {
      issueNumber: 312,
      problems: [],
      message: '`TBD` is not a testable acceptance criterion.',
      bodyDigest: 'digest-v1',
      repository: REPOSITORY,
      feedbackEnabled: true,
      ...overrides,
    };
  }

  let findUnique: jest.Mock;
  let upsert: jest.Mock;
  let postGeneralComment: jest.Mock;
  let executor: SpecFeedbackExecutor;

  beforeEach(() => {
    findUnique = jest.fn().mockResolvedValue(null);
    upsert = jest.fn().mockResolvedValue({});
    postGeneralComment = jest.fn().mockResolvedValue({
      performed: true,
      url: 'https://github.com/marinoscar/opifex/issues/312#issuecomment-1',
    });

    executor = new SpecFeedbackExecutor(
      { postGeneralComment } as unknown as GitHubWriteService,
      { issueSpecRejection: { findUnique, upsert } } as unknown as PrismaService,
    );
  });

  describe('the first time an issue is rejected', () => {
    it('posts a comment on the issue', async () => {
      const outcome = await executor.report([rejection()]);

      expect(postGeneralComment).toHaveBeenCalledTimes(1);
      expect(postGeneralComment.mock.calls[0][0]).toEqual({
        owner: 'marinoscar',
        name: 'opifex',
      });
      expect(postGeneralComment.mock.calls[0][1]).toBe(312);
      expect(outcome.posted).toBe(1);
    });

    it('puts the problems in the body', async () => {
      // The problems ARE the message. VISION §10: the factory cannot be better
      // than what it is told to build, so the author has to be able to act on
      // this without asking anybody.
      await executor.report([rejection()]);

      expect(postGeneralComment.mock.calls[0][2]).toContain(
        '`TBD` is not a testable acceptance criterion.',
      );
    });

    it('says nothing was dispatched and nothing changed', async () => {
      // An author reading this needs to know whether they must undo something.
      await executor.report([rejection()]);

      expect(postGeneralComment.mock.calls[0][2]).toMatch(/nothing has been dispatched/i);
    });

    it('tells them no label change is needed', async () => {
      // Otherwise the obvious guess is to remove and re-add factory:ready,
      // which does nothing — the reconciler recomputes from scratch anyway.
      await executor.report([rejection()]);

      expect(postGeneralComment.mock.calls[0][2]).toMatch(/no label change is needed/i);
    });

    it('carries no opifex marker, because it is not a record', async () => {
      // Markers are reserved for the records VISION mandates. One on an
      // ordinary comment would make it look machine-extractable.
      await executor.report([rejection()]);

      expect(postGeneralComment.mock.calls[0][2]).not.toContain('<!-- opifex:');
    });

    it('records that it was said, with the comment URL', async () => {
      await executor.report([rejection()]);

      expect(upsert).toHaveBeenCalledTimes(1);
      expect(upsert.mock.calls[0][0].create).toMatchObject({
        repositoryId: 'repo-uuid',
        issueNumber: 312,
        bodyDigest: 'digest-v1',
        commentUrl: 'https://github.com/marinoscar/opifex/issues/312#issuecomment-1',
      });
    });
  });

  describe('the same rejection on a later tick', () => {
    it('says nothing at all', async () => {
      // The whole point. 60-second ticks would otherwise bury the issue under
      // the feedback meant to help it.
      findUnique.mockResolvedValue({ bodyDigest: 'digest-v1' });

      const outcome = await executor.report([rejection()]);

      expect(postGeneralComment).not.toHaveBeenCalled();
      expect(upsert).not.toHaveBeenCalled();
      expect(outcome.alreadyTold).toBe(1);
      expect(outcome.posted).toBe(0);
    });

    it('speaks again once the author edits the body', async () => {
      // Keyed on the issue alone, an author who reads the feedback, edits and
      // gets it wrong again would be met with silence — the worst possible
      // answer to somebody doing exactly what was asked.
      findUnique.mockResolvedValue({ bodyDigest: 'digest-v1' });

      const outcome = await executor.report([rejection({ bodyDigest: 'digest-v2' })]);

      expect(postGeneralComment).toHaveBeenCalledTimes(1);
      expect(outcome.posted).toBe(1);
    });

    it('updates the stored digest rather than adding a row', async () => {
      findUnique.mockResolvedValue({ bodyDigest: 'digest-v1' });

      await executor.report([rejection({ bodyDigest: 'digest-v2' })]);

      expect(upsert.mock.calls[0][0].update).toMatchObject({ bodyDigest: 'digest-v2' });
      expect(upsert.mock.calls[0][0].where).toEqual({
        repositoryId_issueNumber: { repositoryId: 'repo-uuid', issueNumber: 312 },
      });
    });
  });

  describe('a repository that has not opted in', () => {
    it('posts nothing', async () => {
      const outcome = await executor.report([rejection({ feedbackEnabled: false })]);

      expect(postGeneralComment).not.toHaveBeenCalled();
      expect(outcome.suppressed).toBe(1);
    });

    it('records nothing, so enabling the flag later still delivers it', async () => {
      // This table records what was SAID, not what was found.
      await executor.report([rejection({ feedbackEnabled: false })]);

      expect(upsert).not.toHaveBeenCalled();
    });

    it('does not even look the issue up', async () => {
      await executor.report([rejection({ feedbackEnabled: false })]);

      expect(findUnique).not.toHaveBeenCalled();
    });
  });

  describe('a write the global kill switch suppressed', () => {
    it('records nothing, so turning writes on later delivers it', async () => {
      // A tick that never spoke must not leave evidence that it did.
      postGeneralComment.mockResolvedValue({ performed: false, url: null });

      const outcome = await executor.report([rejection()]);

      expect(upsert).not.toHaveBeenCalled();
      expect(outcome.posted).toBe(0);
    });
  });

  describe('failures', () => {
    it('keeps going after one issue fails', async () => {
      postGeneralComment
        .mockRejectedValueOnce(new Error('502 from GitHub'))
        .mockResolvedValue({ performed: true, url: null });

      const outcome = await executor.report([
        rejection({ issueNumber: 312 }),
        rejection({ issueNumber: 313 }),
      ]);

      expect(outcome.posted).toBe(1);
      expect(outcome.failures).toHaveLength(1);
      expect(outcome.failures[0].issueNumber).toBe(312);
    });

    it('leaves no row when the post failed, so a later tick retries', async () => {
      postGeneralComment.mockRejectedValue(new Error('502 from GitHub'));

      await executor.report([rejection()]);

      expect(upsert).not.toHaveBeenCalled();
    });

    it('names the repository and issue in the failure', async () => {
      // The caller has a list of rejections and no other way to tell which one.
      postGeneralComment.mockRejectedValue(new Error('502 from GitHub'));

      const outcome = await executor.report([rejection()]);

      expect(outcome.failures[0].repository).toBe('marinoscar/opifex');
      expect(outcome.failures[0].reason).toContain('502');
    });
  });

  it('does nothing for an empty list', async () => {
    const outcome = await executor.report([]);

    expect(postGeneralComment).not.toHaveBeenCalled();
    expect(outcome).toEqual({ posted: 0, alreadyTold: 0, suppressed: 0, failures: [] });
  });
});
