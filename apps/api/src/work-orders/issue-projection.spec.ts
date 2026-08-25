import { INPUT_LABELS } from '../github/labels/factory-labels';
import type { NormalizedIssue } from '../github/read/github-read.types';
import {
  NEEDS_LABEL_PREFIX,
  TIER_LABEL_PREFIX,
  projectIssue,
  type ProjectIssueInput,
} from './issue-projection';

/**
 * A pure function, tested against issue bodies that look like real ones.
 *
 * The bodies here follow `.github/ISSUE_TEMPLATE/feature_request.yml`, because
 * that is what #108's gate accepts and what an author actually writes. A
 * fixture with invented headings would test a parser against a format nothing
 * produces.
 */
describe('projectIssue', () => {
  const BASE = 'a3f91c2000000000000000000000000000000000';
  const REPO = { owner: 'marinoscar', name: 'opifex' };

  const BODY = `## Problem statement

Searching for permits by address is not possible today.

## Proposed solution

Add a permit search prompt builder to the chat surface, backed by the
existing permit index.

## Acceptance criteria

- [ ] Searching by a street address returns the matching permits
- [ ] An empty result set renders the documented empty state
- [ ] The query is covered by an integration test

## Affected component

\`apps/api/**\` and \`apps/web/src/chat/**\`

## Priority

P1
`;

  /** A label in the shape the read adapter actually produces. */
  const label = (name: string) => ({
    name,
    color: 'ededed',
    description: null,
  });

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
      ignoredLabels: [],
      ...overrides,
    } as NormalizedIssue;
  }

  const project = (overrides: Partial<ProjectIssueInput> = {}) =>
    projectIssue({
      issue: issue(),
      repository: REPO,
      baseCommit: BASE,
      ...overrides,
    });

  describe('an eligible issue', () => {
    it('becomes a work order', () => {
      const result = project();

      expect(result.eligible).toBe(true);
      if (!result.eligible) throw new Error('expected eligible');
      expect(result.workOrder.identity).toBe('wo_opifex_312_a3f91c2_a1');
    });

    it('takes the task spec from the proposed solution, not the problem statement', () => {
      // The problem statement says why; the proposed solution says what to
      // build. Handing a runner the former would ask it to decide the latter,
      // which is the decision the human already made.
      const result = project();
      if (!result.eligible) throw new Error('expected eligible');

      expect(result.workOrder.taskSpec).toContain(
        'permit search prompt builder',
      );
      expect(result.workOrder.taskSpec).not.toContain('is not possible today');
    });

    it('reads every checklist item as a criterion', () => {
      const result = project();
      if (!result.eligible) throw new Error('expected eligible');

      expect(result.workOrder.acceptanceCriteria).toEqual([
        'Searching by a street address returns the matching permits',
        'An empty result set renders the documented empty state',
        'The query is covered by an integration test',
      ]);
    });

    it('ignores whether a box is ticked', () => {
      // A ticked box means an author believed something was done. That is not
      // a fact about what the work order is asking for.
      const ticked = BODY.replace(/- \[ \]/g, '- [x]');
      const result = project({ issue: issue({ body: ticked }) });
      if (!result.eligible) throw new Error('expected eligible');

      expect(result.workOrder.acceptanceCriteria).toHaveLength(3);
    });

    it('pins the base commit it was given rather than resolving one', () => {
      // #62: the base commit is pinned at generation, never resolved later. A
      // work order authorised on Monday and run on Tuesday must start from the
      // tree the authoriser looked at.
      const result = project();
      if (!result.eligible) throw new Error('expected eligible');

      expect(result.workOrder.baseCommit).toBe(BASE);
    });

    it('carries the issue URL the schema requires', () => {
      const result = project();
      if (!result.eligible) throw new Error('expected eligible');

      expect(result.workOrder.issueUrl).toBe(
        'https://github.com/marinoscar/opifex/issues/312',
      );
    });

    it('copies the repository ceilings in rather than referencing them', () => {
      // Changing a repository's budget must not retroactively change what an
      // in-flight run was authorised to spend.
      const result = project({
        budgetCeilingUsd: 12.5,
        wallClockTimeoutMinutes: 45,
      });
      if (!result.eligible) throw new Error('expected eligible');

      expect(result.workOrder.budgetCeilingUsd).toBe(12.5);
      expect(result.workOrder.wallClockTimeoutMinutes).toBe(45);
    });
  });

  describe('path constraints', () => {
    it('takes backticked globs from the affected component section', () => {
      const result = project();
      if (!result.eligible) throw new Error('expected eligible');

      expect(result.workOrder.pathConstraints).toEqual([
        'apps/api/**',
        'apps/web/src/chat/**',
      ]);
    });

    it('ignores a component NAME, which is a label and not a path', () => {
      // Turning `api` into a glob would confine a run to a directory nobody
      // chose — worse than not constraining it at all.
      const prose = BODY.replace(
        '`apps/api/**` and `apps/web/src/chat/**`',
        '`api`, `web`',
      );
      const result = project({ issue: issue({ body: prose }) });
      if (!result.eligible) throw new Error('expected eligible');

      expect(result.workOrder.pathConstraints).toEqual([]);
    });

    it('is empty rather than rejecting when the section is prose', () => {
      // Not the field #62 gates on. Failing a work order over a prose answer
      // would reject issues that are perfectly clear to a human.
      const prose = BODY.replace(
        '`apps/api/**` and `apps/web/src/chat/**`',
        'The API and the chat surface.',
      );
      const result = project({ issue: issue({ body: prose }) });

      expect(result.eligible).toBe(true);
    });
  });

  describe('provenance', () => {
    it('collects ADR references from anywhere in the body', () => {
      // A false negative loses the link between a decision and the work that
      // rests on it, so this scans the whole body rather than one section.
      const withAdr = BODY.replace(
        'P1',
        'P1\n\nThis follows ADR-0042 and ADR-0006.',
      );
      const result = project({ issue: issue({ body: withAdr }) });
      if (!result.eligible) throw new Error('expected eligible');

      expect(result.workOrder.decisionRefs).toEqual(['ADR-0042', 'ADR-0006']);
    });

    it('does not repeat an ADR mentioned twice', () => {
      const twice = BODY.replace('P1', 'P1\n\nADR-0042 applies. See ADR-0042.');
      const result = project({ issue: issue({ body: twice }) });
      if (!result.eligible) throw new Error('expected eligible');

      expect(result.workOrder.decisionRefs).toEqual(['ADR-0042']);
    });
  });

  describe('needs come from labels, never from prose', () => {
    it('reads a needs label', () => {
      // VISION §3.1 and §7 keep the hot path deterministic. Inferring
      // own-infrastructure from a sentence would put a model in the one place
      // the design says never to.
      const result = project({
        issue: issue({
          labels: [
            label('feature'),
            label(`${NEEDS_LABEL_PREFIX}own-infrastructure`),
          ],
        }),
      });
      if (!result.eligible) throw new Error('expected eligible');

      expect(result.workOrder.needs).toEqual(['own-infrastructure']);
    });

    it('declares no needs when no label says so', () => {
      const result = project();
      if (!result.eligible) throw new Error('expected eligible');

      expect(result.workOrder.needs).toEqual([]);
    });

    it('ignores a mistyped needs label rather than refusing the issue', () => {
      // Refusing to create a work order over a spelling mistake would be a
      // disproportionate response. This comment used to justify the silence by
      // claiming `unknownInputLabels` surfaced the typo; it never did — that
      // field matches the `factory:` prefix only, which is how a misspelled
      // `needs:` label stayed invisible long enough to become #297. The typo
      // is now surfaced by `ignoredLabels` and the `factory/label-ignored`
      // mirror label, and the work order is still created either way.
      const result = project({
        issue: issue({
          labels: [label('needs:ful-streaming')],
        }),
      });

      expect(result.eligible).toBe(true);
    });

    it('never infers a need from the body text', () => {
      const mentions = BODY.replace(
        'P1',
        'P1\n\nThis must run on own-infrastructure with full-streaming.',
      );
      const result = project({ issue: issue({ body: mentions }) });
      if (!result.eligible) throw new Error('expected eligible');

      expect(result.workOrder.needs).toEqual([]);
    });
  });

  describe('the model tier comes from a label too', () => {
    it.each(['small', 'standard', 'large'])('reads tier:%s', (tier) => {
      const result = project({
        issue: issue({
          labels: [label('feature'), label(`${TIER_LABEL_PREFIX}${tier}`)],
        }),
      });
      if (!result.eligible) throw new Error('expected eligible');

      expect(result.workOrder.modelTier).toBe(tier);
    });

    it('leaves the tier absent when no label says one', () => {
      // Absent means the runner's own default, and it is the ordinary case.
      // An explicit undefined would be a decision nobody made.
      const result = project();
      if (!result.eligible) throw new Error('expected eligible');

      expect('modelTier' in result.workOrder).toBe(false);
    });

    it('treats two conflicting tier labels as no tier at all', () => {
      // The written-down rule (#273). An ambiguous declaration is not a
      // declaration: picking the largest spends money nobody asked for,
      // picking the smallest can park the work order behind a constraint
      // nobody chose, and rejecting the issue would be deduped on the body
      // digest, which a label conflict does not change.
      const result = project({
        issue: issue({
          labels: [label('tier:small'), label('tier:large')],
        }),
      });
      if (!result.eligible) throw new Error('expected eligible');

      expect(result.workOrder.modelTier).toBeUndefined();
    });

    it('still produces a work order when the tiers conflict', () => {
      // The conflict must never stop the work. Falling back to the default is
      // exactly what every issue gets today.
      const result = project({
        issue: issue({
          labels: [label('tier:small'), label('tier:standard')],
        }),
      });

      expect(result.eligible).toBe(true);
    });

    it('ignores a mistyped tier label rather than refusing the issue', () => {
      const result = project({
        issue: issue({ labels: [label('tier:huge')] }),
      });
      if (!result.eligible) throw new Error('expected eligible');

      expect(result.workOrder.modelTier).toBeUndefined();
    });

    it('never infers a tier from the body text', () => {
      // Same rule as needs: routing input is set deliberately or not at all.
      const mentions = BODY.replace(
        'P1',
        'P1\n\nThis is a large piece of work and needs a large model.',
      );
      const result = project({ issue: issue({ body: mentions }) });
      if (!result.eligible) throw new Error('expected eligible');

      expect(result.workOrder.modelTier).toBeUndefined();
    });
  });

  describe('issues it skips silently', () => {
    it.each([
      ['a closed issue', { state: 'closed' as const }, 'not-open'],
      ['an issue with no ready label', { inputLabels: [] }, 'not-marked-ready'],
      ['an issue with an empty body', { body: '' }, 'no-body'],
      ['an issue with a null body', { body: null }, 'no-body'],
    ])('skips %s', (_label, overrides, reason) => {
      const result = projectIssue({
        issue: issue(overrides as Partial<NormalizedIssue>),
        repository: REPO,
        baseCommit: BASE,
      });

      expect(result).toEqual({ eligible: false, reason });
    });

    it('requires factory:ready rather than treating every open issue as work', () => {
      // Opt-IN, deliberately. VISION §3.5 gates on reversibility and a run
      // spends money; treating a backlog as work turns it into a bill.
      const result = project({ issue: issue({ inputLabels: [] }) });

      expect(result).toMatchObject({
        eligible: false,
        reason: 'not-marked-ready',
      });
    });

    it('skips an issue with no proposed solution', () => {
      const noSolution = BODY.replace(
        /## Proposed solution[\s\S]*?(?=## Acceptance)/,
        '',
      );
      const result = project({ issue: issue({ body: noSolution }) });

      expect(result).toMatchObject({
        eligible: false,
        reason: 'missing-task-spec',
      });
    });

    it('skips an issue whose criteria section has no list', () => {
      const prose = BODY.replace(
        /## Acceptance criteria[\s\S]*?(?=## Affected)/,
        '## Acceptance criteria\n\nIt should work well.\n\n',
      );
      const result = project({ issue: issue({ body: prose }) });

      expect(result).toMatchObject({
        eligible: false,
        reason: 'missing-acceptance-criteria',
      });
    });
  });

  describe('a hold is recorded, not a refusal', () => {
    const held = () =>
      project({
        issue: issue({ inputLabels: [INPUT_LABELS.READY, INPUT_LABELS.HOLD] }),
      });

    it('still projects a work order', () => {
      // `WorkOrderStatus.held` means "withheld by policy", which is a fact
      // about a work order that EXISTS. Skipping the issue outright — which
      // is what this function did first — leaves an operator unable to tell a
      // paused issue from one the factory could not read.
      expect(held().eligible).toBe(true);
    });

    it('marks it held so the writer can withhold it', () => {
      const result = held();
      if (!result.eligible) throw new Error('expected eligible');

      expect(result.held).toBe(true);
    });

    it('projects the same document held or not', () => {
      // The hold is a status, not a change to what was asked for. If lifting
      // it produced a different work order, the pause would silently rewrite
      // the work.
      const a = held();
      const b = project();
      if (!a.eligible || !b.eligible) throw new Error('expected eligible');

      expect(a.workOrder).toEqual(b.workOrder);
    });

    it('is not held when only ready is present', () => {
      const result = project();
      if (!result.eligible) throw new Error('expected eligible');

      expect(result.held).toBe(false);
    });

    it('needs ready as well — a hold alone is not a candidate', () => {
      // A hold does not make an unmarked issue into work.
      const result = project({
        issue: issue({ inputLabels: [INPUT_LABELS.HOLD] }),
      });

      expect(result).toMatchObject({
        eligible: false,
        reason: 'not-marked-ready',
      });
    });
  });

  describe('issues it rejects with reasons the author can act on', () => {
    it('carries the generator problems back rather than throwing', () => {
      // VISION §10 makes spec quality the throughput ceiling, so this is the
      // normal case to handle well. The problems are destined for a comment
      // the author reads, and an exception message is a worse carrier.
      const placeholder = BODY.replace(
        /## Acceptance criteria[\s\S]*?(?=## Affected)/,
        '## Acceptance criteria\n\n- [ ] TBD\n- [ ] It works nicely\n\n',
      );
      const result = project({ issue: issue({ body: placeholder }) });

      expect(result).toMatchObject({ eligible: false, reason: 'rejected' });
      if (result.eligible || result.reason !== 'rejected')
        throw new Error('expected rejection');
      expect(result.problems.length).toBeGreaterThan(0);
      expect(result.message.length).toBeGreaterThan(0);
    });

    it('does not decide criteria quality itself', () => {
      // The generator owns that judgement (#62, #108). A second opinion here
      // would let an issue pass one gate and fail the other.
      const good = project();
      expect(good.eligible).toBe(true);
    });
  });

  describe('purity', () => {
    it('does not mutate the issue it was given', () => {
      const original = issue();
      const snapshot = JSON.stringify(original);

      projectIssue({ issue: original, repository: REPO, baseCommit: BASE });

      expect(JSON.stringify(original)).toBe(snapshot);
    });

    it('returns the same work order for the same input', () => {
      // #46's rule: the tick observes, the projection is a pure function of
      // what it observed. That is what makes it safe during the observation
      // week and testable against fixtures.
      const a = project();
      const b = project();

      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
  });
});
