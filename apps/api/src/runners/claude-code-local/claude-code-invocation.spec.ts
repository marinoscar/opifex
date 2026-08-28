import { OPERATOR_SETTINGS } from '../../settings/operator-settings/operator-settings.registry';
import { MODEL_RATES } from '../../supervisor/invocation/model-pricing';
import { WORK_ORDER_MODEL_TIER } from '../../contracts/generated';
import type { ModelTier, WorkOrderSpec } from '../runner.types';
import {
  buildInvocationArgs,
  buildInvocationEnv,
  buildPrompt,
  MODEL_SETTING_KEY_BY_TIER,
  resolveModel,
  PERMISSION_MODES,
  type ModelSettingKey,
} from './claude-code-invocation';

const workOrder = (overrides: Partial<WorkOrderSpec> = {}): WorkOrderSpec => ({
  identity: 'wo_marinoscar-opifex_312_a3f91c2_a1',
  runId: '018f2c31-7a4e-7c3b-9f21-4d5e6a7b8c9d',
  repository: { owner: 'marinoscar', name: 'opifex' },
  baseCommit: 'a3f91c2000000000000000000000000000000000',
  branch: 'factory/312-a3f91c2-a1',
  taskSpec: 'Add a permit search prompt builder.',
  acceptanceCriteria: [
    'Searching by address returns permits',
    'Empty results render an empty state',
  ],
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
      const args = buildInvocationArgs({
        permissionMode: 'acceptEdits',
        sessionId: 'abc',
      });

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

    it('passes --model when the resolution pinned one', () => {
      const args = buildInvocationArgs({
        permissionMode: 'acceptEdits',
        sessionId: 'abc',
        model: 'claude-haiku-4-5',
      });

      expect(args[args.indexOf('--model') + 1]).toBe('claude-haiku-4-5');
    });

    it('omits --model ENTIRELY when no model was resolved', () => {
      // #420's second decision, and the one thing in this change that is most
      // easily got wrong by being helpful. The assertion is on the ABSENCE of
      // the flag rather than on it carrying some other value: passing today's
      // CLI default explicitly would freeze it against a future release, and
      // that mistake would pass any test that only compared two models.
      const args = buildInvocationArgs({
        permissionMode: 'acceptEdits',
        sessionId: 'abc',
      });

      expect(args).not.toContain('--model');
      expect(args.join(' ')).not.toContain('claude-');
    });

    it('treats an empty model as no model rather than as an empty flag', () => {
      // `--model ''` is an argument the CLI would reject, and empty is how an
      // operator says "let the CLI choose for this tier" in a settings field
      // that cannot hold null.
      const args = buildInvocationArgs({
        permissionMode: 'acceptEdits',
        sessionId: 'abc',
        model: '',
      });

      expect(args).not.toContain('--model');
      expect(args).not.toContain('');
    });

    it('offers only permission modes the CLI accepts', () => {
      // A typo in configuration should fail at startup, not as an unusable
      // exit code on the first real dispatch.
      expect([...PERMISSION_MODES].sort()).toEqual(
        [
          'acceptEdits',
          'auto',
          'bypassPermissions',
          'dontAsk',
          'manual',
          'plan',
        ].sort(),
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
      expect(buildPrompt(workOrder())).toContain(
        'a3f91c2000000000000000000000000000000000',
      );
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
      expect(buildPrompt(workOrder())).toContain(
        'which ones you could not verify',
      );
    });

    it('omits the paths section entirely when nothing constrains them', () => {
      // An empty "confine your changes to:" list reads as a constraint with
      // no content, which is worse than no section.
      expect(buildPrompt(workOrder())).not.toContain('## Paths');
    });

    it('lists path constraints when there are any', () => {
      const prompt = buildPrompt(
        workOrder({ pathConstraints: ['apps/api/**', 'docs/**'] }),
      );
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
      expect(buildPrompt(workOrder({ budgetCeilingUsd: 2.5 }))).toContain(
        '$2.50',
      );
      expect(buildPrompt(workOrder({ budgetCeilingUsd: 2.5 }))).not.toContain(
        'wall clock',
      );
      expect(buildPrompt(workOrder({ wallClockTimeoutMinutes: 15 }))).toContain(
        '15 minutes',
      );
      expect(
        buildPrompt(workOrder({ wallClockTimeoutMinutes: 15 })),
      ).not.toContain('$');
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

  // -------------------------------------------------------------------------

  describe('resolveModel', () => {
    /** A lookup that answers with the registry's declared defaults. */
    const declared = (key: ModelSettingKey): string =>
      OPERATOR_SETTINGS[key].default;

    it('pins the configured model for a tier that maps', () => {
      const resolution = resolveModel('small', declared);

      expect(resolution.kind).toBe('pinned');
      expect(resolution).toMatchObject({ model: 'claude-haiku-4-5' });
      expect(resolution.statement).toContain('claude-haiku-4-5');
      expect(resolution.statement).toContain('small');
    });

    it('resolves each tier to a DIFFERENT model', () => {
      // The bug #420 fixes was not that the tier was unread — it was that
      // every tier produced an identical invocation. A mapping that resolved
      // three tiers to one model would be the same bug wearing this change's
      // clothes.
      const models = WORK_ORDER_MODEL_TIER.map((tier) => {
        const resolution = resolveModel(tier, declared);
        return resolution.kind === 'pinned' ? resolution.model : null;
      });

      expect(models).not.toContain(null);
      expect(new Set(models).size).toBe(WORK_ORDER_MODEL_TIER.length);
    });

    it('resolves an absent tier to no model at all', () => {
      const resolution = resolveModel(undefined, declared);

      expect(resolution.kind).toBe('no-tier');
      expect(resolution).not.toHaveProperty('model');
      expect(resolution.statement).toContain('no tier');
    });

    it('runs an unmappable tier on the default rather than refusing it', () => {
      // #297's rule: a routing declaration the factory cannot act on is
      // ignored and REPORTED, never fatal. A tier outside the closed union is
      // reachable from a schema minor this build predates, and throwing here
      // would turn a forward-compatible contract change into a failed run.
      const resolution = resolveModel('gargantuan', declared);

      expect(resolution.kind).toBe('unmapped-tier');
      expect(resolution).not.toHaveProperty('model');
      expect(resolution).toMatchObject({ tier: 'gargantuan' });
      expect(resolution.statement).toContain('gargantuan');
    });

    it('is not fooled by a tier that names a property of Object.prototype', () => {
      // `MODEL_SETTING_KEY_BY_TIER['constructor']` is a FUNCTION, not
      // undefined, so a blind index would sail past a `=== undefined` check
      // and hand a function to the settings lookup. Found by mutation-testing
      // the guard: dropping it left every other assertion in this block green,
      // because 'gargantuan' is not on the prototype and this is.
      const resolution = resolveModel('constructor', declared);

      expect(resolution.kind).toBe('unmapped-tier');
      expect(resolution).not.toHaveProperty('model');
    });

    it('never asks the lookup about a tier it does not map', () => {
      // The lookup is `settings.get()`, which throws on a key the registry
      // does not declare. Reaching it with `runners.claudeCodeLocal.model.
      // gargantuan` would turn a bad label into an exception on the dispatch
      // path — the exact opposite of the line above.
      const asked: string[] = [];
      resolveModel('gargantuan', (key) => {
        asked.push(key);
        return 'claude-opus-5';
      });

      expect(asked).toEqual([]);
    });

    it('treats a tier the operator mapped to nothing as the default', () => {
      // Distinct from `unmapped-tier` on purpose: this one is a deliberate
      // operator choice, so it is not worth a warning, and the statement says
      // which of the two happened.
      const resolution = resolveModel('large', () => '   ');

      expect(resolution.kind).toBe('not-configured');
      expect(resolution).not.toHaveProperty('model');
      expect(resolution.statement).toContain('large');
    });
  });

  describe('the tier -> setting mapping', () => {
    it('covers every tier in the contract, and nothing else', () => {
      // Enumerated from the generated contract rather than from a list here,
      // so a fourth tier added by a schema minor shows up as a failure to
      // decide what it costs rather than as silence.
      expect(Object.keys(MODEL_SETTING_KEY_BY_TIER).sort()).toEqual(
        [...WORK_ORDER_MODEL_TIER].sort(),
      );
    });

    it('names a key the registry actually declares', () => {
      // `satisfies` catches this at compile time; the assertion is here for
      // the reader, and because a compile-time guarantee is invisible in a
      // test report.
      for (const key of Object.values(MODEL_SETTING_KEY_BY_TIER)) {
        expect(OPERATOR_SETTINGS[key]).toBeDefined();
        expect(OPERATOR_SETTINGS[key].group).toBe('runner');
      }
    });

    it('defaults to models the pricing table has a rate for', () => {
      // A wrong model id is a runtime failure on EVERY dispatch of that tier,
      // and nothing else in this repository would catch one: the CLI is faked
      // in every test that spawns it. `model-pricing.ts` is a hand-maintained,
      // dated list keyed on exact strings, so a default that is not in it is
      // either a typo or a model nobody has priced — both worth failing on.
      for (const tier of WORK_ORDER_MODEL_TIER) {
        const model =
          OPERATOR_SETTINGS[MODEL_SETTING_KEY_BY_TIER[tier]].default;
        expect(Object.keys(MODEL_RATES)).toContain(model);
      }
    });

    it('defaults to a strictly increasing cost ladder', () => {
      // The property that makes the vocabulary mean what it says. An operator
      // who applies `tier:small` to save money must actually save money, and
      // this is the only assertion in the repository that checks the three
      // defaults are in the order their names claim.
      const rates = (['small', 'standard', 'large'] as const).map(
        (tier: ModelTier) =>
          MODEL_RATES[
            OPERATOR_SETTINGS[MODEL_SETTING_KEY_BY_TIER[tier]].default
          ],
      );

      for (let index = 1; index < rates.length; index += 1) {
        expect(rates[index].inputPerMillionUsd).toBeGreaterThan(
          rates[index - 1].inputPerMillionUsd,
        );
        expect(rates[index].outputPerMillionUsd).toBeGreaterThan(
          rates[index - 1].outputPerMillionUsd,
        );
      }
    });
  });
});
