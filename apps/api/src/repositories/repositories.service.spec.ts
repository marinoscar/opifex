import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { EtagCacheService } from '../github/etag-cache.service';
import { GitHubAuthError, GitHubNotFoundError } from '../github/github.errors';
import {
  LabelProvisioningService,
  type LabelProvisioningReport,
} from '../github/labels/label-provisioning.service';
import { GitHubReadService } from '../github/read/github-read.service';
import { PrismaService } from '../prisma/prisma.service';
import { RepositoriesService } from './repositories.service';

const REACHABLE = {
  owner: 'acme',
  name: 'app',
  defaultBranch: 'trunk',
  private: false,
  archived: false,
};

/**
 * A clean label-provisioning report.
 *
 * Registration now provisions the factory taxonomy (#415), and these suites
 * are about the REGISTRY. `label-provisioning.service.spec.ts` owns what
 * provisioning does; what matters here is only that registration reports it
 * and that a failure cannot cost a registration.
 */
function labelReport(
  overrides: Partial<LabelProvisioningReport> = {},
): LabelProvisioningReport {
  return {
    repository: 'acme/app',
    ok: true,
    status: 'ok',
    applied: true,
    detail: 'All 15 factory labels are present on acme/app.',
    checkedAt: '2026-08-01T10:00:00.000Z',
    declared: 15,
    present: 15,
    missing: 0,
    created: 15,
    updated: 0,
    unchanged: 0,
    failed: 0,
    labels: [],
    ...overrides,
  };
}

function repositoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    projectId: null,
    owner: 'acme',
    name: 'app',
    defaultBranch: 'main',
    observeEnabled: true,
    dispatchEnabled: false,
    mirrorLabelsEnabled: false,
    specFeedbackEnabled: false,
    budgetCeilingUsd: null,
    wallClockTimeoutMinutes: null,
    pathConstraints: [],
    lastObservedAt: null,
    retiredAt: null,
    retiredById: null,
    createdAt: new Date('2026-08-01T10:00:00Z'),
    updatedAt: new Date('2026-08-01T10:00:00Z'),
    ...overrides,
  };
}

const ACTOR = '3f6d9e5a-2b1c-4a7e-9c8d-5e4f3a2b1c0d';
const REPO_ID = '11111111-1111-1111-1111-111111111111';

type Delegates = Record<string, Record<string, jest.Mock>>;

/**
 * The delegates a Prisma double offers.
 *
 * `workOrder`, `run`, `runEvent` and `dispatchAttempt` are here despite the
 * service never naming them: #405 requires that retiring reaches no run, work
 * order or provenance record, and a delegate that does not exist on the double
 * would fail with a TypeError that reads like a broken test rather than the
 * assertion failing for the reason it was written.
 */
function delegates(): Delegates {
  const model = () => ({
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    createMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  });

  return {
    repository: model(),
    project: model(),
    auditEvent: model(),
    workOrder: model(),
    run: model(),
    runEvent: model(),
    dispatchAttempt: model(),
  };
}

