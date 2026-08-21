import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MIRROR_LABELS } from '../../github/labels/factory-labels';
import { GitHubWriteService } from '../../github/write/github-write.service';
import { Reversibility, WriteAction } from '../../github/write/reversibility';
import type { ReconcileAction, ReconcileActionType } from '../diff/actions.types';
import { MirrorLabelExecutor } from './mirror-label.executor';

function action(
  type: ReconcileActionType,
  overrides: Partial<ReconcileAction> = {},
): ReconcileAction {
  return {
    type,
    repository: 'acme/app',
    issueNumber: 312,
    reason: 'because',
    label: type.endsWith('mirror-label') ? MIRROR_LABELS.DISPATCHED : undefined,
    evidence: {
      intent: 'dispatch',
      inputLabels: [],
      workOrderIdentity: null,
      runStatus: null,
      currentMirrorLabels: [],
      desiredMirrorLabels: [],
    },
    ...overrides,
  };
}

function writeResult(over: Record<string, unknown> = {}) {
  return {
    action: WriteAction.AddLabel,
    reversibility: Reversibility.Reversible,
    approval: 'gated',
    performed: true,
    noop: false,
    url: null,
    description: 'd',
    ...over,
  };
}

describe('MirrorLabelExecutor', () => {
  let writes: { addLabel: jest.Mock; removeLabel: jest.Mock };
  let executor: MirrorLabelExecutor;
  const ENABLED = new Set(['acme/app']);

  beforeEach(() => {
    writes = {
      addLabel: jest.fn().mockResolvedValue(writeResult()),
      removeLabel: jest.fn().mockResolvedValue(writeResult()),
    };
    executor = new MirrorLabelExecutor(writes as unknown as GitHubWriteService);
  });

  describe('what it will not touch', () => {
    it.each<ReconcileActionType>([
      'dispatch',
      'escalate',
      'quarantine',
      'release-quarantine',
      'hold',
    ])('ignores a %s action entirely', async (type) => {
      // Not a policy check that could be misconfigured: there is no branch
      // here that could dispatch anything, and GitHubWriteService has no
      // dispatch adapter to call even if one were written.
      const outcome = await executor.execute([action(type)], ENABLED);

      expect(writes.addLabel).not.toHaveBeenCalled();
      expect(writes.removeLabel).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({ executed: 0, suppressed: 0 });
    });

    it('handles a mixed list, acting only on the label actions', async () => {
      const outcome = await executor.execute(
        [action('dispatch'), action('add-mirror-label'), action('quarantine')],
        ENABLED,
      );

      expect(outcome.executed).toBe(1);
      expect(writes.addLabel).toHaveBeenCalledTimes(1);
    });
  });

  describe('the per-repository flag', () => {
    it('suppresses a repository that has not opted in', async () => {
      const outcome = await executor.execute([action('add-mirror-label')], new Set());

      expect(writes.addLabel).not.toHaveBeenCalled();
      expect(outcome.suppressed).toBe(1);
    });

    it('acts only on the repositories that have', async () => {
      const outcome = await executor.execute(
        [
          action('add-mirror-label', { repository: 'acme/app' }),
          action('add-mirror-label', { repository: 'acme/other' }),
        ],
        ENABLED,
      );

      expect(outcome).toMatchObject({ executed: 1, suppressed: 1 });
      expect(writes.addLabel).toHaveBeenCalledTimes(1);
    });
  });

  describe('the global kill switch', () => {
    it('counts a suppressed write separately from a repository opt-out', async () => {
      // So the log distinguishes "this repository is not enabled" from
      // "writes are off everywhere" — two different things to check when
      // wondering why nothing was written.
      writes.addLabel.mockResolvedValue(writeResult({ performed: false }));

      const outcome = await executor.execute([action('add-mirror-label')], ENABLED);

      expect(outcome).toMatchObject({ executed: 0, suppressed: 1 });
    });
  });

  describe('idempotency', () => {
    it('counts an already-correct label as a no-op, not a write', async () => {
      // #48: "Applying an already-present label costs no API call." The
      // adapter answers 404 "Label does not exist" as a no-op on removal, and
      // GitHub accepts a duplicate add — so the cost is one request either
      // way and the accounting has to tell them apart.
      writes.removeLabel.mockResolvedValue(writeResult({ noop: true }));

      const outcome = await executor.execute([action('remove-mirror-label')], ENABLED);

      expect(outcome).toMatchObject({ executed: 0, noops: 1 });
    });

    it('running the same list twice is safe', async () => {
      const actions = [action('add-mirror-label'), action('remove-mirror-label')];

      await executor.execute(actions, ENABLED);
      writes.addLabel.mockResolvedValue(writeResult({ noop: true }));
      writes.removeLabel.mockResolvedValue(writeResult({ noop: true }));
      const second = await executor.execute(actions, ENABLED);

      expect(second.failures).toEqual([]);
      expect(second.noops).toBe(2);
    });
  });

  describe('routing', () => {
    it('adds through addLabel and removes through removeLabel', async () => {
      await executor.execute(
        [
          action('add-mirror-label', { label: MIRROR_LABELS.BLOCKED }),
          action('remove-mirror-label', { label: MIRROR_LABELS.DISPATCHED }),
        ],
        ENABLED,
      );

      expect(writes.addLabel).toHaveBeenCalledWith(
        { owner: 'acme', name: 'app' },
        312,
        MIRROR_LABELS.BLOCKED,
      );
      expect(writes.removeLabel).toHaveBeenCalledWith(
        { owner: 'acme', name: 'app' },
        312,
        MIRROR_LABELS.DISPATCHED,
      );
    });
  });

  describe('failure handling', () => {
    it('records a failure and keeps going', async () => {
      // One broken issue must not abandon the rest of the list.
      writes.addLabel
        .mockRejectedValueOnce(new Error('GitHub is down'))
        .mockResolvedValue(writeResult());

      const outcome = await executor.execute(
        [action('add-mirror-label', { issueNumber: 1 }), action('add-mirror-label', { issueNumber: 2 })],
        ENABLED,
      );

      expect(outcome.failures).toHaveLength(1);
      expect(outcome.executed).toBe(1);
    });

    it('treats a label action with no label as a diff-engine bug, not a crash', async () => {
      const outcome = await executor.execute(
        [action('add-mirror-label', { label: undefined })],
        ENABLED,
      );

      expect(outcome.failures[0].reason).toMatch(/carried no label/);
      expect(writes.addLabel).not.toHaveBeenCalled();
    });
  });

  describe('the invariant #48 requires', () => {
    it('exposes no way to feed a written label back into the projection', () => {
      // VISION §3.3: mirror labels are written and never read as truth. This
      // class writes and returns COUNTS — it returns no labels and holds no
      // reference to the projection, so there is nothing to feed back. The
      // projection's inputs are gathered fresh next tick from GitHub, where
      // the read adapter strips these labels out again.
      const returned = Object.keys({
        executed: 0,
        noops: 0,
        suppressed: 0,
        failures: [],
      });

      expect(returned).not.toContain('labels');
      expect(MirrorLabelExecutor.prototype).not.toHaveProperty('project');
    });

    it('is not a dependency of the reconciler that computes the actions', () => {
      // The structural half, and the one that matters: `ReconcilerService`
      // must remain unable to act on its own conclusions. Asserted against
      // the SOURCE rather than the runtime class, because the failure mode is
      // somebody adding a constructor parameter — which a behavioural test
      // cannot see, and `Function.toString()` does not include.
      const source = readFileSync(join(__dirname, '..', 'reconciler.service.ts'), 'utf8');

      expect(source).not.toMatch(/MirrorLabelExecutor/);
      expect(source).not.toMatch(/GitHubWriteService/);
    });
  });
});
