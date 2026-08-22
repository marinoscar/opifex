import type { WorkOrderSpec } from '../runner.types';
import {
  buildInvocationArgs,
  buildInvocationEnv,
  buildPrompt,
  PERMISSION_MODES,
} from './claude-code-invocation';

const workOrder = (overrides: Partial<WorkOrderSpec> = {}): WorkOrderSpec => ({
  identity: 'wo_marinoscar-opifex_312_a3f91c2_a1',
  runId: '018f2c31-7a4e-7c3b-9f21-4d5e6a7b8c9d',
  repository: { owner: 'marinoscar', name: 'opifex' },
  baseCommit: 'a3f91c2000000000000000000000000000000000',
  branch: 'factory/312-a3f91c2-a1',
  taskSpec: 'Add a permit search prompt builder.',
  acceptanceCriteria: ['Searching by address returns permits', 'Empty results render an empty state'],
  pathConstraints: [],
  budgetCeilingUsd: null,
  wallClockTimeoutMinutes: null,
  needs: [],
  ...overrides,
});

describe('claude-code invocation', () => {
  describe('buildInvocationArgs', () => {
    it('asks for the streaming format the manifest is graded against', () => {
      // --verbose is what makes the stream carry per-tool detail rather than
      // only a final result, and per-tool detail is what loop detection (#55)
      // and event-age watchdogs (#54) are built on. Dropping it would quietly
      // reduce the runner's observability to a single line at the end.
      const args = buildInvocationArgs({ permissionMode: 'acceptEdits', sessionId: 'abc' });

      expect(args).toContain('--print');
      expect(args).toContain('--verbose');
      expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    });

    it('hands the run id to the CLI as its session id', () => {
      // Both name one attempt, so making them the same value buys a
      // correlation that survives leaving the process.
      const order = workOrder();
      const args = buildInvocationArgs({
        permissionMode: 'acceptEdits',
        sessionId: order.runId,
      });

      expect(args[args.indexOf('--session-id') + 1]).toBe(order.runId);
    });

    it('offers only permission modes the CLI accepts', () => {
      // A typo in configuration should fail at startup, not as an unusable
      // exit code on the first real dispatch.
      expect([...PERMISSION_MODES].sort()).toEqual(
        ['acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'manual', 'plan'].sort(),
      );
    });
  });

  describe('buildPrompt', () => {
    it('states the branch the work must land on', () => {
      const prompt = buildPrompt(workOrder());
      expect(prompt).toContain('factory/312-a3f91c2-a1');
      expect(prompt).toContain('Do not create other branches');
    });

    it('names the pinned base commit rather than a branch tip', () => {
      // VISION §3.4: recovery is abandon-and-re-run FROM THE PINNED BASE. The
      // agent being told which commit it is on is part of that being true.
      expect(buildPrompt(workOrder())).toContain('a3f91c2000000000000000000000000000000000');
    });

    it('numbers the acceptance criteria so they can be referred to', () => {
      const prompt = buildPrompt(workOrder());
      expect(prompt).toContain('1. Searching by address returns permits');
      expect(prompt).toContain('2. Empty results render an empty state');
      expect(prompt).toContain('definition of done');
    });

    it('asks for unverified criteria to be named', () => {
      // A run that claims more than it ran is worse than one that admits a
      // gap, because the gap is then invisible to the reviewer too.
      expect(buildPrompt(workOrder())).toContain('which ones you could not verify');
    });

    it('omits the paths section entirely when nothing constrains them', () => {
      // An empty "confine your changes to:" list reads as a constraint with
      // no content, which is worse than no section.
      expect(buildPrompt(workOrder())).not.toContain('## Paths');
    });

    it('lists path constraints when there are any', () => {
      const prompt = buildPrompt(workOrder({ pathConstraints: ['apps/api/**', 'docs/**'] }));
      expect(prompt).toContain('## Paths');
      expect(prompt).toContain('`apps/api/**`');
      expect(prompt).toContain('`docs/**`');
    });

    it('omits the limits section when nothing is capped', () => {
      expect(buildPrompt(workOrder())).not.toContain('## Limits');
    });

    it('states limits as guidance, since policy is what enforces them', () => {
      // VISION §3.6 puts enforcement in deterministic policy (#65), never in
      // the agent's judgement. Telling it anyway means a well-behaved run
      // stops sooner and more gracefully than one killed at the ceiling.
      const prompt = buildPrompt(
        workOrder({ budgetCeilingUsd: 5, wallClockTimeoutMinutes: 30 }),
      );

      expect(prompt).toContain('$5.00');
      expect(prompt).toContain('30 minutes');
      expect(prompt).toContain('will be stopped');
    });

    it('includes a budget without a timeout, and the other way round', () => {
      expect(buildPrompt(workOrder({ budgetCeilingUsd: 2.5 }))).toContain('$2.50');
      expect(buildPrompt(workOrder({ budgetCeilingUsd: 2.5 }))).not.toContain('wall clock');
      expect(buildPrompt(workOrder({ wallClockTimeoutMinutes: 15 }))).toContain('15 minutes');
      expect(buildPrompt(workOrder({ wallClockTimeoutMinutes: 15 }))).not.toContain('$');
    });

    it('passes the task spec through rather than rewriting it', () => {
      // VISION §10 makes spec quality the throughput ceiling. Prompt
      // engineering on top of the human's words would mostly obscure which
      // of the two is responsible when a run builds the wrong thing.
      const spec = 'Do exactly this, and nothing else, in this specific way.';
      expect(buildPrompt(workOrder({ taskSpec: spec }))).toContain(spec);
    });
  });

  describe('buildInvocationEnv', () => {
    it('carries correlation ids for anything the run reports itself', () => {
      const order = workOrder();
      const env = buildInvocationEnv(order);

      expect(env.OPIFEX_WORK_ORDER).toBe(order.identity);
      expect(env.OPIFEX_RUN_ID).toBe(order.runId);
      expect(env.OPIFEX_BRANCH).toBe(order.branch);
    });

    it('tells the child it has no terminal', () => {
      // A CLI that decides it has a terminal is a CLI that can decide to ask
      // a question, and a question with nobody to answer it is a silent run.
      const env = buildInvocationEnv(workOrder());
      expect(env.CI).toBe('true');
      expect(env.TERM).toBe('dumb');
    });

    it('never carries a credential', () => {
      // The child inherits process.env, which is where anything secret
      // belongs. Naming one here would put it in a place this file's callers
      // could log.
      const env = buildInvocationEnv(workOrder());
      for (const key of Object.keys(env)) {
        expect(key).not.toMatch(/TOKEN|SECRET|KEY|PASSWORD/i);
      }
    });
  });
});
