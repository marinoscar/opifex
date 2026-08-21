import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { EtagCacheService } from '../github/etag-cache.service';
import { GitHubAuthError, GitHubNotFoundError } from '../github/github.errors';
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
    budgetCeilingUsd: null,
    wallClockTimeoutMinutes: null,
    pathConstraints: [],
    lastObservedAt: null,
    createdAt: new Date('2026-08-01T10:00:00Z'),
    updatedAt: new Date('2026-08-01T10:00:00Z'),
    ...overrides,
  };
}

describe('RepositoriesService', () => {
  let prisma: {
    repository: Record<string, jest.Mock>;
    project: Record<string, jest.Mock>;
  };
  let github: { getRepository: jest.Mock };
  let etags: { invalidateRepository: jest.Mock };
  let service: RepositoriesService;

  beforeEach(() => {
    prisma = {
      repository: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      project: { findUnique: jest.fn() },
    };
    github = { getRepository: jest.fn().mockResolvedValue(REACHABLE) };
    etags = { invalidateRepository: jest.fn() };

    service = new RepositoriesService(
      prisma as unknown as PrismaService,
      github as unknown as GitHubReadService,
      etags as unknown as EtagCacheService,
    );
  });

  describe('register', () => {
    beforeEach(() => {
      prisma.repository.findUnique.mockResolvedValue(null);
      prisma.repository.create.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => repositoryRow(data),
      );
    });

    it('verifies the repository is reachable BEFORE storing it', async () => {
      // A registry entry Opifex cannot read turns every subsequent tick into a
      // 404, spending budget forever to rediscover a typo made once.
      await service.register({ owner: 'acme', name: 'app' });

      expect(github.getRepository).toHaveBeenCalledWith({ owner: 'acme', name: 'app' });
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

      await expect(service.register({ owner: 'acme', name: 'app' })).rejects.toBeInstanceOf(
        ConflictException,
      );
      // The reachability check costs a GitHub request; not spending it on a
      // duplicate is why the uniqueness check comes first.
      expect(github.getRepository).not.toHaveBeenCalled();
    });

    it('rejects an archived repository', async () => {
      // It accepts no writes at all, so a work order against it can never open
      // a pull request.
      github.getRepository.mockResolvedValue({ ...REACHABLE, archived: true });

      await expect(service.register({ owner: 'acme', name: 'app' })).rejects.toThrow(
        /archived/,
      );
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
        new GitHubAuthError('No GitHub credential configured', null, 'GET', '/x'),
      );

      await expect(service.register({ owner: 'acme', name: 'app' })).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
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
        async ({ data }: { data: Record<string, unknown> }) => repositoryRow(data),
      );
    });

    it('re-verifies reachability when dispatch is being turned ON', async () => {
      // This is the moment a repository stops being observed and starts being
      // written to. A token whose access was revoked since registration must
      // not have dispatch enabled against it.
      await service.update('11111111-1111-1111-1111-111111111111', { dispatchEnabled: true });

      expect(github.getRepository).toHaveBeenCalled();
    });

    it('does not re-verify when dispatch is being turned OFF', async () => {
      // Turning it off is always safe, and must work even when GitHub is
      // unreachable — that is precisely when an operator wants to stop.
      prisma.repository.findUnique.mockResolvedValue(repositoryRow({ dispatchEnabled: true }));

      await service.update('11111111-1111-1111-1111-111111111111', { dispatchEnabled: false });

      expect(github.getRepository).not.toHaveBeenCalled();
    });

    it('does not re-verify when dispatch was already on', async () => {
      prisma.repository.findUnique.mockResolvedValue(repositoryRow({ dispatchEnabled: true }));

      await service.update('11111111-1111-1111-1111-111111111111', { dispatchEnabled: true });

      expect(github.getRepository).not.toHaveBeenCalled();
    });

    it('leaves omitted fields alone instead of writing undefined over them', async () => {
      await service.update('11111111-1111-1111-1111-111111111111', { observeEnabled: false });

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
        service.update('11111111-1111-1111-1111-111111111111', { observeEnabled: false }),
      ).rejects.toBeInstanceOf(NotFoundException);
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

      const result = await service.findById('11111111-1111-1111-1111-111111111111');

      expect(result.budgetCeilingUsd).toBe('12.3456');
    });

    it('assembles fullName so no consumer has to', async () => {
      prisma.repository.findUnique.mockResolvedValue(repositoryRow());

      expect((await service.findById('11111111-1111-1111-1111-111111111111')).fullName).toBe(
        'acme/app',
      );
    });
  });
});
