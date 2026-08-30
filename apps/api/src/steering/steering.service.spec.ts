import { ConflictException, NotFoundException } from '@nestjs/common';

import { GitHubNotFoundError } from '../github/github.errors';
import { INPUT_LABELS } from '../github/labels/factory-labels';
import type { EpicChildrenService } from '../github/read/epic-children.service';
import type { GitHubReadService } from '../github/read/github-read.service';
import type { NormalizedIssue } from '../github/read/github-read.types';
import type { GitHubWriteService } from '../github/write/github-write.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { OperatorSettingsService } from '../settings/operator-settings/operator-settings.service';
import { applySteeringSchema, proposeSteeringSchema } from './dto/steering.dto';
import { SteeringService } from './steering.service';

/**
 * Steering (#425, epic #419).
 *
 * The claims worth testing are the architectural ones, not "it called
 * addLabel":
 *
 *  - an instruction naming explicit issue numbers reaches NO model, and the
 *    proof is that the chat's settings are never read;
 *  - nothing about scope is persisted anywhere but GitHub labels;
 *  - removals are as visible as additions, and the blast radius is a number;
 *  - an unresolvable reference is an outcome, not an exception;
 *  - apply re-checks, and drift skips one operation rather than the batch.
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const REPOS = [{ owner: 'acme', name: 'app' }];

function issue(
  number: number,
  overrides: Partial<NormalizedIssue> = {},
): NormalizedIssue {
  return {
    number,
    title: `Issue ${number}`,
    body: null,
    state: 'open',
    author: 'someone',
    labels: [],
    inputLabels: [],
    unknownInputLabels: [],
    ignoredLabels: [],
    observedMirrorLabels: [],
    isPullRequest: false,
    url: `https://github.com/acme/app/issues/${number}`,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as NormalizedIssue;
}

/**
 * A Prisma stand-in that RECORDS every model/method it is asked for and
 * refuses anything the harness did not explicitly allow.
 *
 * A plain object of jest mocks cannot state the claim this file has to make.
 * "No scope is persisted outside GitHub labels" is a statement about calls
 * that were NOT made, over a surface nobody enumerates, and a mock that
 * silently returns `undefined` for `prisma.workOrder.update` would let exactly
 * the bug through while every assertion passed.
 */
function recordingPrisma(
  handlers: Record<string, (...args: never[]) => unknown>,
) {
  const touched: string[] = [];

  const proxy = new Proxy(
    {},
    {
      get(_target, model) {
        if (typeof model !== 'string') return undefined;
        return new Proxy(
          {},
          {
            get(_inner, method) {
              if (typeof method !== 'string') return undefined;
              const key = `${model}.${method}`;
              return (...args: never[]) => {
                touched.push(key);
                const impl = handlers[key];
                if (impl === undefined) {
                  throw new Error(`Unexpected Prisma call: ${key}`);
                }
                return impl(...args);
              };
            },
          },
        );
      },
    },
  ) as unknown as PrismaService;

  return { prisma: proxy, touched };
}

const CHAT_SETTINGS: Record<string, unknown> = {
  'chat.model.provider': 'anthropic',
  'chat.model.name': '',
  'chat.model.timeoutMs': 30_000,
  'chat.model.defaultMaxTokens': 2_048,
  'models.anthropic.apiKey': '',
  'models.anthropic.baseUrl': '',
};

function harness(
  options: {
    repositories?: {
      owner: string;
      name: string;
      projectId?: string | null;
    }[];
    settings?: Record<string, unknown>;
    writesEnabled?: boolean;
    /**
     * Whether `project.findUnique` finds a row for whatever id a test's
     * `project` scope names. Defaults to true so a project-scope test does
     * not have to configure it just to reach the interesting part of
     * `resolveScope`; set false to exercise the 404 (`requireProject`).
     */
    projectExists?: boolean;
  } = {},
) {
  const auditCreate = jest.fn().mockResolvedValue({});
  const repositoryFindMany = jest
    .fn()
    .mockResolvedValue(options.repositories ?? REPOS);
  const projectFindUnique = jest.fn();
  projectFindUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) =>
      options.projectExists === false ? null : { id: where.id },
  );

  const { prisma, touched } = recordingPrisma({
    'repository.findMany': repositoryFindMany,
    'project.findUnique': projectFindUnique,
    'auditEvent.create': auditCreate,
  });

  const getIssue = jest.fn();
  const listIssues = jest.fn().mockResolvedValue({
    issues: [],
    truncated: false,
    allFromCache: false,
  });
  const resolveEpicChildren = jest.fn();

  const addLabel = jest.fn().mockResolvedValue({
    performed: options.writesEnabled !== false,
    noop: false,
  });
  const removeLabel = jest.fn().mockResolvedValue({
    performed: options.writesEnabled !== false,
    noop: false,
  });

  const settingsGet = jest.fn((key: string) => {
    const table = { ...CHAT_SETTINGS, ...(options.settings ?? {}) };
    return table[key];
  });

  const service = new SteeringService(
    prisma,
    { getIssue, listIssues } as unknown as GitHubReadService,
    { resolve: resolveEpicChildren } as unknown as EpicChildrenService,
    {
      addLabel,
      removeLabel,
      enabled: options.writesEnabled !== false,
    } as unknown as GitHubWriteService,
    { get: settingsGet } as unknown as OperatorSettingsService,
  );

  jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);

  return {
    service,
    touched,
    auditCreate,
    projectFindUnique,
    getIssue,
    listIssues,
    resolveEpicChildren,
    addLabel,
    removeLabel,
    settingsGet,
  };
}

