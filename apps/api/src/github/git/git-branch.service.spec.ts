import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GitHubHttpService } from '../github-http.service';
import { GitHubNotFoundError } from '../github.errors';
import { GitHubWriteService } from '../write/github-write.service';
import { WriteAction } from '../write/reversibility';
import { assertFactoryBranch, GitBranchService } from './git-branch.service';

const SOURCE = readFileSync(join(__dirname, 'git-branch.service.ts'), 'utf8');

const REPO = { owner: 'marinoscar', name: 'opifex' };
const BASE = 'a3f91c2000000000000000000000000000000000';

function input(overrides: Record<string, unknown> = {}) {
  return {
    repo: REPO,
    branch: 'factory/312-a3f91c2-a1',
    baseCommit: BASE,
    path: '.opifex/work-order.json',
    content: '{}\n',
    commitMessage: 'chore(factory): authorize wo_opifex_312_a3f91c2_a1',
    ...overrides,
  } as Parameters<GitBranchService['createFactoryBranch']>[0];
}

describe('GitBranchService', () => {
  let http: { request: jest.Mock };
  let writes: GitHubWriteService;
  let service: GitBranchService;

  /** Responses for the happy path, in the order the service asks for them. */
  function mockCreation(options: { refExists?: string | null } = {}) {
    http.request.mockImplementation(
      async (path: string, opts?: { method?: string }) => {
        if (path.includes('/git/ref/heads/')) {
          if (options.refExists)
            return { data: { object: { sha: options.refExists } } };
          throw new GitHubNotFoundError('Not Found', 404, 'GET', String(path));
        }
        if (path.endsWith('/git/commits/' + BASE))
          return { data: { tree: { sha: 'tree-base' } } };
        if (path.endsWith('/git/blobs')) return { data: { sha: 'blob-1' } };
        if (path.endsWith('/git/trees')) return { data: { sha: 'tree-1' } };
        if (path.endsWith('/git/commits')) return { data: { sha: 'commit-1' } };
        if (path.endsWith('/git/refs') && opts?.method === 'POST')
          return { data: {} };
        throw new Error(`Unexpected request: ${opts?.method ?? 'GET'} ${path}`);
      },
    );
  }

  function build(writesEnabled = true) {
    writes = {
      enabled: writesEnabled,
      guardedWrite: jest.fn(async (action, description, execute) => {
        if (!writesEnabled) {
          return {
            action,
            performed: false,
            noop: false,
            url: null,
            description,
          } as never;
        }
        const { url, noop } = await execute();
        return { action, performed: true, noop, url, description } as never;
      }),
    } as unknown as GitHubWriteService;

    service = new GitBranchService(
      http as unknown as GitHubHttpService,
      writes,
    );
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  }

  beforeEach(() => {
    http = { request: jest.fn() };
    mockCreation();
    build();
  });

  describe('it can only create factory branches', () => {
    it.each(['main', 'master', 'develop', 'refs/heads/main', 'release/1.0'])(
      'refuses %s before any request is made',
      async (branch) => {
        // The whole justification for this service existing. A caller passing
        // `main` must fail here rather than at GitHub, where the answer would
        // depend on whether branch protection happened to be configured.
        await expect(
          service.createFactoryBranch(input({ branch })),
        ).rejects.toThrow(/may only create branches under factory\//);
        expect(http.request).not.toHaveBeenCalled();
      },
    );

    it('refuses a traversal', async () => {
      await expect(
        service.createFactoryBranch(input({ branch: 'factory/../../main' })),
      ).rejects.toThrow(/not a valid branch name/);
    });

    it('guards the read path too', () => {
      expect(() => assertFactoryBranch('main')).toThrow();
      expect(() => assertFactoryBranch('factory/312-a3f91c2-a1')).not.toThrow();
    });
  });

  describe('what it will never do', () => {
    it('issues no PATCH — a ref update is a force-push in disguise', () => {
      expect(SOURCE).not.toContain("method: 'PATCH'");
    });

    it.each(['force', 'DELETE', 'PUT'])('never mentions %s', (forbidden) => {
      expect(SOURCE).not.toContain(`method: '${forbidden}'`);
      if (forbidden === 'force') expect(SOURCE).not.toMatch(/\bforce:\s*true/);
    });

    it('spells refs/heads/ itself rather than taking it from a caller', () => {
      // A caller that could choose the namespace could write refs/tags/, or
      // reach outside heads entirely.
      expect(SOURCE).toContain('ref: `refs/heads/${input.branch}`');
    });

    it('touches no path outside git object and ref creation', () => {
      // Comments stripped: the file legitimately QUOTES the forbidden paths
      // while explaining why it exists, and a scan that could not tell code
      // from prose would force the explanation out of the file.
      const code = SOURCE.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(
        /\/\/.*$/gm,
        '',
      );

      for (const forbidden of [
        '/actions/',
        '/merge',
        '/secrets',
        '/branches/',
      ]) {
        expect(code).not.toContain(forbidden);
      }
    });

    it('exposes only creation and lookup', () => {
      const methods = Object.getOwnPropertyNames(
        GitBranchService.prototype,
      ).filter(
        (name) => name !== 'constructor' && !name.startsWith('commitAndPoint'),
      );

      expect(methods.sort()).toEqual(['createFactoryBranch', 'findRef']);
    });
  });

  describe('creating the branch', () => {
    it('builds on the base commit tree, so the branch is not just the record', async () => {
      await service.createFactoryBranch(input());

      const [, treeCall] = http.request.mock.calls.find(([path]) =>
        String(path).endsWith('/git/trees'),
      )!;
      expect(treeCall.body.base_tree).toBe('tree-base');
    });

    it('parents the commit on the pinned base', async () => {
      await service.createFactoryBranch(input());

      const [, commitCall] = http.request.mock.calls.find(
        ([path], i) => String(path).endsWith('/git/commits') && i > 0,
      )!;
      expect(commitCall.body.parents).toEqual([BASE]);
    });

    it('creates the ref LAST, so a partial failure leaves nothing reachable', async () => {
      await service.createFactoryBranch(input());

      const paths = http.request.mock.calls.map(([path]) => String(path));
      const refIndex = paths.findIndex((path) => path.endsWith('/git/refs'));

      expect(refIndex).toBe(paths.length - 1);
    });

    it('returns the new commit sha', async () => {
      const result = await service.createFactoryBranch(input());

      expect(result).toMatchObject({ commitSha: 'commit-1', created: true });
    });

    it('classifies the write for the approval engine', async () => {
      await service.createFactoryBranch(input());

      expect(writes.guardedWrite).toHaveBeenCalledWith(
        WriteAction.CreateFactoryBranch,
        expect.any(String),
        expect.any(Function),
      );
    });
  });

  describe('idempotency', () => {
    it('performs no write when the branch already exists', async () => {
      // A reconciler re-derives its conclusions every tick, so a re-dispatch
      // is ordinary rather than exceptional.
      mockCreation({ refExists: 'existing-commit' });

      const result = await service.createFactoryBranch(input());

      expect(result).toMatchObject({
        commitSha: 'existing-commit',
        created: false,
      });
      expect(result.write.noop).toBe(true);
    });

    it('creates no objects at all on the second pass', async () => {
      mockCreation({ refExists: 'existing-commit' });

      await service.createFactoryBranch(input());

      const posted = http.request.mock.calls.filter(
        ([, opts]) => opts?.method === 'POST',
      );
      expect(posted).toEqual([]);
    });

    it('reports the existing commit, which is what tells a runner what to do', async () => {
      // ADR-0005: comparing HEAD against this SHA distinguishes "dispatched,
      // nothing done" from "already worked" — which "does the branch exist"
      // cannot.
      mockCreation({ refExists: 'abc123' });

      expect((await service.createFactoryBranch(input())).commitSha).toBe(
        'abc123',
      );
    });
  });

  describe('the kill switch', () => {
    beforeEach(() => build(false));

    it('creates nothing when writes are disabled', async () => {
      mockCreation();

      const result = await service.createFactoryBranch(input());

      expect(result.write.performed).toBe(false);
      expect(
        http.request.mock.calls.filter(([, o]) => o?.method === 'POST'),
      ).toEqual([]);
    });

    it('names no commit it did not create', async () => {
      // Reporting a SHA here would be a lie, and one a caller would act on.
      mockCreation();

      expect((await service.createFactoryBranch(input())).commitSha).toBeNull();
    });
  });

  describe('findRef', () => {
    it('returns null for a branch that does not exist', async () => {
      mockCreation();

      expect(await service.findRef(REPO, 'factory/999-aaaaaaa-a1')).toBeNull();
    });

    it('propagates anything that is not a 404', async () => {
      http.request.mockRejectedValue(new Error('boom'));

      await expect(
        service.findRef(REPO, 'factory/312-a3f91c2-a1'),
      ).rejects.toThrow('boom');
    });
  });

  describe('the guarantee it replaces', () => {
    it('leaves GitHubWriteService free of every forbidden path', () => {
      // The existing spec still proves this; asserted here too so the
      // relationship between the two files is visible from this side.
      const writeSource = readFileSync(
        join(__dirname, '..', 'write', 'github-write.service.ts'),
        'utf8',
      );

      for (const forbidden of [
        '/git/refs',
        '/branches',
        '/actions/',
        '/merge',
        '/secrets',
      ]) {
        expect(writeSource).not.toContain(forbidden);
      }
    });
  });
});
