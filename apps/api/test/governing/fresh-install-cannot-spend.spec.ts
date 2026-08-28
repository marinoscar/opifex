import { Logger } from '@nestjs/common';

import { HardSpendCeilingService } from '../../src/budget/hard-spend-ceiling';
import { SpendLedgerService } from '../../src/budget/spend-ledger.service';
import type { SpendTally } from '../../src/budget/spend-ledger.service';
import { decideSpendAdmission } from '../../src/budget/spend-admission';
import { DispatchService } from '../../src/dispatch/dispatch.service';
import type { DispatchDecision } from '../../src/dispatch/dispatch-policy';
import { RunExecutorService } from '../../src/dispatch/run-executor.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ClaudeCodeLocalRunner } from '../../src/runners/claude-code-local/claude-code-local.runner';
import { RunPollerService } from '../../src/runners/run-poller.service';
import type { RunnerCapabilities } from '../../src/runners/runner.types';
import { OPERATOR_SETTINGS } from '../../src/settings/operator-settings/operator-settings.registry';
import { makeOperatorSettings } from '../../src/settings/operator-settings/operator-settings.test-double';
import type { GeneratedWorkOrder } from '../../src/work-orders/work-order-generator';
import { WorkOrderRecordsService } from '../../src/work-orders/work-order-records.service';

/**
 * A fresh install is READY, and cannot spend a cent (ADR-0019, #439).
 *
 * ## Why this file exists, and why it is a governing test
 *
 * #439 flipped four defaults on — the local runner, dispatch, the preview-tier
 * acknowledgement and GitHub writes — on the argument that the money risk is
 * better guarded by the hard spend ceiling than by four proxies for it. That
 * argument holds only while the ceiling keeps refusing. If
 * `dispatch.hardSpendCeilingUsd` ever acquires a default, or the refusal is
 * reordered behind some other check, the change stops being convenient and
 * becomes a control plane that starts spending somebody's subscription quota
 * the first time it is booted, with nobody having chosen a figure.
 *
 * That is exactly the class of quiet, one-line regression the `test/governing/`
 * suites exist for: it would typecheck, it would look like tidying, and every
 * other test in the repository would stay green — the dispatch specs all
 * configure a ceiling deliberately, precisely so they can test dispatch.
 *
 * ## What it claims, in four widening steps
 *
 * 1. The four flipped defaults really are on, so this file is testing the
 *    posture #439 shipped rather than a leftover one.
 * 2. The ceiling default is unset, and resolves to "no limit configured"
 *    rather than to "unlimited".
 * 3. The pure admission function refuses it, for an order that is otherwise
 *    perfectly dispatchable.
 * 4. The whole executor, wired with NOTHING overridden anywhere, refuses to
 *    create a run or submit one.
 *
 * Step 4 is the one that would survive a rewrite of the other three. Steps 1-3
 * say why it fails when it fails.
 */

const CAPABILITIES = {
  key: 'claude-code-local',
  version: '2.1.240',
  reportsCost: true,
} as unknown as RunnerCapabilities;

const DISPATCHABLE: DispatchDecision = {
  outcome: 'dispatch',
  runnerKey: 'claude-code-local',
  queueReason: null,
  reason: 'Dispatch to claude-code-local',
  candidates: [],
  avoidedQuotaPark: false,
  avoidedPark: null,
};

const EMPTY_TALLY: SpendTally = {
  reportedUsd: 0,
  estimatedUsd: 0,
  totalUsd: 0,
  runs: 0,
  runsWithoutCost: 0,
  unboundedRuns: 0,
  window: { from: new Date(0), to: new Date(0), days: 30 },
};

/** An order with everything the gate needs to say yes, if it were going to. */
const BUDGETED_ORDER = { ceilingUsd: 5, runnerReportsCost: true };

function workOrder(): GeneratedWorkOrder {
  return {
    identity: 'wo_acme-widgets_42_abc1234_a1',
    branch: 'factory/42-abc1234-a1',
    repositoryOwner: 'acme',
    repositoryName: 'widgets',
    issueNumber: 42,
    issueUrl: 'https://github.com/acme/widgets/issues/42',
    issueTitle: 'Add a health endpoint',
    baseCommit: 'a3f91c2000000000000000000000000000000000',
    attempt: 1,
    taskSpec: 'Add a health endpoint',
    acceptanceCriteria: ['It returns 200'],
    pathConstraints: [],
    decisionRefs: [],
    budgetCeilingUsd: 5,
    wallClockTimeoutMinutes: null,
    needs: [],
  } as unknown as GeneratedWorkOrder;
}

