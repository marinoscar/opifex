import type { RenewalNotifier } from '../../notifications/renewal-notifier.service';
import { NEAR_EXPIRY_WINDOW_MS } from '../defaults';
import type { TrustGrantService } from '../trust-grant.service';
import type { TrustGrantView } from '../trust-grant.types';
import { RenewalPromptTask } from './renewal-prompt.task';

/**
 * The expiry prompt fires ONCE per grant, not once per hour (#115).
 *
 * This is the assertion the whole task exists to satisfy. An hourly cron over
 * a 48-hour window without a dedupe produces up to 48 identical notifications
 * about one grant — the exact interruption VISION §8 exists to remove, and
 * worse than sending nothing, because it teaches an operator that trust
 * notifications are noise to be swiped away and the real escalation gets
 * swiped with them.
 */

const NOW = new Date('2026-08-24T12:00:00.000Z');
const LATER = new Date(NOW.getTime() + 3600_000);

function view(overrides: Partial<TrustGrantView> = {}): TrustGrantView {
  return {
    id: 'grant-1',
    actionClass: 're-dispatch',
    repositoryId: 'repo-1',
    expiresAt: new Date(NOW.getTime() + 36 * 3600_000).toISOString(),
    budgetCeilingUsd: 25,
    spentUsd: 10,
    actionsAuthorized: 6,
    actionsFailed: 1,
    maxFailureRate: 0.34,
    maxCostPerActionUsd: 5,
    minActionsBeforeAutoRevoke: 3,
    status: 'active',
    endedAt: null,
    endReason: null,
    endDetail: null,
    revokedById: null,
    note: null,
    grantedById: 'user-1',
    grantedFromProposalId: null,
    renewedFromId: null,
    createdAt: new Date(NOW.getTime() - 12 * 24 * 3600_000).toISOString(),
    updatedAt: NOW.toISOString(),
    remainingBudgetUsd: 15,
    budgetHeadroomFraction: 0.6,
    msUntilExpiry: 36 * 3600_000,
    failureRate: 1 / 6,
    nearExpiry: true,
    nearBudget: false,
    ...overrides,
  };
}

/**
 * A grants double that actually enforces "claimed once".
 *
 * Not a `mockResolvedValue(true)`: the property under test is that the SECOND
 * pass sends nothing, and a double that always granted the claim would pass
 * with `claimRenewalPrompt` deleted from the task entirely.
 */
function grantsDouble(rows: TrustGrantView[]) {
  const claimed = new Set<string>();

  return {
    expiringSoon: jest.fn(async () => rows),
    claimRenewalPrompt: jest.fn(async (id: string) => {
      if (claimed.has(id)) return false;
      claimed.add(id);
      return true;
    }),
  } as unknown as TrustGrantService & {
    expiringSoon: jest.Mock;
    claimRenewalPrompt: jest.Mock;
  };
}

function notifierDouble(accepted = true) {
  return {
    send: jest.fn(async () => accepted),
  } as unknown as RenewalNotifier & { send: jest.Mock };
}

describe('RenewalPromptTask (#115)', () => {
  it('prompts once per grant, not once per hour', async () => {
    const grants = grantsDouble([view()]);
    const notifier = notifierDouble();
    const task = new RenewalPromptTask(grants, notifier);

    await task.run(NOW);
    await task.run(LATER);

    expect(notifier.send).toHaveBeenCalledTimes(1);
    // And the second pass did not merely fail to send — it did not even reach
    // the transport, which is what makes the dedupe cheap as well as quiet.
    expect(grants.claimRenewalPrompt).toHaveBeenCalledTimes(2);
  });

  it('claims BEFORE sending, so a crash mid-send cannot produce a repeat storm', async () => {
    const grants = grantsDouble([view()]);
    const notifier = notifierDouble();
    (notifier.send as jest.Mock).mockRejectedValueOnce(
      new Error('transport exploded'),
    );
    const task = new RenewalPromptTask(grants, notifier);

    await task.run(NOW);
    await task.run(LATER);

    // One claim per pass; the grant was claimed on the first, so the second
    // sends nothing even though the first send blew up.
    expect(notifier.send).toHaveBeenCalledTimes(1);
  });

  it('uses the near-expiry window and one clock read', async () => {
    const grants = grantsDouble([]);
    const task = new RenewalPromptTask(grants, notifierDouble());

    await task.run(NOW);

    expect(grants.expiringSoon).toHaveBeenCalledWith(
      NEAR_EXPIRY_WINDOW_MS,
      NOW,
    );
  });

  it('resolves the registry title itself, because the payload builder may not', async () => {
    // Nothing under `src/notifications/` may import `src/supervisor/` — the
    // governing test for #94 asserts it. So the lookup happens HERE, one layer
    // up, and the builder receives a plain string.
    const grants = grantsDouble([view()]);
    const notifier = notifierDouble();
    const task = new RenewalPromptTask(grants, notifier);

    await task.run(NOW);

    expect(notifier.send.mock.calls[0]![0]).toMatchObject({
      id: 'grant-1',
      actionClass: 're-dispatch',
      actionClassTitle: 'Re-dispatch after transient failure',
    });
  });

  it('passes null rather than a raw id when the registry does not know the class', async () => {
    const grants = grantsDouble([view({ actionClass: 'nonexistent-class' })]);
    const notifier = notifierDouble();
    const task = new RenewalPromptTask(grants, notifier);

    await task.run(NOW);

    expect(notifier.send.mock.calls[0]![0].actionClassTitle).toBeNull();
  });

  it('hands the payload builder the grant record, not just its id', async () => {
    const grants = grantsDouble([view()]);
    const notifier = notifierDouble();
    const task = new RenewalPromptTask(grants, notifier);

    await task.run(NOW);

    expect(notifier.send.mock.calls[0]![0]).toMatchObject({
      spentUsd: 10,
      budgetCeilingUsd: 25,
      remainingBudgetUsd: 15,
      actionsAuthorized: 6,
      actionsFailed: 1,
      failureRate: 1 / 6,
    });
  });

  it('never throws into the scheduler', async () => {
    // An unhandled rejection in a cron handler takes the process down on some
    // Node configurations, and losing the API to a failed renewal REMINDER
    // would be an absurd trade. The next hour's tick retries, and the grants
    // it missed are still inside a 48-hour window.
    const grants = {
      expiringSoon: jest.fn(async () => {
        throw new Error('database is down');
      }),
      claimRenewalPrompt: jest.fn(),
    } as unknown as TrustGrantService;

    const task = new RenewalPromptTask(grants, notifierDouble());

    await expect(task.handleRenewalPrompts()).resolves.toBeUndefined();
  });

  it('reports how many prompts a transport actually accepted', async () => {
    const grants = grantsDouble([view(), view({ id: 'grant-2' })]);
    const task = new RenewalPromptTask(grants, notifierDouble(false));

    // Claimed but not accepted. The grants still expire on schedule, which is
    // the safe default — the prompt is an optimisation on top of a mechanism
    // that works without it.
    await expect(task.run(NOW)).resolves.toBe(0);
  });
});