// ---------------------------------------------------------------------------

describe('SteeringService', () => {
  describe('explicit issue numbers reach no model at all', () => {
    it('never reads the chat model settings on the deterministic path', async () => {
      // The acceptance criterion, made checkable. VISION §3.1/§7: a model here
      // is "slower, costlier, and less reliable with no upside", and it can
      // hallucinate an issue number the caller will then write labels to.
      // Reading `chat.model.*` at all would mean the code path had been taken.
      const h = harness();
      h.getIssue.mockImplementation(async (_repo, number: number) =>
        issue(number),
      );

      await h.service.propose({
        instruction: 'only work on issues 1, 2 and 3',
      });

      expect(h.settingsGet).not.toHaveBeenCalled();
    });

    it('reports the parse as deterministic with no model block to report', async () => {
      const h = harness();
      h.getIssue.mockImplementation(async (_repo, number: number) =>
        issue(number),
      );

      const proposal = await h.service.propose({
        instruction: 'work on #1 and #2',
      });

      expect(proposal.interpretation.method).toBe('deterministic');
      expect(proposal.interpretation.modelInvoked).toBe(false);
      expect(proposal.interpretation.model).toBeNull();
      expect(proposal.interpretation.spend).toBeNull();
    });

    it('proposes the labels the instruction asks for and nothing else', async () => {
      const h = harness();
      h.getIssue.mockImplementation(async (_repo, number: number) =>
        issue(number),
      );

      const proposal = await h.service.propose({
        instruction: 'work on #1 and #2',
      });

      expect(proposal.operations).toHaveLength(2);
      expect(proposal.operations[0]).toMatchObject({
        ref: 'acme/app#1',
        add: [INPUT_LABELS.READY],
        remove: [],
        named: true,
      });
      expect(h.addLabel).not.toHaveBeenCalled();
      expect(h.removeLabel).not.toHaveBeenCalled();
    });

    it('removes a hold when told to work on a held issue, and shows the removal', async () => {
      // An issue carrying both labels is HELD (`issue-projection.ts`), so an
      // instruction to work on it that left the hold in place would report
      // success and change nothing. It is a removal, so it is in `remove`.
      const h = harness();
      h.getIssue.mockResolvedValue(
        issue(7, { inputLabels: [INPUT_LABELS.HOLD] }),
      );

      const proposal = await h.service.propose({ instruction: 'work on #7' });

      expect(proposal.operations[0].add).toEqual([INPUT_LABELS.READY]);
      expect(proposal.operations[0].remove).toEqual([INPUT_LABELS.HOLD]);
      expect(proposal.blastRadius.destructive).toBe(true);
    });

    it('proposes nothing for an issue already in the state asked for', async () => {
      const h = harness();
      h.getIssue.mockResolvedValue(
        issue(7, { inputLabels: [INPUT_LABELS.READY] }),
      );

      const proposal = await h.service.propose({ instruction: 'work on #7' });

      expect(proposal.operations[0].add).toEqual([]);
      expect(proposal.operations[0].remove).toEqual([]);
      // Carried so the operator can see what happened to the issue they named,
      // but not counted: inflating the blast radius makes the warning less
      // believable exactly where it needs to be believed.
      expect(proposal.blastRadius.issuesAffected).toBe(0);
    });
  });

  describe('"only" is destructive, and the proposal says how destructive', () => {
    it('un-readies every candidate the instruction did not name', async () => {
      const h = harness();
      h.getIssue.mockImplementation(async (_repo, number: number) =>
        issue(number),
      );
      // Three named, twenty currently ready — seventeen of them collateral.
      h.listIssues.mockResolvedValue({
        issues: Array.from({ length: 20 }, (_, index) =>
          issue(index + 1, { inputLabels: [INPUT_LABELS.READY] }),
        ),
        truncated: false,
        allFromCache: false,
      });

      const proposal = await h.service.propose({
        instruction: 'only work on issues 1, 2 and 3',
      });

      expect(h.listIssues).toHaveBeenCalledWith(
        { owner: 'acme', name: 'app' },
        { state: 'open', labels: [INPUT_LABELS.READY] },
      );
      expect(proposal.blastRadius.unreadied).toBe(17);
      expect(proposal.blastRadius.collateral).toBe(17);
      expect(proposal.blastRadius.summary).toContain('un-ready 17 issues');
      expect(proposal.blastRadius.destructive).toBe(true);
    });

    it('marks the collateral issues as unnamed, so a UI can separate them', async () => {
      const h = harness();
      h.getIssue.mockImplementation(async (_repo, number: number) =>
        issue(number),
      );
      h.listIssues.mockResolvedValue({
        issues: [issue(9, { inputLabels: [INPUT_LABELS.READY] })],
        truncated: false,
        allFromCache: false,
      });

      const proposal = await h.service.propose({
        instruction: 'only work on #1',
      });

      const collateral = proposal.operations.find((o) => !o.named);
      expect(collateral).toMatchObject({
        ref: 'acme/app#9',
        remove: [INPUT_LABELS.READY],
        add: [],
      });
    });

    it('also holds the others when the instruction says to hold them', async () => {
      const h = harness();
      h.getIssue.mockImplementation(async (_repo, number: number) =>
        issue(number),
      );
      h.listIssues.mockResolvedValue({
        issues: [issue(9, { inputLabels: [INPUT_LABELS.READY] })],
        truncated: false,
        allFromCache: false,
      });

      const proposal = await h.service.propose({
        instruction: 'only work on #1 and hold everything else',
      });

      const collateral = proposal.operations.find((o) => !o.named);
      expect(collateral?.add).toEqual([INPUT_LABELS.HOLD]);
      expect(collateral?.remove).toEqual([INPUT_LABELS.READY]);
    });

    it('sweeps nothing at all when the instruction is not exclusive', async () => {
      const h = harness();
      h.getIssue.mockImplementation(async (_repo, number: number) =>
        issue(number),
      );

      await h.service.propose({ instruction: 'work on #1' });

      expect(h.listIssues).not.toHaveBeenCalled();
    });
  });

  describe('a stated scope (#459, ADR-0020)', () => {
    it('sweeps the single registered repository when no scope is stated, unaffected by this change', async () => {
      // The shortcut ADR-0020 deliberately preserves: with nothing for
      // "everything else" to be ambiguous ABOUT, the sweep runs exactly as it
      // always has, with no scope required.
      const h = harness(); // default REPOS: exactly one repository
      h.getIssue.mockImplementation(async (_repo, number: number) =>
        issue(number),
      );
      h.listIssues.mockResolvedValue({
        issues: [issue(9, { inputLabels: [INPUT_LABELS.READY] })],
        truncated: false,
        allFromCache: false,
      });

      const proposal = await h.service.propose({
        instruction: 'only work on #1',
      });

      expect(proposal.unresolved).toEqual([]);
      expect(proposal.scope.repositories).toEqual(['acme/app']);
      expect(proposal.scope.candidatesConsidered).toBe(1);
    });

    it('reports ambiguous-scope and sweeps nothing over more than one registered repository', async () => {
      // The bug ADR-0020 fixes: an exclusive `ready` instruction naming no
      // scope used to take `registered.map(toRef)` silently. Now it is
      // unresolved, the same refusal `repositoryFor` already gives a bare
      // `#12` in this situation, one field wider.
      const h = harness({
        repositories: [
          { owner: 'acme', name: 'app' },
          { owner: 'acme', name: 'other' },
        ],
      });
      h.getIssue.mockImplementation(async (_repo, number: number) =>
        issue(number),
      );

      const proposal = await h.service.propose({
        instruction: 'only work on acme/app#1',
      });

      expect(proposal.unresolved).toContainEqual(
        expect.objectContaining({ reason: 'ambiguous-scope' }),
      );
      // Reported as swept: nothing, not "ten repositories were considered".
      expect(proposal.scope.repositories).toEqual([]);
      expect(proposal.scope.candidatesConsidered).toBe(0);
      expect(h.listIssues).not.toHaveBeenCalled();
      // The issue the operator named outright still resolves — the
      // ambiguity is about "everything else", not about a named issue.
      expect(proposal.operations.map((o) => o.ref)).toEqual(['acme/app#1']);
    });

    it('rejects a project id that names no project, as a 404 rather than an unresolved entry', async () => {
      // The same line `requireRegistered` draws for `repository`: a request
      // PARAMETER naming something Opifex does not know about is a caller
      // mistake, not an observation about the backlog.
      const h = harness({ projectExists: false });

      await expect(
        h.service.propose({
          instruction: 'work on #1',
          project: '11111111-2222-4333-8444-555555555555',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('project "none" selects only the repositories in no project, and looks nothing up', async () => {
      const h = harness({
        repositories: [
          { owner: 'acme', name: 'app', projectId: 'proj-1' },
          { owner: 'acme', name: 'lib', projectId: null },
        ],
      });
      h.listIssues.mockResolvedValue({
        issues: [],
        truncated: false,
        allFromCache: false,
      });

      const proposal = await h.service.propose({
        instruction: 'release everything else',
        project: 'none',
      });

      expect(proposal.scope.repositories).toEqual(['acme/lib']);
      expect(h.listIssues).toHaveBeenCalledTimes(1);
      expect(h.listIssues).toHaveBeenCalledWith(
        { owner: 'acme', name: 'lib' },
        { state: 'open', labels: [INPUT_LABELS.READY] },
      );
      // 'none' names a state of `Repository`, not a row in `projects` — there
      // is nothing to look up.
      expect(h.touched).not.toContain('project.findUnique');
    });

    it('a real project id selects that project\'s repositories and none other', async () => {
      // Specifically NOT `registered.map(toRef)` — the whole point of naming
      // a project instead of `allRepositories: true`.
      const h = harness({
        repositories: [
          { owner: 'acme', name: 'app', projectId: 'proj-1' },
          { owner: 'acme', name: 'lib', projectId: null },
        ],
      });
      h.listIssues.mockResolvedValue({
        issues: [],
        truncated: false,
        allFromCache: false,
      });

      const proposal = await h.service.propose({
        instruction: 'release everything else',
        project: 'proj-1',
      });

      expect(proposal.scope.repositories).toEqual(['acme/app']);
      expect(h.listIssues).toHaveBeenCalledTimes(1);
      expect(h.listIssues).toHaveBeenCalledWith(
        { owner: 'acme', name: 'app' },
        { state: 'open', labels: [INPUT_LABELS.READY] },
      );
    });

    it('reports empty-scope, not an empty sweep, when a project matches no observed repository', async () => {
      const h = harness({
        repositories: [{ owner: 'acme', name: 'app', projectId: 'proj-1' }],
      });

      const proposal = await h.service.propose({
        instruction: 'release everything else',
        project: 'proj-2',
      });

      expect(proposal.unresolved).toContainEqual(
        expect.objectContaining({ reason: 'empty-scope' }),
      );
      expect(proposal.scope.repositories).toEqual([]);
      expect(proposal.scope.candidatesConsidered).toBe(0);
      expect(h.listIssues).not.toHaveBeenCalled();
    });

    it('reports empty-scope for a bare issue number when the scope resolves to nothing', async () => {
      // The same `repositoryFor` refusal a no-repository deployment gives a
      // bare number, but naming WHY there is nothing to resolve against: the
      // stated scope, not an empty registry.
      const h = harness({
        repositories: [{ owner: 'acme', name: 'app', projectId: 'proj-1' }],
      });

      const proposal = await h.service.propose({
        instruction: 'work on #1',
        project: 'proj-2',
      });

      expect(proposal.unresolved[0]).toMatchObject({ reason: 'empty-scope' });
      expect(h.getIssue).not.toHaveBeenCalled();
    });

    it('names the stated scope, not the whole registry, in an ambiguous-repository detail', async () => {
      // #459's point 8: the reason is unchanged, but the wording now says
      // what the operator actually stated when they stated something.
      const h = harness({
        repositories: [
          { owner: 'acme', name: 'app', projectId: 'proj-1' },
          { owner: 'acme', name: 'lib', projectId: 'proj-1' },
          { owner: 'acme', name: 'unrelated', projectId: null },
        ],
      });

      const proposal = await h.service.propose({
        instruction: 'work on #1',
        project: 'proj-1',
      });

      expect(proposal.unresolved[0]).toMatchObject({
        reason: 'ambiguous-repository',
      });
      expect(proposal.unresolved[0].detail).toContain(
        'Project `proj-1` covers 2 repositories',
      );
      expect(proposal.unresolved[0].detail).not.toContain(
        '3 repositories are registered',
      );
      expect(h.getIssue).not.toHaveBeenCalled();
    });

    it('resolves a fully-qualified owner/name#12 against every registered repository, not the stated scope', async () => {
      // #459's point 9: a scope constrains what an instruction reaches
      // without being told. An issue written out in full was told.
      const h = harness({
        repositories: [
          { owner: 'acme', name: 'app', projectId: 'proj-1' },
          { owner: 'acme', name: 'other', projectId: null },
        ],
      });
      h.getIssue.mockImplementation(async (_repo, number: number) =>
        issue(number),
      );

      const proposal = await h.service.propose({
        instruction: 'work on acme/other#5',
        project: 'proj-1', // names only acme/app
      });

      expect(proposal.unresolved).toEqual([]);
      expect(proposal.operations.map((o) => o.ref)).toEqual(['acme/other#5']);
    });
  });

  describe('an epic resolves through #424', () => {
    it('turns the epic into operations on its children, never on itself', async () => {
      const h = harness();
      h.resolveEpicChildren.mockResolvedValue({
        epic: {
          owner: 'acme',
          name: 'app',
          number: 419,
          ref: 'acme/app#419',
          title: 'Steering',
        },
        children: [
          child(421),
          child(423),
          child(424, { state: 'closed' }),
          child(425, { unreadable: true }),
        ],
        source: 'issue-body',
        checkedAt: new Date(),
        maxDepth: 1,
        skipped: [],
        nativeUnavailable: 'GitHub records no sub-issues for this issue',
        unparsed: [],
      });
      h.getIssue.mockImplementation(async (_repo, number: number) =>
        issue(number),
      );

      const proposal = await h.service.propose({
        instruction: 'work on epic #419',
      });

      expect(h.resolveEpicChildren).toHaveBeenCalledWith(
        { owner: 'acme', name: 'app' },
        419,
        {},
      );
      expect(proposal.operations.map((o) => o.ref)).toEqual([
        'acme/app#421',
        'acme/app#423',
      ]);
      // The epic issue is a tracking issue, not work. Marking it ready would
      // offer its body to a runner as a task spec.
      expect(proposal.operations.map((o) => o.number)).not.toContain(419);
    });

    it('reports the epic provenance, so a surprising membership is explainable', async () => {
      const h = harness();
      h.resolveEpicChildren.mockResolvedValue({
        epic: {
          owner: 'acme',
          name: 'app',
          number: 419,
          ref: 'acme/app#419',
          title: 'Steering',
        },
        children: [child(421)],
        source: 'issue-body',
        checkedAt: new Date(),
        maxDepth: 1,
        skipped: [],
        nativeUnavailable: 'GitHub records no sub-issues for this issue',
        unparsed: [],
      });
      h.getIssue.mockResolvedValue(issue(421));

      const proposal = await h.service.propose({
        instruction: 'work on epic #419',
      });

      expect(proposal.scope.epics).toEqual([
        {
          ref: 'acme/app#419',
          title: 'Steering',
          source: 'issue-body',
          maxDepth: 1,
          childrenFound: 1,
          nativeUnavailable: 'GitHub records no sub-issues for this issue',
        },
      ]);
    });

    it('passes an explicit depth through rather than widening silently', async () => {
      const h = harness();
      h.resolveEpicChildren.mockResolvedValue({
        epic: {
          owner: 'acme',
          name: 'app',
          number: 419,
          ref: 'acme/app#419',
          title: 'Steering',
        },
        children: [],
        source: 'none',
        checkedAt: new Date(),
        maxDepth: 2,
        skipped: [],
        nativeUnavailable: null,
        unparsed: [],
      });

      await h.service.propose({
        instruction: 'work on epic #419',
        maxDepth: 2,
      });

      expect(h.resolveEpicChildren).toHaveBeenCalledWith(
        { owner: 'acme', name: 'app' },
        419,
        { maxDepth: 2 },
      );
    });
  });

  describe('an unresolvable reference is an outcome, not an error', () => {
    it('reports an issue GitHub cannot find', async () => {
      const h = harness();
      h.getIssue.mockRejectedValue(
        new GitHubNotFoundError(
          'Not Found',
          404,
          'GET',
          '/repos/acme/app/issues/999',
        ),
      );

      const proposal = await h.service.propose({ instruction: 'work on #999' });

      expect(proposal.operations).toEqual([]);
      expect(proposal.unresolved).toEqual([
        expect.objectContaining({ reason: 'issue-not-found' }),
      ]);
    });

    it('reports a closed issue', async () => {
      const h = harness();
      h.getIssue.mockResolvedValue(issue(12, { state: 'closed' }));

      const proposal = await h.service.propose({ instruction: 'work on #12' });

      expect(proposal.unresolved[0]).toMatchObject({
        reason: 'issue-closed',
        reference: '#12',
      });
    });

    it('reports a pull request', async () => {
      const h = harness();
      h.getIssue.mockResolvedValue(issue(12, { isPullRequest: true }));

      const proposal = await h.service.propose({ instruction: 'work on #12' });

      expect(proposal.unresolved[0].reason).toBe('is-pull-request');
    });

    it('reports a repository Opifex does not observe', async () => {
      const h = harness();

      const proposal = await h.service.propose({
        instruction: 'work on other/repo#12',
      });

      expect(proposal.unresolved[0]).toMatchObject({
        reason: 'repository-not-registered',
      });
      expect(h.getIssue).not.toHaveBeenCalled();
    });

    it('refuses to guess which repository a bare number means', async () => {
      // Writing a label to issue 12 of a repository the operator was not
      // thinking about is exactly the harm `unresolved` exists to report
      // instead of causing.
      const h = harness({
        repositories: [
          { owner: 'acme', name: 'app' },
          { owner: 'acme', name: 'web' },
        ],
      });

      const proposal = await h.service.propose({ instruction: 'work on #12' });

      expect(proposal.unresolved[0]).toMatchObject({
        reason: 'ambiguous-repository',
      });
      expect(proposal.unresolved[0].detail).toContain('owner/name#12');
      expect(h.getIssue).not.toHaveBeenCalled();
    });

    it('rejects a requested repository that is not registered', async () => {
      // A request PARAMETER naming an unobserved repository is a caller
      // mistake, not an observation about the backlog, so it is a 404 rather
      // than an entry in `unresolved`.
      const h = harness();

      await expect(
        h.service.propose({
          instruction: 'work on #1',
          repository: 'other/repo',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('an instruction needing interpretation reports, and does not fail', () => {
    it('answers with an unresolved entry rather than throwing', async () => {
      const h = harness();

      const proposal = await h.service.propose({
        instruction: 'just the auth epic, hold everything else',
      });

      expect(proposal.operations).toEqual([]);
      expect(proposal.unresolved[0].reason).toBe('needs-interpretation');
      expect(proposal.interpretation.method).toBe('none');
    });

    it('says the chat is unconfigured AND that no model was asked anyway', async () => {
      // Two facts, reported together on purpose. An operator who sets
      // `chat.model.name` to fix the first would otherwise find nothing
      // changed and have no way to discover the second.
      const h = harness();

      const proposal = await h.service.propose({
        instruction: 'just the auth epic',
      });

      expect(proposal.interpretation.model).toMatchObject({
        consumer: 'chat',
        available: false,
      });
      expect(proposal.interpretation.model?.unavailableReason).toContain(
        'models.anthropic.apiKey',
      );
      expect(proposal.interpretation.spend).toMatchObject({ admitted: false });
      expect(proposal.interpretation.spend?.reason).toContain('spend ceiling');
    });

    it('still refuses to spend when the chat IS fully configured', async () => {
      // The decision #425 had to take: a metered consumer with no cumulative
      // bound does not run. Configuring a key and a model does not change it,
      // and the response must not imply that it would.
      const h = harness({
        settings: {
          'models.anthropic.apiKey': 'sk-real',
          'chat.model.name': 'claude-haiku-4',
        },
      });

      const proposal = await h.service.propose({
        instruction: 'just the auth epic',
      });

      expect(proposal.interpretation.model).toMatchObject({
        available: true,
        model: 'claude-haiku-4',
      });
      expect(proposal.interpretation.modelInvoked).toBe(false);
      expect(proposal.interpretation.spend?.admitted).toBe(false);
    });
  });

  describe('nothing about scope is persisted outside GitHub labels', () => {
    it('touches no Prisma model but repository reads and one audit row', async () => {
      // Epic #419's architectural commitment. A `scope` table the dispatcher
      // consulted would make labels and that table two expressions of one
      // intent, leaving the reconciler to arbitrate — the two-sources-of-truth
      // bug epic #332 spent twenty-one issues removing.
      const h = harness();
      h.getIssue.mockImplementation(async (_repo, number: number) =>
        issue(number),
      );
      h.listIssues.mockResolvedValue({
        issues: [issue(9, { inputLabels: [INPUT_LABELS.READY] })],
        truncated: false,
        allFromCache: false,
      });

      const proposal = await h.service.propose({
        instruction: 'only work on #1 and hold everything else',
      });

      // Propose writes NOTHING at all.
      expect(h.touched).toEqual(['repository.findMany']);

      await h.service.apply(
        {
          proposalId: proposal.proposalId,
          proposedAt: proposal.proposedAt,
          instruction: proposal.instruction,
          operations: proposal.operations.map(toApplyOperation),
        },
        'user-1',
      );

      const writes = h.touched.filter(
        (call) => !call.endsWith('.findMany') && !call.endsWith('.findFirst'),
      );
      expect(writes).toEqual(['auditEvent.create']);
      // And specifically: no work order, no repository, no scope of any kind.
      expect(h.touched.join(',')).not.toContain('workOrder');
    });

    it('grows the read side by exactly one entry when propose resolves a project scope', async () => {
      // ADR-0020 Consequences: resolving a `project` scope adds a `Project`
      // read, so the exact array above gains ONE entry. Loosening this to
      // "no writes" would also pass if propose queried every table in the
      // schema — the property worth pinning is that the read side is fully
      // accounted for too, not merely that nothing was written.
      const h = harness({
        repositories: [{ owner: 'acme', name: 'app', projectId: 'proj-1' }],
      });
      h.listIssues.mockResolvedValue({
        issues: [],
        truncated: false,
        allFromCache: false,
      });

      await h.service.propose({
        instruction: 'release everything else',
        project: 'proj-1',
      });

      expect(h.touched).toEqual(['repository.findMany', 'project.findUnique']);
    });
  });

  describe('apply re-checks the labels it was proposed against', () => {
    it('applies an operation whose labels have not moved', async () => {
      const h = harness();
      h.getIssue.mockResolvedValue(issue(1));

      const result = await h.service.apply(
        {
          proposalId: PROPOSAL_ID,
          proposedAt: new Date().toISOString(),
          instruction: 'work on #1',
          operations: [
            {
              owner: 'acme',
              name: 'app',
              number: 1,
              add: [INPUT_LABELS.READY],
              remove: [],
              observedInputLabels: [],
            },
          ],
        },
        'user-1',
      );

      expect(h.addLabel).toHaveBeenCalledWith(
        { owner: 'acme', name: 'app' },
        1,
        INPUT_LABELS.READY,
      );
      expect(result.applied).toHaveLength(1);
      expect(result.skipped).toEqual([]);
      expect(result.labelWritten).toBe(true);
      expect(result.reconciled).toBe(false);
    });

    it('skips an issue whose factory labels drifted, and says which label', async () => {
      // The case that matters: somebody applied `factory:hold` by hand after
      // the proposal was made, and this operation would mark it ready.
      const h = harness();
      h.getIssue.mockResolvedValue(
        issue(1, { inputLabels: [INPUT_LABELS.HOLD] }),
      );

      const result = await h.service.apply(
        {
          proposalId: PROPOSAL_ID,
          proposedAt: new Date().toISOString(),
          instruction: 'work on #1',
          operations: [
            {
              owner: 'acme',
              name: 'app',
              number: 1,
              add: [INPUT_LABELS.READY],
              remove: [],
              observedInputLabels: [],
            },
          ],
        },
        'user-1',
      );

      expect(h.addLabel).not.toHaveBeenCalled();
      expect(result.applied).toEqual([]);
      expect(result.skipped[0]).toMatchObject({
        ref: 'acme/app#1',
        reason: 'drift',
        drift: [
          { label: INPUT_LABELS.HOLD, wasPresent: false, isPresent: true },
        ],
      });
    });

    it('lets one drifted issue skip its own operation and not the batch', async () => {
      // Aborting would let one unrelated edit discard every other correct
      // operation, and the operator's only recourse would be to re-propose and
      // race again.
      const h = harness();
      h.getIssue.mockImplementation(async (_repo, number: number) =>
        number === 2
          ? issue(2, { inputLabels: [INPUT_LABELS.HOLD] })
          : issue(number),
      );

      const result = await h.service.apply(
        {
          proposalId: PROPOSAL_ID,
          proposedAt: new Date().toISOString(),
          instruction: 'work on #1, #2 and #3',
          operations: [1, 2, 3].map((number) => ({
            owner: 'acme',
            name: 'app',
            number,
            add: [INPUT_LABELS.READY] as ('factory:ready' | 'factory:hold')[],
            remove: [] as ('factory:ready' | 'factory:hold')[],
            observedInputLabels: [],
          })),
        },
        'user-1',
      );

      expect(result.applied.map((a) => a.ref)).toEqual([
        'acme/app#1',
        'acme/app#3',
      ]);
      expect(result.skipped.map((s) => s.ref)).toEqual(['acme/app#2']);
      expect(result.summary).toMatchObject({
        operationsRequested: 3,
        operationsApplied: 2,
        operationsSkipped: 1,
      });
    });

    it('skips an issue closed since the proposal', async () => {
      const h = harness();
      h.getIssue.mockResolvedValue(issue(1, { state: 'closed' }));

      const result = await h.service.apply(
        {
          proposalId: PROPOSAL_ID,
          proposedAt: new Date().toISOString(),
          instruction: 'work on #1',
          operations: [
            {
              owner: 'acme',
              name: 'app',
              number: 1,
              add: [INPUT_LABELS.READY],
              remove: [],
              observedInputLabels: [],
            },
          ],
        },
        'user-1',
      );

      expect(result.skipped[0].reason).toBe('issue-closed');
      expect(h.addLabel).not.toHaveBeenCalled();
    });

    it('refuses a proposal that has expired rather than writing it blind', async () => {
      const h = harness();

      await expect(
        h.service.apply(
          {
            proposalId: PROPOSAL_ID,
            proposedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
            instruction: 'work on #1',
            operations: [
              {
                owner: 'acme',
                name: 'app',
                number: 1,
                add: [INPUT_LABELS.READY],
                remove: [],
                observedInputLabels: [],
              },
            ],
          },
          'user-1',
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(h.addLabel).not.toHaveBeenCalled();
      expect(h.auditCreate).not.toHaveBeenCalled();
    });
  });

  describe('the kill switch, in the vocabulary queue steering already uses', () => {
    it('says the operations were recorded and not performed', async () => {
      const h = harness({ writesEnabled: false });
      h.getIssue.mockResolvedValue(issue(1));

      const result = await h.service.apply(
        {
          proposalId: PROPOSAL_ID,
          proposedAt: new Date().toISOString(),
          instruction: 'work on #1',
          operations: [
            {
              owner: 'acme',
              name: 'app',
              number: 1,
              add: [INPUT_LABELS.READY],
              remove: [],
              observedInputLabels: [],
            },
          ],
        },
        'user-1',
      );

      // The call path is the REAL one — the write adapter was still asked, and
      // reported `performed: false`. That is what makes the observation week's
      // diff log a record of what would have happened.
      expect(h.addLabel).toHaveBeenCalled();
      expect(result.writesEnabled).toBe(false);
      expect(result.labelWritten).toBe(false);
      expect(result.summary.labelWrites).toBe(1);
      expect(result.summary.labelWritesPerformed).toBe(0);
    });
  });

  describe('applied steering is attributable', () => {
    it('records who instructed, what they said, and what was done', async () => {
      const h = harness();
      h.getIssue.mockResolvedValue(issue(1));

      await h.service.apply(
        {
          proposalId: PROPOSAL_ID,
          proposedAt: new Date().toISOString(),
          instruction: 'only work on #1 and hold everything else',
          operations: [
            {
              owner: 'acme',
              name: 'app',
              number: 1,
              add: [INPUT_LABELS.READY],
              remove: [],
              observedInputLabels: [],
            },
          ],
        },
        'user-42',
      );

      expect(h.auditCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorUserId: 'user-42',
          action: 'steering.apply',
          targetType: 'steering_proposal',
          targetId: PROPOSAL_ID,
          meta: expect.objectContaining({
            instruction: 'only work on #1 and hold everything else',
            applied: [
              { ref: 'acme/app#1', add: [INPUT_LABELS.READY], remove: [] },
            ],
          }),
        }),
      });
    });

    it('records the apply even when the kill switch wrote nothing', async () => {
      // "Who asked for this and when" is the fact worth keeping, and an apply
      // that reached no GitHub is exactly the one somebody will need to find.
      const h = harness({ writesEnabled: false });
      h.getIssue.mockResolvedValue(issue(1));

      await h.service.apply(
        {
          proposalId: PROPOSAL_ID,
          proposedAt: new Date().toISOString(),
          instruction: 'work on #1',
          operations: [
            {
              owner: 'acme',
              name: 'app',
              number: 1,
              add: [INPUT_LABELS.READY],
              remove: [],
              observedInputLabels: [],
            },
          ],
        },
        'user-1',
      );

      expect(h.auditCreate).toHaveBeenCalled();
      expect(h.auditCreate.mock.calls[0][0].data.meta).toMatchObject({
        writesEnabled: false,
        labelWritten: false,
      });
    });
  });

  describe('proposeSteeringSchema accepts at most one scope (ADR-0020)', () => {
    it('accepts an instruction with no scope field at all', () => {
      const parsed = proposeSteeringSchema.safeParse({
        instruction: 'work on #1',
      });

      expect(parsed.success).toBe(true);
    });

    it.each([
      ['repository', { repository: 'acme/app' }],
      ['project: none', { project: 'none' }],
      ['project: uuid', { project: '11111111-2222-4333-8444-555555555555' }],
      ['allRepositories', { allRepositories: true }],
    ])('accepts exactly one scope (%s)', (_label, scope) => {
      const parsed = proposeSteeringSchema.safeParse({
        instruction: 'work on #1',
        ...scope,
      });

      expect(parsed.success).toBe(true);
    });

    it.each([
      ['repository + project', { repository: 'acme/app', project: 'none' }],
      [
        'repository + allRepositories',
        { repository: 'acme/app', allRepositories: true },
      ],
      ['project + allRepositories', { project: 'none', allRepositories: true }],
    ])(
      'rejects two scopes sent together (%s), rather than inventing a precedence rule',
      (_label, scope) => {
        const parsed = proposeSteeringSchema.safeParse({
          instruction: 'work on #1',
          ...scope,
        });

        expect(parsed.success).toBe(false);
      },
    );

    it('rejects allRepositories: false, so there is no falsy-but-present state', () => {
      const parsed = proposeSteeringSchema.safeParse({
        instruction: 'work on #1',
        allRepositories: false,
      });

      expect(parsed.success).toBe(false);
    });

    it('rejects a project value that is neither a uuid nor "none"', () => {
      const parsed = proposeSteeringSchema.safeParse({
        instruction: 'work on #1',
        project: 'acme-repos',
      });

      expect(parsed.success).toBe(false);
    });
  });

  describe('what apply refuses to write', () => {
    it('rejects factory:clear-quarantine before any service sees it', () => {
      // #49: that label must be applied by a human on GitHub, where the
      // applier's identity is native and verifiable from the issue timeline.
      // Accepting it here would launder the actor through the Opifex token.
      const parsed = applySteeringSchema.safeParse({
        proposalId: PROPOSAL_ID,
        proposedAt: new Date().toISOString(),
        instruction: 'clear it',
        operations: [
          {
            owner: 'acme',
            name: 'app',
            number: 1,
            add: [INPUT_LABELS.CLEAR_QUARANTINE],
            remove: [],
            observedInputLabels: [],
          },
        ],
      });

      expect(parsed.success).toBe(false);
    });

    it('rejects an arbitrary label, so apply is not a general label writer', () => {
      const parsed = applySteeringSchema.safeParse({
        proposalId: PROPOSAL_ID,
        proposedAt: new Date().toISOString(),
        instruction: 'label it',
        operations: [
          {
            owner: 'acme',
            name: 'app',
            number: 1,
            add: ['priority:high'],
            remove: [],
            observedInputLabels: [],
          },
        ],
      });

      expect(parsed.success).toBe(false);
    });
  });
});

const PROPOSAL_ID = '11111111-2222-4333-8444-555555555555';

function child(number: number, overrides: Record<string, unknown> = {}) {
  return {
    owner: 'acme',
    name: 'app',
    number,
    ref: `acme/app#${number}`,
    title: `Child ${number}`,
    state: 'open',
    isPullRequest: false,
    source: 'issue-body',
    depth: 1,
    namedBy: 'acme/app#419',
    unreadable: false,
    ...overrides,
  };
}

function toApplyOperation(operation: {
  owner: string;
  name: string;
  number: number;
  add: string[];
  remove: string[];
  observedInputLabels: string[];
}) {
  return {
    owner: operation.owner,
    name: operation.name,
    number: operation.number,
    add: operation.add as ('factory:ready' | 'factory:hold')[],
    remove: operation.remove as ('factory:ready' | 'factory:hold')[],
    observedInputLabels: operation.observedInputLabels,
  };
}