describe('a fresh install is ready, and cannot spend (ADR-0019, #439)', () => {
  describe('the shipped defaults', () => {
    it('has the four switches ON, so the factory is ready out of the box', () => {
      // Written as four literals rather than a loop over the registry: the
      // claim IS these four values, and a test that derived its expectation
      // from the table it is checking would agree with any value at all.
      expect(OPERATOR_SETTINGS['runners.claudeCodeLocal.enabled'].default).toBe(
        true,
      );
      expect(OPERATOR_SETTINGS['dispatch.enabled'].default).toBe(true);
      expect(OPERATOR_SETTINGS['dispatch.allowPreviewRunner'].default).toBe(
        true,
      );
      expect(OPERATOR_SETTINGS['github.writesEnabled'].default).toBe(true);
    });

    it('has NO hard spend ceiling, which is the half of #439 that did not move', () => {
      // Option D in #439 — flip the four and ship a default ceiling — was
      // rejected on the record: a default dollar figure is a guess about
      // somebody else's budget. An empty string here is the guess not being
      // made.
      expect(OPERATOR_SETTINGS['dispatch.hardSpendCeilingUsd'].default).toBe(
        '',
      );
    });

    it('resolves the unset ceiling to "none configured", not to "unlimited"', () => {
      const service = new HardSpendCeilingService(makeOperatorSettings());

      expect(service.value.limitUsd).toBeNull();
      // Not malformed: nobody typed anything wrong, and the two states are
      // reported differently on purpose.
      expect(service.value.malformed).toBeNull();
    });

    it('says so at boot, at a level an operator will see', () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      try {
        new HardSpendCeilingService(makeOperatorSettings());

        const lines = warn.mock.calls.map((call) => String(call[0]));
        expect(lines).toHaveLength(1);
        // The two facts an operator needs from a factory that is doing
        // nothing: that it refuses, and that this is the only reason.
        expect(lines[0]).toContain('refuse');
        expect(lines[0]).toContain('ceiling');
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('the admission gate', () => {
    it('refuses a perfectly dispatchable order because no ceiling exists', () => {
      const ceiling = new HardSpendCeilingService(makeOperatorSettings()).value;

      const verdict = decideSpendAdmission(
        ceiling,
        EMPTY_TALLY,
        BUDGETED_ORDER,
      );

      expect(verdict.admit).toBe(false);
      expect(verdict.admit === false && verdict.refusal).toBe(
        'no-hard-spend-ceiling-configured',
      );
    });

    it('admits the same order once a ceiling exists, so the refusal is the ceiling and nothing else', () => {
      // The control. Without it, every assertion above would also pass for a
      // gate that refused unconditionally — which would be a broken factory
      // rather than a safe one.
      const ceiling = new HardSpendCeilingService(
        makeOperatorSettings({
          overrides: { 'dispatch.hardSpendCeilingUsd': '50' },
        }),
      ).value;

      expect(
        decideSpendAdmission(ceiling, EMPTY_TALLY, BUDGETED_ORDER).admit,
      ).toBe(true);
    });
  });

  describe('the executor, with nothing configured anywhere', () => {
    /**
     * Every collaborator is a double EXCEPT the two that carry the claim: the
     * settings (the real registry defaults, through the test double that reads
     * no environment) and the ceiling service (the real one, fed by those
     * defaults). A stubbed `HardCeiling` object here would test the executor's
     * plumbing and say nothing about what ships.
     */
    function build() {
      const submit = jest.fn().mockResolvedValue({
        runnerKey: 'claude-code-local',
        externalId: 'ext-1',
        workOrderIdentity: 'wo_acme-widgets_42_abc1234_a1',
      });
      const runCreate = jest.fn().mockResolvedValue({});
      const write = jest.fn().mockResolvedValue({ alreadyRecorded: false });
      const track = jest.fn();
      const settings = makeOperatorSettings();
      const runner = {
        submit,
        capabilities: jest.fn().mockResolvedValue(CAPABILITIES),
      } as unknown as ClaudeCodeLocalRunner;
      Object.defineProperty(runner, 'key', { value: 'claude-code-local' });

      const executor = new RunExecutorService(
        {
          run: {
            create: runCreate,
            delete: jest.fn().mockResolvedValue({}),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
          workOrder: { update: jest.fn().mockResolvedValue({}) },
        } as unknown as PrismaService,
        settings,
        {
          decide: jest.fn().mockResolvedValue(DISPATCHABLE),
        } as unknown as DispatchService,
        { write } as unknown as WorkOrderRecordsService,
        { track } as unknown as RunPollerService,
        runner,
        new HardSpendCeilingService(settings),
        {
          tally: jest.fn().mockResolvedValue(EMPTY_TALLY),
        } as unknown as SpendLedgerService,
      );

      return { executor, submit, runCreate, write, track, settings };
    }

    it('starts no agent, writes no records and creates no run', async () => {
      const { executor, submit, runCreate, write, track } = build();

      const result = await executor.dispatchWorkOrder({
        workOrder: workOrder(),
        workOrderId: 'c0ffee00-0000-4000-8000-000000000001',
      });

      expect(result.outcome).toBe('queued');
      expect(result.outcome === 'queued' && result.queueReason).toBe(
        'no-hard-spend-ceiling-configured',
      );
      // The outcome is the diagnosis; the absence of these four is the
      // guarantee. An executor that returned "queued" having already created
      // the row and started the process would satisfy the line above and none
      // of the point.
      expect(submit).not.toHaveBeenCalled();
      expect(runCreate).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(track).not.toHaveBeenCalled();
    });

    it('dispatches as soon as an operator names a ceiling, and not before', async () => {
      // The other half of "ready, not running": the SAME instance, with the
      // same defaults, spends the moment a figure exists. Without this the
      // suite above would be satisfied by a factory that never works.
      const { executor, submit, settings } = build();

      settings.setOverride('dispatch.hardSpendCeilingUsd', '50');
      const result = await executor.dispatchWorkOrder({
        workOrder: workOrder(),
        workOrderId: 'c0ffee00-0000-4000-8000-000000000002',
      });

      expect(result.outcome).toBe('dispatched');
      expect(submit).toHaveBeenCalledTimes(1);
    });
  });
});
