import type { EvaluateResult, PromotionService } from './promotion.service';
import { PromotionTask } from './promotion.task';

function result(overrides: Partial<EvaluateResult> = {}): EvaluateResult {
  return {
    evaluatedAt: '2026-08-24T12:00:00.000Z',
    paused: false,
    changes: [],
    holds: [],
    ...overrides,
  };
}

function build(options: { enabled?: boolean; evaluate?: jest.Mock } = {}) {
  const evaluate = options.evaluate ?? jest.fn().mockResolvedValue(result());

  const service = {
    get enabled() {
      return options.enabled ?? true;
    },
    evaluate,
  } as unknown as PromotionService;

  return { task: new PromotionTask(service), evaluate };
}

describe('PromotionTask', () => {
  it('evaluates when the ladder is enabled', async () => {
    const { task, evaluate } = build();
    await task.handleEvaluation();
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('returns before querying anything when disabled', async () => {
    // `evaluateLadder` already refuses to change anything while paused, so
    // running it would be harmless — but it would still be four queries an
    // hour, forever, on every deployment that has never turned the ladder on.
    const { task, evaluate } = build({ enabled: false });
    await task.handleEvaluation();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('does not throw when evaluate rejects', async () => {
    // The governing property. This runs on the shared scheduler, and a task
    // that threw would take the reconciler's cleanup, the run-summary sweep
    // and the approval-gate timeout sweeper with it — for the sake of a rung
    // change nobody was waiting on this hour.
    const { task } = build({
      evaluate: jest.fn().mockRejectedValue(new Error('database is on fire')),
    });
    await expect(task.handleEvaluation()).resolves.toBeUndefined();
  });

  it('does not throw when evaluate throws synchronously', async () => {
    const { task } = build({
      evaluate: jest.fn(() => {
        throw new Error('exploded before returning a promise');
      }),
    });
    await expect(task.handleEvaluation()).resolves.toBeUndefined();
  });

  it('logs each rung change, naming whether anyone was told', async () => {
    // "NOBODY NOTIFIED" has to appear in the log, because a demotion nobody
    // heard about is exactly the case where the log is the only record that
    // reached a human — #58's distinction between "we tried to tell you" and
    // "we never noticed".
    const { task } = build({
      evaluate: jest.fn().mockResolvedValue(
        result({
          changes: [
            {
              actionClass: 're-dispatch',
              from: 'promoted',
              to: 'measure',
              reason: 'demoted_on_regression',
              detail: 'rate fell',
              evidence: {
                actionClass: 're-dispatch',
                approved: 2,
                rejected: 8,
                sample: 10,
                rate: 0.2,
                recentApproved: 2,
                recentRejected: 8,
                recentSample: 10,
                recentRate: 0.2,
                fromProposals: 10,
                fromApprovals: 0,
              },
              notified: false,
              grantsSuspended: 2,
            },
          ],
        }),
      ),
    });

    const logger = jest
      .spyOn(
        Object.getPrototypeOf(
          (task as unknown as { logger: { log: () => void } }).logger,
        ),
        'log',
      )
      .mockImplementation(() => undefined);

    await task.handleEvaluation();

    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining('"re-dispatch" promoted -> measure'),
    );
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining('NOBODY NOTIFIED'),
    );
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining('2 grant(s) suspended'),
    );

    logger.mockRestore();
  });
});
