import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * #322: `apps/api/scripts/prisma-env.js` and `test-db-connection.js` resolve
 * `infra/compose/.env` with a fixed `../../../` offset from `__dirname`. That
 * is correct from the main checkout but wrong from a git worktree — which is
 * where CLAUDE.md's mandated workflow puts all development — because a
 * worktree never carries the real `infra/compose/.env`, only the tracked
 * `.env.example`.
 *
 * This suite exercises the real `resolveComposeEnvPath` from
 * `apps/api/scripts/lib/resolve-compose-env.js` — not a reimplementation —
 * requiring it directly (it is plain CommonJS, so no ESM-into-CJS problem
 * the way `scripts/check-changelog.mjs` has; see
 * `apps/api/test/changelog/run-checker.mjs`'s header for that contrast).
 *
 * Every scenario below runs against a real, disposable git repository built
 * with `git init` / `git worktree add` under `os.tmpdir()`, including an
 * actual linked worktree, so the git-common-dir resolution is proven against
 * real git plumbing rather than a mock.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  resolveComposeEnvPath,
} = require('../../scripts/lib/resolve-compose-env');

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

/** A fresh, disposable git repository with at least one commit. */
function buildRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-compose-env-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Resolve Compose Env Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'README.md'), 'x');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

function writeEnvFile(root: string, marker: string): string {
  const envDir = join(root, 'infra', 'compose');
  mkdirSync(envDir, { recursive: true });
  const envPath = join(envDir, '.env');
  writeFileSync(envPath, `POSTGRES_HOST=${marker}\n`);
  return envPath;
}

function apiScriptsDir(root: string): string {
  const dir = join(root, 'apps', 'api', 'scripts');
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('resolveComposeEnvPath', () => {
  const dirs: string[] = [];

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'resolve-compose-env-plain-'));
    dirs.push(dir);
    return dir;
  }

  function trackRepo(dir: string): string {
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (dirs.length) {
      rmSync(dirs.pop() as string, { recursive: true, force: true });
    }
  });

  it('finds infra/compose/.env at the fixed offset in a main-checkout layout', () => {
    const repo = trackRepo(buildRepo());
    const envPath = writeEnvFile(repo, 'main-checkout');
    const scriptsDir = apiScriptsDir(repo);

    const result = resolveComposeEnvPath(scriptsDir);

    expect(result.path).toBe(envPath);
    expect(result.source).toBe('relative-to-script');
    expect(result.gitError).toBeNull();
  });

  it('falls back to the git common directory when a linked worktree has no local .env', () => {
    const repo = trackRepo(buildRepo());
    const mainEnvPath = writeEnvFile(repo, 'main-worktree');

    const worktree = join(repo, '..', `${repo.split('/').pop()}-wt`);
    git(repo, ['worktree', 'add', '-q', '-b', 'feature', worktree, 'main']);
    dirs.push(worktree);

    const worktreeScriptsDir = apiScriptsDir(worktree);

    const result = resolveComposeEnvPath(worktreeScriptsDir);

    expect(result.path).toBe(mainEnvPath);
    expect(result.source).toBe('git-common-dir');
    expect(result.gitError).toBeNull();
  });

  it('honours a deliberate worktree-local .env over the main checkout one', () => {
    const repo = trackRepo(buildRepo());
    writeEnvFile(repo, 'main-worktree');

    const worktree = join(repo, '..', `${repo.split('/').pop()}-wt2`);
    git(repo, ['worktree', 'add', '-q', '-b', 'feature2', worktree, 'main']);
    dirs.push(worktree);

    const worktreeEnvPath = writeEnvFile(worktree, 'worktree-local');
    const worktreeScriptsDir = apiScriptsDir(worktree);

    const result = resolveComposeEnvPath(worktreeScriptsDir);

    expect(result.path).toBe(worktreeEnvPath);
    expect(result.source).toBe('relative-to-script');
    expect(result.gitError).toBeNull();
  });

  it('reports nothing found (not silence) when the repo has no .env anywhere', () => {
    const repo = trackRepo(buildRepo());
    const scriptsDir = apiScriptsDir(repo);

    const result = resolveComposeEnvPath(scriptsDir);

    expect(result.path).toBeNull();
    expect(result.source).toBeNull();
    expect(result.gitError).toBeNull();
    expect(result.fixedOffsetPath).toBe(join(repo, 'infra', 'compose', '.env'));
  });

  it('reports a gitError rather than crashing when the directory is not a git repository at all', () => {
    const plain = tempDir();
    const scriptsDir = apiScriptsDir(plain);

    const result = resolveComposeEnvPath(scriptsDir);

    expect(result.path).toBeNull();
    expect(result.source).toBeNull();
    expect(result.gitError).not.toBeNull();
    expect(result.gitError.message).toContain('git');
  });

  it('reports a gitError rather than crashing when git itself is not on PATH', () => {
    // resolveComposeEnvPath always inherits process.env, so the only way to
    // exercise "git is not on PATH" without changing the library's contract
    // is to run it in a real subprocess whose PATH is stripped.
    const repo = trackRepo(buildRepo());
    const scriptsDir = apiScriptsDir(repo);
    const libPath = join(
      __dirname,
      '..',
      '..',
      'scripts',
      'lib',
      'resolve-compose-env.js',
    );

    const output = execFileSync(
      process.execPath,
      [
        '-e',
        `
          const { resolveComposeEnvPath } = require(${JSON.stringify(libPath)});
          const r = resolveComposeEnvPath(${JSON.stringify(scriptsDir)});
          console.log(JSON.stringify({
            path: r.path,
            source: r.source,
            hasGitError: r.gitError !== null,
          }));
        `,
      ],
      { encoding: 'utf8', env: { PATH: '' } },
    );

    const parsed = JSON.parse(output.trim());
    expect(parsed.path).toBeNull();
    expect(parsed.source).toBeNull();
    expect(parsed.hasGitError).toBe(true);
  });
});
