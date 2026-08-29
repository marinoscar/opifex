import { Logger } from '@nestjs/common';

import {
  GitHubAuthError,
  GitHubNotFoundError,
  GitHubRateLimitError,
  GitHubTransientError,
} from '../github/github.errors';
import type { AccessibleRepository } from '../github/read/github-read.service';
import { GitHubReadService } from '../github/read/github-read.service';
import { PrismaService } from '../prisma/prisma.service';
import { AvailableRepositoriesService } from './available-repositories.service';
import type { ListAvailableRepositoriesQueryDto } from './dto/available-repository.dto';

/**
 * The repository picker's service half (#401).
 *
 * Two groups of case carry the issue's actual requirements:
 *
 * - **an unaddable repository is MARKED, never dropped** — a registered one
 *   and an archived one both stay in the list with a reason attached. These
 *   would pass vacuously against a fixture where everything is addable, so the
 *   fixtures deliberately contain both.
 * - **failure told apart** — no credential, a rejected credential, an
 *   unreachable GitHub and a token scoped to nothing are four findings with
 *   four remedies, and the last of them is NOT a failure at all.
 */

function accessible(
  overrides: Partial<AccessibleRepository> = {},
): AccessibleRepository {
  const owner = overrides.owner ?? 'acme';
  const name = overrides.name ?? 'app';
  return {
    owner,
    name,
    fullName: `${owner}/${name}`,
    description: 'The app',
    defaultBranch: 'main',
    private: true,
    archived: false,
    pushedAt: '2026-08-20T10:00:00Z',
    ...overrides,
  };
}

function query(
  overrides: Partial<ListAvailableRepositoriesQueryDto> = {},
): ListAvailableRepositoriesQueryDto {
  return {
    page: 1,
    pageSize: 25,
    ...overrides,
  } as ListAvailableRepositoriesQueryDto;
}

/** A picker whose clock does not move, so `checkedAt` is assertable. */
class FrozenPicker extends AvailableRepositoriesService {
  protected override now(): number {
    return Date.parse('2026-08-27T10:00:00.000Z');
  }
}