describe('RepositoriesService', () => {
  let prisma: Delegates & { $transaction: jest.Mock };
  /**
   * The client handed to a `$transaction` callback. A SEPARATE object from
   * `prisma` on purpose: it is the only way a unit test can tell a write that
   * happened inside the transaction from one that happened beside it, and
   * "inside" is the whole atomicity claim of #405.
   */
  let tx: Delegates;
  /**
   * Which MODEL delegates the code under test actually reached for, by name.
   * `$`-prefixed client methods are excluded — `$transaction` is machinery,
   * not a table.
   */
  let touched: Set<string>;
  let github: { getRepository: jest.Mock };
  let etags: { invalidateRepository: jest.Mock };
  let labels: { provision: jest.Mock; inspect: jest.Mock };
  let service: RepositoriesService;

  beforeEach(() => {
    touched = new Set<string>();
    const record = (target: Delegates) =>
      new Proxy(target, {
        get(inner, key: string) {
          if (key in inner && !key.startsWith('$')) touched.add(key);
          return inner[key];
        },
      });

    const txDelegates = delegates();
    tx = record(txDelegates);

    const outer = delegates();
    prisma = Object.assign(record(outer) as Delegates, {
      $transaction: jest.fn(
        async (fn: (client: Delegates) => Promise<unknown>) => fn(tx),
      ),
    });

    github = { getRepository: jest.fn().mockResolvedValue(REACHABLE) };
    etags = { invalidateRepository: jest.fn() };
    labels = {
      provision: jest.fn().mockResolvedValue(labelReport()),
      inspect: jest.fn().mockResolvedValue(labelReport()),
    };

    service = new RepositoriesService(
      prisma as unknown as PrismaService,
      github as unknown as GitHubReadService,
      etags as unknown as EtagCacheService,
      labels as unknown as LabelProvisioningService,
    );
  });

  /** The `data` of the nth call to a mocked Prisma write. */
  function dataOf(mock: jest.Mock, call = 0): Record<string, unknown> {
    const [args] = mock.mock.calls[call] as [{ data: Record<string, unknown> }];
    return args.data;
  }

  describe('register', () => {
    beforeEach(() => {
      prisma.repository.findUnique.mockResolvedValue(null);
      prisma.repository.create.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) =>
          repositoryRow(data),
      );
    });

    it('verifies the repository is reachable BEFORE storing it', async () => {
      // A registry entry Opifex cannot read turns every subsequent tick into a
      // 404, spending budget forever to rediscover a typo made once.
      await service.register({ owner: 'acme', name: 'app' });

      expect(github.getRepository).toHaveBeenCalledWith({
        owner: 'acme',
        name: 'app',
      });
      expect(prisma.repository.create).toHaveBeenCalled();
    });

    it('takes the default branch from GitHub rather than guessing main', async () => {
      // A work order pins a base commit on this branch. Guessing it wrong
      // produces a run that fails at checkout for a reason nothing in the diff
      // explains.
      const result = await service.register({ owner: 'acme', name: 'app' });

      expect(result.defaultBranch).toBe('trunk');
    });

    it('defaults dispatch OFF', async () => {
      // A newly registered repository is observed, never run, until a human
      // says otherwise.
      const result = await service.register({ owner: 'acme', name: 'app' });

      expect(result.observeEnabled).toBe(true);
      expect(result.dispatchEnabled).toBe(false);
    });

    it('defaults mirror labels OFF as well', async () => {
      // A newly registered repository is observed and written to by nothing.
      // VISION §12's week ends in stages, so this is a separate flip from
      // dispatch.
      const result = await service.register({ owner: 'acme', name: 'app' });

      expect(result.mirrorLabelsEnabled).toBe(false);
    });

    it('defaults spec feedback OFF too', async () => {
      // Its own flag, and its own flip. An operator who asked for status
      // labels did not thereby ask Opifex to start writing prose to humans on
      // their own issues (#155).
      const result = await service.register({ owner: 'acme', name: 'app' });

      expect(result.specFeedbackEnabled).toBe(false);
    });

    it('honours an explicit spec-feedback choice', async () => {
      const result = await service.register({
        owner: 'acme',
        name: 'app',
        specFeedbackEnabled: true,
      });

      expect(result.specFeedbackEnabled).toBe(true);
    });

    it('honours an explicit dispatch choice', async () => {
      const result = await service.register({
        owner: 'acme',
        name: 'app',
        dispatchEnabled: true,
      });

      expect(result.dispatchEnabled).toBe(true);
    });

    it('rejects a repository that is already registered', async () => {
      prisma.repository.findUnique.mockResolvedValue(repositoryRow());

      await expect(
        service.register({ owner: 'acme', name: 'app' }),
      ).rejects.toBeInstanceOf(ConflictException);
      // The reachability check costs a GitHub request; not spending it on a
      // duplicate is why the uniqueness check comes first.
      expect(github.getRepository).not.toHaveBeenCalled();
    });

    it('rejects an archived repository', async () => {
      // It accepts no writes at all, so a work order against it can never open
      // a pull request.
      github.getRepository.mockResolvedValue({ ...REACHABLE, archived: true });

      await expect(
        service.register({ owner: 'acme', name: 'app' }),
      ).rejects.toThrow(/archived/);
      expect(prisma.repository.create).not.toHaveBeenCalled();
    });

    it('names BOTH causes of a 404 in the error', async () => {
      // GitHub answers 404 for a repository that does not exist and for a
      // private one the token cannot see. Reporting only "not found" sends
      // someone hunting for a typo in a name that is perfectly correct.
      github.getRepository.mockRejectedValue(
        new GitHubNotFoundError('Not Found', 404, 'GET', '/repos/acme/app'),
      );

      const error = await service
        .register({ owner: 'acme', name: 'app' })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as Error).message).toMatch(/does not exist/);
      expect((error as Error).message).toMatch(/cannot see it/);
    });

    it('reports a missing or expired credential as 503, not as a bad request', async () => {
      // The caller's input was fine; the deployment is not configured. A 400
      // would send them editing a repository name that is correct.
      github.getRepository.mockRejectedValue(
        new GitHubAuthError(
          'No GitHub credential configured',
          null,
          'GET',
          '/x',
        ),
      );

      await expect(
        service.register({ owner: 'acme', name: 'app' }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('rejects an unknown project rather than orphaning the reference', async () => {
      prisma.project.findUnique.mockResolvedValue(null);

      await expect(
        service.register({
          owner: 'acme',
          name: 'app',
          projectId: '22222222-2222-2222-2222-222222222222',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update', () => {
    beforeEach(() => {
      prisma.repository.findUnique.mockResolvedValue(repositoryRow());
      prisma.repository.update.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) =>
          repositoryRow(data),
      );
    });

    it('re-verifies reachability when dispatch is being turned ON', async () => {
      // This is the moment a repository stops being observed and starts being
      // written to. A token whose access was revoked since registration must
      // not have dispatch enabled against it.
      await service.update('11111111-1111-1111-1111-111111111111', {
        dispatchEnabled: true,
      });

      expect(github.getRepository).toHaveBeenCalled();
    });

    it('does not re-verify when dispatch is being turned OFF', async () => {
      // Turning it off is always safe, and must work even when GitHub is
      // unreachable — that is precisely when an operator wants to stop.
      prisma.repository.findUnique.mockResolvedValue(
        repositoryRow({ dispatchEnabled: true }),
      );

      await service.update('11111111-1111-1111-1111-111111111111', {
        dispatchEnabled: false,
      });

      expect(github.getRepository).not.toHaveBeenCalled();
    });

    it('does not re-verify when dispatch was already on', async () => {
      prisma.repository.findUnique.mockResolvedValue(
        repositoryRow({ dispatchEnabled: true }),
      );

      await service.update('11111111-1111-1111-1111-111111111111', {
        dispatchEnabled: true,
      });

      expect(github.getRepository).not.toHaveBeenCalled();
    });

    it('leaves omitted fields alone instead of writing undefined over them', async () => {
      await service.update('11111111-1111-1111-1111-111111111111', {
        observeEnabled: false,
      });

      const [{ data }] = prisma.repository.update.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(data).toEqual({ observeEnabled: false });
    });

    it('allows an explicit null to clear a ceiling', async () => {
      // `null` and "omitted" are different intents and the spread has to keep
      // them apart — the whole reason the fields are `.nullable().optional()`.
      await service.update('11111111-1111-1111-1111-111111111111', {
        budgetCeilingUsd: null,
      });

      const [{ data }] = prisma.repository.update.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(data).toEqual({ budgetCeilingUsd: null });
    });

    it('404s on an unknown repository', async () => {
      prisma.repository.findUnique.mockResolvedValue(null);

      await expect(
        service.update('11111111-1111-1111-1111-111111111111', {
          observeEnabled: false,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  /**
   * Retire (#405, epic #403).
   *
   * The decision these tests encode: "retired" is an EXPLICIT stored fact
   * (`retiredAt`), not "all four ladder flags are off". All four off is
   * reachable by four independent PATCHes, or by one registration passing
   * `observeEnabled: false`, so the derived reading cannot distinguish a
   * deliberate stand-down from an operator who muted observation for an
   * afternoon. See the `Repository` model in schema.prisma for the argument in
   * full.
   */
  describe('retire', () => {
    /** A retired row. Every rung off, `retiredAt` set — the invariant. */
    function retiredRow(overrides: Record<string, unknown> = {}) {
      return repositoryRow({
        observeEnabled: false,
        mirrorLabelsEnabled: false,
        specFeedbackEnabled: false,
        dispatchEnabled: false,
        retiredAt: new Date('2026-08-20T09:00:00Z'),
        retiredById: ACTOR,
        ...overrides,
      });
    }

    beforeEach(() => {
      tx.repository.findUnique.mockResolvedValue(
        repositoryRow({
          observeEnabled: true,
          mirrorLabelsEnabled: true,
          specFeedbackEnabled: false,
          dispatchEnabled: true,
        }),
      );
      tx.repository.update.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) =>
          repositoryRow(data),
      );
    });

    it('turns every rung of the ladder off in ONE write', async () => {
      // Not four. An operator who retires a repository and loses their
      // connection halfway must not leave it observed-but-still-dispatching,
      // and four client-side PATCHes make exactly that reachable.
      const result = await service.retire(REPO_ID, {}, ACTOR);

      expect(tx.repository.update).toHaveBeenCalledTimes(1);
      expect(dataOf(tx.repository.update)).toMatchObject({
        observeEnabled: false,
        mirrorLabelsEnabled: false,
        specFeedbackEnabled: false,
        dispatchEnabled: false,
      });
      expect(result.observeEnabled).toBe(false);
      expect(result.dispatchEnabled).toBe(false);
    });

    it('stores the retirement as a fact rather than leaving it to be inferred', async () => {
      // The explicit-over-derived decision, asserted. Without these two
      // columns nothing distinguishes this row from one whose observation was
      // switched off for an afternoon.
      const result = await service.retire(REPO_ID, {}, ACTOR);
      const data = dataOf(tx.repository.update);

      expect(data.retiredAt).toBeInstanceOf(Date);
      expect(data.retiredById).toBe(ACTOR);
      expect(result.retiredAt).toEqual(expect.any(String));
      expect(result.retiredById).toBe(ACTOR);
    });

    it('writes the ladder change and the audit row in the SAME transaction', async () => {
      // Atomicity is the requirement, and this is the only way a unit test can
      // see it: both writes go through the client `$transaction` handed the
      // callback, and neither goes through the connection beside it. A retired
      // repository with no record of who retired it is then not reachable.
      await service.retire(REPO_ID, {}, ACTOR);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.repository.update).toHaveBeenCalledTimes(1);
      expect(tx.auditEvent.create).toHaveBeenCalledTimes(1);
      expect(prisma.repository.update).not.toHaveBeenCalled();
      expect(prisma.auditEvent.create).not.toHaveBeenCalled();
    });

    it('fails the whole act when the audit row cannot be written', async () => {
      // The rollback itself is Postgres's; what is asserted here is that the
      // caller is told, rather than being handed a retired repository whose
      // record of the decision silently did not land. This is deliberately
      // the opposite of the operator-settings write path, which swallows the
      // same failure — there the change is already in force and this one is
      // not, so the safe direction to fail is closed.
      tx.auditEvent.create.mockRejectedValue(new Error('audit table is full'));

      await expect(service.retire(REPO_ID, {}, ACTOR)).rejects.toThrow(
        'audit table is full',
      );
    });

    it('records who, what, and the rungs it was standing on', async () => {
      await service.retire(
        REPO_ID,
        { reason: 'superseded by acme/app2' },
        ACTOR,
      );

      const data = dataOf(tx.auditEvent.create);
      expect(data).toMatchObject({
        actorUserId: ACTOR,
        action: 'repository.retired',
        targetType: 'repository',
        targetId: REPO_ID,
      });
      expect(data.meta).toMatchObject({
        repository: 'acme/app',
        reason: 'superseded by acme/app2',
        // Un-retire deliberately does not restore these, so this row is the
        // only place the previous ladder position survives.
        ladderBefore: {
          observeEnabled: true,
          mirrorLabelsEnabled: true,
          specFeedbackEnabled: false,
          dispatchEnabled: true,
        },
      });
    });

    it('reaches no work order, run or provenance record', async () => {
      // #405's last acceptance criterion, and the reason retire exists at all:
      // `DELETE` is refused on a used repository because cascading its runs
      // away would put a hole in VISION §5's graph. Retiring must not do
      // quietly what delete is refused for doing loudly.
      await service.retire(REPO_ID, {}, ACTOR);

      // Nothing but the row itself and the audit trail was even reached for.
      expect([...touched].sort()).toEqual(['auditEvent', 'repository']);
      for (const model of ['workOrder', 'run', 'runEvent', 'dispatchAttempt']) {
        for (const method of Object.values(tx[model])) {
          expect(method).not.toHaveBeenCalled();
        }
      }
      expect(tx.repository.delete).not.toHaveBeenCalled();
      expect(tx.repository.deleteMany).not.toHaveBeenCalled();
    });

    it('is idempotent, and a retry is not a second decision', async () => {
      // The dropped-connection case the one-act requirement is about: the
      // operator retries, and the second call must neither rewrite the row nor
      // make one act look like two in the audit log.
      tx.repository.findUnique.mockResolvedValue(retiredRow());

      const result = await service.retire(REPO_ID, {}, ACTOR);

      expect(tx.repository.update).not.toHaveBeenCalled();
      expect(tx.auditEvent.create).not.toHaveBeenCalled();
      expect(result.retiredAt).toBe('2026-08-20T09:00:00.000Z');
    });

    it('makes no GitHub call', async () => {
      // Retiring enables nothing, so there is nothing to re-verify — and a
      // network round trip inside a transaction would hold a connection open
      // for the length of GitHub's latency.
      await service.retire(REPO_ID, {}, ACTOR);

      expect(github.getRepository).not.toHaveBeenCalled();
    });

    it('404s on an unknown repository', async () => {
      tx.repository.findUnique.mockResolvedValue(null);

      await expect(service.retire(REPO_ID, {}, ACTOR)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('leaves a retired repository listed', async () => {
      // Hiding it would leave an operator unable to find the thing they just
      // retired in order to un-retire it. Omitting the filter means BOTH.
      prisma.repository.findMany.mockResolvedValue([retiredRow()]);
      prisma.repository.count.mockResolvedValue(1);

      const result = await service.list({ page: 1, pageSize: 25 });

      const [args] = prisma.repository.findMany.mock.calls[0] as [
        { where: Record<string, unknown> },
      ];
      expect(args.where).not.toHaveProperty('retiredAt');
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.retiredAt).toBe('2026-08-20T09:00:00.000Z');
    });

    it('can be filtered for, and filtered out', async () => {
      prisma.repository.findMany.mockResolvedValue([]);
      prisma.repository.count.mockResolvedValue(0);

      await service.list({ page: 1, pageSize: 25, retired: true });
      await service.list({ page: 1, pageSize: 25, retired: false });

      const wheres = prisma.repository.findMany.mock.calls.map(
        ([args]) => (args as { where: Record<string, unknown> }).where,
      );
      expect(wheres[0]).toMatchObject({ retiredAt: { not: null } });
      expect(wheres[1]).toMatchObject({ retiredAt: null });
    });
  });

  describe('unretire', () => {
    beforeEach(() => {
      tx.repository.findUnique.mockResolvedValue(
        repositoryRow({
          observeEnabled: false,
          mirrorLabelsEnabled: false,
          specFeedbackEnabled: false,
          dispatchEnabled: false,
          retiredAt: new Date('2026-08-20T09:00:00Z'),
          retiredById: ACTOR,
        }),
      );
      tx.repository.update.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) =>
          repositoryRow(data),
      );
    });

    it('returns the repository to the BOTTOM of the ladder', async () => {
      // Observation on, every outward write off — the position `register`
      // leaves a new repository in, and what VISION §12's staged rollout means
      // by the first rung. The bottom is observation, not nothing: "nothing"
      // is the state being undone.
      const result = await service.unretire(REPO_ID, {}, ACTOR);

      expect(result.observeEnabled).toBe(true);
      expect(result.mirrorLabelsEnabled).toBe(false);
      expect(result.specFeedbackEnabled).toBe(false);
      expect(result.dispatchEnabled).toBe(false);
    });

    it('writes every write-flag off explicitly rather than leaving it alone', async () => {
      // The sharp end of "not restored to whatever rungs it previously held".
      // An implementation that only set `observeEnabled` and cleared
      // `retiredAt` would pass the test above and fail this one — and would
      // re-enable dispatch by surprise the day the ladder is restored from
      // anywhere but a freshly-zeroed row.
      await service.unretire(REPO_ID, {}, ACTOR);

      expect(dataOf(tx.repository.update)).toEqual({
        observeEnabled: true,
        mirrorLabelsEnabled: false,
        specFeedbackEnabled: false,
        dispatchEnabled: false,
        retiredAt: null,
        retiredById: null,
      });
    });

    it('clears the actor with the timestamp', async () => {
      // Who retired it is history and lives in `audit_events`. An actor beside
      // a null timestamp would be a state with no meaning.
      const result = await service.unretire(REPO_ID, {}, ACTOR);

      expect(result.retiredAt).toBeNull();
      expect(result.retiredById).toBeNull();
    });

    it('records the act, and what it restored the repository to', async () => {
      await service.unretire(REPO_ID, { reason: 'back in service' }, ACTOR);

      const data = dataOf(tx.auditEvent.create);
      expect(data).toMatchObject({
        actorUserId: ACTOR,
        action: 'repository.unretired',
        targetType: 'repository',
        targetId: REPO_ID,
      });
      expect(data.meta).toMatchObject({
        repository: 'acme/app',
        reason: 'back in service',
        retiredAt: '2026-08-20T09:00:00.000Z',
        restoredTo: 'observe',
      });
    });

    it('writes the change and the audit row in the SAME transaction', async () => {
      await service.unretire(REPO_ID, {}, ACTOR);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.auditEvent.create).toHaveBeenCalledTimes(1);
      expect(prisma.repository.update).not.toHaveBeenCalled();
      expect(prisma.auditEvent.create).not.toHaveBeenCalled();
    });

    it('does not reset the ladder of a repository nobody retired', async () => {
      // Idempotent, and this is the consequence that matters: a stray call
      // must not switch dispatch off on a live repository.
      tx.repository.findUnique.mockResolvedValue(
        repositoryRow({ dispatchEnabled: true, retiredAt: null }),
      );

      const result = await service.unretire(REPO_ID, {}, ACTOR);

      expect(tx.repository.update).not.toHaveBeenCalled();
      expect(tx.auditEvent.create).not.toHaveBeenCalled();
      expect(result.dispatchEnabled).toBe(true);
    });

    it('makes no GitHub call', async () => {
      // It enables observation and nothing else. Dispatch is re-verified when
      // somebody asks for it back, by the PATCH that always did.
      await service.unretire(REPO_ID, {}, ACTOR);

      expect(github.getRepository).not.toHaveBeenCalled();
    });

    it('404s on an unknown repository', async () => {
      tx.repository.findUnique.mockResolvedValue(null);

      await expect(service.unretire(REPO_ID, {}, ACTOR)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('update, on a retired repository', () => {
    beforeEach(() => {
      prisma.repository.findUnique.mockResolvedValue(
        repositoryRow({
          observeEnabled: false,
          retiredAt: new Date('2026-08-20T09:00:00Z'),
          retiredById: ACTOR,
        }),
      );
      prisma.repository.update.mockResolvedValue(repositoryRow());
    });

    it('refuses to put a rung back on, and names the way to do it', async () => {
      // Otherwise `retiredAt` could sit on a repository that is being
      // dispatched to — a row saying two contradictory things, and the
      // invariant every reader of `retiredAt` depends on.
      const error = await service
        .update(REPO_ID, { dispatchEnabled: true })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as Error).message).toMatch(/dispatchEnabled/);
      expect((error as Error).message).toMatch(/unretire/);
      expect(prisma.repository.update).not.toHaveBeenCalled();
    });

    it('names every rung the caller tried to enable', async () => {
      const error = await service
        .update(REPO_ID, { observeEnabled: true, mirrorLabelsEnabled: true })
        .catch((e: unknown) => e);

      expect((error as Error).message).toMatch(/observeEnabled/);
      expect((error as Error).message).toMatch(/mirrorLabelsEnabled/);
    });

    it('refuses BEFORE spending a GitHub request to verify reachability', async () => {
      await service
        .update(REPO_ID, { dispatchEnabled: true })
        .catch(() => undefined);

      expect(github.getRepository).not.toHaveBeenCalled();
    });

    it('still allows everything that is not a rung', async () => {
      // A retired repository's budget, timeout, path constraints and project
      // change what a future run would be allowed to do, not whether one can
      // happen. Refusing those would make retirement a lock rather than a
      // stand-down.
      await service.update(REPO_ID, {
        budgetCeilingUsd: 5,
        pathConstraints: ['src/**'],
      });

      expect(prisma.repository.update).toHaveBeenCalledTimes(1);
    });

    it('still allows a rung to be turned off', async () => {
      await service.update(REPO_ID, { dispatchEnabled: false });

      expect(prisma.repository.update).toHaveBeenCalledTimes(1);
    });
  });

  describe('remove', () => {
    it('refuses while the repository has work orders', async () => {
      // Deleting would cascade runs and their provenance away, and VISION §5's
      // premise is that the chain survives. Holes are not detectable after
      // the fact.
      prisma.repository.findUnique.mockResolvedValue({
        ...repositoryRow(),
        _count: { workOrders: 3 },
      });

      const error = await service
        .remove('11111111-1111-1111-1111-111111111111')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as Error).message).toMatch(/observeEnabled/);
      expect(prisma.repository.delete).not.toHaveBeenCalled();
    });

    it('deletes a repository with no work orders', async () => {
      prisma.repository.findUnique.mockResolvedValue({
        ...repositoryRow(),
        _count: { workOrders: 0 },
      });

      await service.remove('11111111-1111-1111-1111-111111111111');

      expect(prisma.repository.delete).toHaveBeenCalled();
    });

    it('invalidates cached GitHub responses for it', async () => {
      // A cached 200 read under a token that could see this repository must
      // not be replayed if it is re-registered under a different one.
      prisma.repository.findUnique.mockResolvedValue({
        ...repositoryRow(),
        _count: { workOrders: 0 },
      });

      await service.remove('11111111-1111-1111-1111-111111111111');

      expect(etags.invalidateRepository).toHaveBeenCalledWith('acme', 'app');
    });
  });

  describe('list, and the unassigned bucket (#404)', () => {
    beforeEach(() => {
      prisma.repository.findMany.mockResolvedValue([]);
      prisma.repository.count.mockResolvedValue(0);
    });

    function whereOf(): Record<string, unknown> {
      return (
        prisma.repository.findMany.mock.calls[0][0] as {
          where: Record<string, unknown>;
        }
      ).where;
    }

    it('applies no project filter when none is asked for', async () => {
      await service.list({ page: 1, pageSize: 25 } as never);
      expect(whereOf()).not.toHaveProperty('projectId');
    });

    it('filters to one project by id', async () => {
      const projectId = '33333333-3333-3333-3333-333333333333';
      await service.list({ page: 1, pageSize: 25, projectId } as never);
      expect(whereOf()).toMatchObject({ projectId });
    });

    it('translates `none` into a NULL project, not into no filter at all', async () => {
      // The whole point of #404's unassigned bucket: every repository
      // registered before projects existed is in it, so if `none` fell through
      // to "any project" the one group an operator most needs to find would
      // silently return everything instead.
      await service.list({ page: 1, pageSize: 25, projectId: 'none' } as never);
      expect(whereOf()).toMatchObject({ projectId: null });
    });

    it('still lists an unassigned repository under no filter', async () => {
      // `projectId: null` is a state, not an omission — an unassigned
      // repository is a full member of the registry.
      prisma.repository.findMany.mockResolvedValue([
        repositoryRow({ projectId: null }),
      ]);
      prisma.repository.count.mockResolvedValue(1);

      const result = await service.list({ page: 1, pageSize: 25 } as never);

      expect(result.total).toBe(1);
      expect(result.items[0].projectId).toBeNull();
    });

    it('enables an unassigned repository without ever consulting a project', async () => {
      // The enablement ladder does not read `projectId`, and #404 must not
      // make it start: a repository in no project is still dispatchable.
      const row = repositoryRow({ projectId: null, dispatchEnabled: false });
      prisma.repository.findUnique.mockResolvedValue(row);
      prisma.repository.update.mockResolvedValue({
        ...row,
        dispatchEnabled: true,
      });

      const updated = await service.update(row.id, { dispatchEnabled: true });

      expect(updated.dispatchEnabled).toBe(true);
      expect(updated.projectId).toBeNull();
      expect(prisma.project.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('listObserved', () => {
    it('returns observed repositories, longest-waiting first', async () => {
      // A tick that runs out of rate-limit budget has still made progress on
      // the repositories that have waited longest, rather than re-reading the
      // same few every time.
      prisma.repository.findMany.mockResolvedValue([]);

      await service.listObserved();

      expect(prisma.repository.findMany).toHaveBeenCalledWith({
        where: { observeEnabled: true },
        orderBy: [{ lastObservedAt: { sort: 'asc', nulls: 'first' } }],
      });
    });
  });

  describe('response shape', () => {
    it('stringifies the decimal budget rather than rounding it through a number', async () => {
      prisma.repository.findUnique.mockResolvedValue(
        repositoryRow({ budgetCeilingUsd: { toString: () => '12.3456' } }),
      );

      const result = await service.findById(
        '11111111-1111-1111-1111-111111111111',
      );

      expect(result.budgetCeilingUsd).toBe('12.3456');
    });

    it('assembles fullName so no consumer has to', async () => {
      prisma.repository.findUnique.mockResolvedValue(repositoryRow());

      expect(
        (await service.findById('11111111-1111-1111-1111-111111111111'))
          .fullName,
      ).toBe('acme/app');
    });
  });
});