describe('AvailableRepositoriesService (#401)', () => {
  let prisma: { repository: { findMany: jest.Mock } };
  let github: {
    credentialConfigured: boolean;
    listAccessibleRepositories: jest.Mock;
  };
  let service: FrozenPicker;

  beforeEach(() => {
    prisma = { repository: { findMany: jest.fn().mockResolvedValue([]) } };
    github = {
      credentialConfigured: true,
      listAccessibleRepositories: jest.fn().mockResolvedValue({
        repositories: [],
        truncated: false,
        allFromCache: false,
      }),
    };
    service = new FrozenPicker(
      prisma as unknown as PrismaService,
      github as unknown as GitHubReadService,
    );
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  function reaches(...repositories: AccessibleRepository[]) {
    github.listAccessibleRepositories.mockResolvedValue({
      repositories,
      truncated: false,
      allFromCache: false,
    });
  }

  describe('the credential is fine and reaches nothing', () => {
    it('is a SUCCESS, not a failure — that is the token scope showing', async () => {
      // The distinction the issue turns on. Reporting an empty scope as an
      // error sends an operator to reissue a credential that works.
      const result = await service.list(query());

      expect(result.status).toBe('ok');
      expect(result.reachable).toBe(0);
      expect(result.repositories).toEqual([]);
      expect(result.detail).toMatch(/reaches no repositories/i);
      // The remedy has to be in the sentence, or an empty list is a dead end.
      expect(result.detail).toMatch(/fine-grained/i);
      expect(result.checkedAt).toBe('2026-08-27T10:00:00.000Z');
    });
  });

  describe('marking what cannot be added', () => {
    it('marks an already-registered repository and names the existing row', async () => {
      prisma.repository.findMany.mockResolvedValue([
        {
          id: '11111111-1111-4111-8111-111111111111',
          owner: 'acme',
          name: 'app',
        },
      ]);
      reaches(accessible());

      const { repositories } = await service.list(query());

      expect(repositories).toHaveLength(1);
      expect(repositories[0].admission).toBe('registered');
      expect(repositories[0].repositoryId).toBe(
        '11111111-1111-4111-8111-111111111111',
      );
    });

    it('matches a registration case-insensitively, IN BOTH DIRECTIONS', async () => {
      // GitHub preserves the case a repository was created with and treats
      // `Acme/App` and `acme/app` as one. A case-exact key would offer an
      // already-registered repository as addable and walk the operator into
      // the 409 this endpoint exists to prevent — and the case can differ on
      // either side, so both are fixtured. One repository of each here means
      // dropping the fold on either the stored key or the lookup fails this.
      prisma.repository.findMany.mockResolvedValue([
        {
          id: '22222222-2222-4222-8222-222222222222',
          owner: 'Acme',
          name: 'App',
        },
        {
          id: '77777777-7777-4777-8777-777777777777',
          owner: 'acme',
          name: 'web',
        },
      ]);
      reaches(
        accessible({ owner: 'acme', name: 'app' }),
        accessible({ owner: 'Acme', name: 'Web' }),
      );

      const { repositories } = await service.list(query());

      expect(
        repositories.map((r) => [r.fullName, r.admission, r.repositoryId]),
      ).toEqual([
        ['acme/app', 'registered', '22222222-2222-4222-8222-222222222222'],
        ['Acme/Web', 'registered', '77777777-7777-4777-8777-777777777777'],
      ]);
    });

    it('marks an archived repository and still LISTS it', async () => {
      reaches(accessible({ name: 'legacy', archived: true }));

      const { repositories } = await service.list(query());

      expect(repositories).toHaveLength(1);
      expect(repositories[0].admission).toBe('archived');
      expect(repositories[0].repositoryId).toBeNull();
    });

    it('calls an ordinary repository available', async () => {
      reaches(accessible());

      const { repositories } = await service.list(query());

      expect(repositories[0].admission).toBe('available');
    });

    it('prefers `registered` over `archived` when both apply', async () => {
      // Both make the row unaddable; only `registered` has somewhere to send
      // the operator.
      prisma.repository.findMany.mockResolvedValue([
        {
          id: '33333333-3333-4333-8333-333333333333',
          owner: 'acme',
          name: 'old',
        },
      ]);
      reaches(accessible({ name: 'old', archived: true }));

      const { repositories } = await service.list(query());

      expect(repositories[0].admission).toBe('registered');
      expect(repositories[0].repositoryId).toBe(
        '33333333-3333-4333-8333-333333333333',
      );
    });

    it('counts what is addable and what is not in the detail', async () => {
      prisma.repository.findMany.mockResolvedValue([
        {
          id: '44444444-4444-4444-8444-444444444444',
          owner: 'acme',
          name: 'app',
        },
      ]);
      reaches(
        accessible(),
        accessible({ name: 'fresh' }),
        accessible({ name: 'legacy', archived: true }),
      );

      const { detail, reachable } = await service.list(query());

      expect(reachable).toBe(3);
      expect(detail).toContain('1 can be registered');
      expect(detail).toContain('1 already registered');
      expect(detail).toContain('1 archived');
    });
  });

  describe('ordering', () => {
    it('puts the addable ones first and sinks the rest without dropping them', async () => {
      // The two unaddable rows are deliberately the ones EVERY OTHER key would
      // rank first: pushed most recently, and named so they sort first
      // alphabetically. Only the admission rank produces the expected order,
      // which is what keeps this from passing on a coincidence.
      prisma.repository.findMany.mockResolvedValue([
        {
          id: '55555555-5555-4555-8555-555555555555',
          owner: 'acme',
          name: 'aaa-known',
        },
      ]);
      reaches(
        accessible({
          name: 'aab-legacy',
          archived: true,
          pushedAt: '2026-08-26T00:00:00Z',
        }),
        accessible({ name: 'aaa-known', pushedAt: '2026-08-25T00:00:00Z' }),
        accessible({ name: 'zzz-fresh', pushedAt: '2020-01-01T00:00:00Z' }),
      );

      const { repositories } = await service.list(query());

      expect(repositories.map((r) => r.name)).toEqual([
        'zzz-fresh',
        'aaa-known',
        'aab-legacy',
      ]);
    });

    it('orders a group by most recent push, which is what a picker wants', async () => {
      reaches(
        accessible({ name: 'stale', pushedAt: '2020-01-01T00:00:00Z' }),
        accessible({ name: 'recent', pushedAt: '2026-08-26T00:00:00Z' }),
        accessible({ name: 'middling', pushedAt: '2026-01-01T00:00:00Z' }),
      );

      const { repositories } = await service.list(query());

      expect(repositories.map((r) => r.name)).toEqual([
        'recent',
        'middling',
        'stale',
      ]);
    });

    it('falls back to the name for undated rows, so the order is stable', async () => {
      reaches(
        accessible({ name: 'zeta', pushedAt: null }),
        accessible({ name: 'alpha', pushedAt: null }),
      );

      const { repositories } = await service.list(query());

      expect(repositories.map((r) => r.name)).toEqual(['alpha', 'zeta']);
    });
  });

  describe('pagination and search', () => {
    function many(count: number): AccessibleRepository[] {
      return Array.from({ length: count }, (_, index) =>
        accessible({
          name: `repo-${String(index).padStart(2, '0')}`,
          // Descending push order, so the sort keeps the index order.
          pushedAt: new Date(
            Date.UTC(2026, 0, 1) - index * 86400000,
          ).toISOString(),
        }),
      );
    }

    it('returns one page of a long list and counts the whole of it', async () => {
      reaches(...many(30));

      const result = await service.list(query({ page: 2, pageSize: 10 }));

      expect(result.repositories).toHaveLength(10);
      expect(result.repositories[0].name).toBe('repo-10');
      expect(result.total).toBe(30);
      expect(result.totalPages).toBe(3);
      expect(result.reachable).toBe(30);
    });

    it('reports a hit page cap rather than presenting a partial list as whole', async () => {
      github.listAccessibleRepositories.mockResolvedValue({
        repositories: many(5),
        truncated: true,
        allFromCache: false,
      });

      const result = await service.list(query());

      expect(result.truncated).toBe(true);
      expect(result.detail).toContain('the rest were not read');
    });

    it('says so plainly when nothing was truncated', async () => {
      reaches(...many(5));

      expect((await service.list(query())).truncated).toBe(false);
    });

    it('filters case-insensitively and echoes the search back', async () => {
      reaches(
        accessible({ name: 'billing-api' }),
        accessible({ name: 'web' }),
        accessible({ owner: 'other', name: 'BILLING-ui' }),
      );

      const result = await service.list(query({ search: 'billing' }));

      expect(result.repositories.map((r) => r.fullName).sort()).toEqual([
        'acme/billing-api',
        'other/BILLING-ui',
      ]);
      expect(result.total).toBe(2);
      expect(result.search).toBe('billing');
    });

    it('keeps `reachable` whole so an empty search is not an empty scope', async () => {
      // The two sentences an operator needs told apart: "your search matched
      // nothing" and "the token reaches nothing".
      reaches(accessible({ name: 'web' }), accessible({ name: 'api' }));

      const result = await service.list(query({ search: 'nothing-matches' }));

      expect(result.repositories).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.reachable).toBe(2);
      expect(result.status).toBe('ok');
      expect(result.detail).toContain('0 match "nothing-matches"');
    });

    it('never asks GitHub to search — that would reach outside the token', async () => {
      // GitHub's search API covers all of GitHub, so it would return public
      // repositories this token cannot touch.
      reaches(accessible());

      await service.list(query({ search: 'app' }));

      expect(github.listAccessibleRepositories).toHaveBeenCalledWith({
        maxPages: 10,
      });
    });
  });

  describe('failure, told apart', () => {
    it('reports no credential without asking GitHub anything', async () => {
      github.credentialConfigured = false;

      const result = await service.list(query());

      expect(result.status).toBe('no_credential');
      expect(github.listAccessibleRepositories).not.toHaveBeenCalled();
      expect(result.detail).toContain('github.token');
    });

    it('reports a rejected credential as such', async () => {
      github.listAccessibleRepositories.mockRejectedValue(
        new GitHubAuthError('Bad credentials', 401, 'GET', '/user/repos'),
      );

      const result = await service.list(query());

      expect(result.status).toBe('invalid_credential');
      expect(result.detail).toContain('Bad credentials');
    });

    it('separates a 403 from a bad credential — the remedy is the scope', async () => {
      github.listAccessibleRepositories.mockRejectedValue(
        new GitHubAuthError(
          'Resource not accessible',
          403,
          'GET',
          '/user/repos',
        ),
      );

      const result = await service.list(query());

      expect(result.status).toBe('refused');
      expect(result.detail).toMatch(/permitted/i);
    });

    it('reports an exhausted budget with the instant it returns', async () => {
      github.listAccessibleRepositories.mockRejectedValue(
        new GitHubRateLimitError(
          'Rate limit exhausted',
          403,
          'GET',
          '/user/repos',
          new Date('2026-08-27T11:00:00Z'),
          false,
        ),
      );

      const result = await service.list(query());

      expect(result.status).toBe('rate_limited');
      expect(result.detail).toContain('2026-08-27T11:00:00.000Z');
    });

    it('does not blame the credential when nothing answered', async () => {
      github.listAccessibleRepositories.mockRejectedValue(
        new GitHubTransientError('socket hang up', null, 'GET', '/user/repos'),
      );

      const result = await service.list(query());

      expect(result.status).toBe('unreachable');
      expect(result.detail).toContain('says nothing about the credential');
    });

    it('reports a token cleared mid-request as no credential, not a bad one', async () => {
      // `github.token` is resolved per request, so it can be cleared between
      // the check above and the call.
      github.listAccessibleRepositories.mockRejectedValue(
        new GitHubAuthError(
          'No GitHub credential configured (set GITHUB_TOKEN)',
          null,
          'GET',
          '/user/repos',
        ),
      );

      expect((await service.list(query())).status).toBe('no_credential');
    });

    it('falls back to `failed` for anything else, carrying GitHub’s words', async () => {
      github.listAccessibleRepositories.mockRejectedValue(
        new GitHubNotFoundError('Not Found', 404, 'GET', '/user/repos'),
      );

      const result = await service.list(query());

      expect(result.status).toBe('failed');
      expect(result.detail).toContain('Not Found');
    });

    it('answers every failure in ONE renderable shape', async () => {
      github.listAccessibleRepositories.mockRejectedValue(
        new GitHubTransientError('down', null, 'GET', '/user/repos'),
      );

      const result = await service.list(query({ page: 3, pageSize: 10 }));

      expect(result.repositories).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.totalPages).toBe(0);
      expect(result.reachable).toBe(0);
      expect(result.page).toBe(3);
      expect(result.pageSize).toBe(10);
      expect(result.checkedAt).toBe('2026-08-27T10:00:00.000Z');
    });

    it('gives the four causes four different statuses', async () => {
      // The acceptance criterion, asserted as one fact rather than inferred
      // from four passing cases above.
      const statuses = new Set<string>();

      github.credentialConfigured = false;
      statuses.add((await service.list(query())).status);

      github.credentialConfigured = true;
      github.listAccessibleRepositories.mockRejectedValue(
        new GitHubAuthError('Bad credentials', 401, 'GET', '/user/repos'),
      );
      statuses.add((await service.list(query())).status);

      github.listAccessibleRepositories.mockRejectedValue(
        new GitHubTransientError('socket hang up', null, 'GET', '/user/repos'),
      );
      statuses.add((await service.list(query())).status);

      reaches();
      statuses.add((await service.list(query())).status);

      expect(statuses.size).toBe(4);
    });
  });
});
