import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * #312's CI changelog gate, exercised against the real
 * `scripts/check-changelog.mjs` — not a reimplementation of its rules. See
 * that file's own header for the design (no escape hatch, first-parent walk,
 * "the check enforces the habit, review enforces the content").
 *
 * Two different harnesses are used here, for two different reasons:
 *
 * - `commitType` and `gatedCommits` are pure functions. Calling them from
 *   inside this Jest process directly would hit the ESM-into-CJS problem
 *   `run-checker.mjs` documents, so those tests shell out to that harness.
 * - The end-to-end exit-code behaviour goes through `main()`, which shells
 *   out to `git` itself and is only reachable by actually running the
 *   script. Those tests build a *disposable* git repository under
 *   `os.tmpdir()`, copy the real `scripts/check-changelog.mjs` and
 *   `scripts/lib/git-range.mjs` into it (preserving their relative import
 *   path), and spawn `node <copy>/scripts/check-changelog.mjs --base --head`
 *   as a real subprocess.
 *
 *   The copy is not a shortcut — it is required. `scripts/lib/git-range.mjs`
 *   computes `REPO_ROOT` once, from its own file location
 *   (`dirname(import.meta.url)/../..`), and always runs `git` with
 *   `cwd: REPO_ROOT`. A script invoked in place would always read *this*
 *   worktree's history, no matter what `--base`/`--head` shas were passed.
 *   Copying the two files into a fresh `git init`-ed temp directory makes
 *   `REPO_ROOT` resolve to that temp directory instead, so the checker reads
 *   exactly the disposable history the test built and nothing else.
 *
 *   `worktrees/changelog-gate`'s own `.git` is a *file* pointing outside this
 *   checkout (a git worktree), which breaks `git` invocations made from
 *   inside a container that only mounts the worktree. That is irrelevant
 *   here on purpose: every git repository these tests build is a fresh
 *   `git init` inside a real temp directory, never this worktree.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const SCRIPT_SRC = join(REPO_ROOT, 'scripts', 'check-changelog.mjs');
const GIT_RANGE_SRC = join(REPO_ROOT, 'scripts', 'lib', 'git-range.mjs');

// --- unit-level harness (commitType / gatedCommits), via run-checker.mjs ---

const HARNESS = join(__dirname, 'run-checker.mjs');

interface Commit {
  sha: string;
  parents: string[];
  subject: string;
  message: string;
}

type Task =
  | { fn: 'commitType'; subject: string | null | undefined }
  | { fn: 'gatedCommits'; commits: Commit[] };

type CommitTypeResult = { type: string | null };
type GatedCommitsResult = { commits: Commit[] };

function runTasks(tasks: Task[]): (CommitTypeResult | GatedCommitsResult)[] {
  const output = execFileSync('node', [HARNESS], {
    input: JSON.stringify(tasks),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(output);
}

function commitType(subject: string | null | undefined): string | null {
  const [result] = runTasks([{ fn: 'commitType', subject }]) as [
    CommitTypeResult,
  ];
  return result.type;
}

function gatedCommits(commits: Commit[]): Commit[] {
  const [result] = runTasks([{ fn: 'gatedCommits', commits }]) as [
    GatedCommitsResult,
  ];
  return result.commits;
}

function commit(
  sha: string,
  subject: string,
  parents: string[] = ['p'],
): Commit {
  return { sha, parents, subject, message: subject };
}

describe('commitType', () => {
  describe('gated types', () => {
    it.each([
      ['feat: add x', 'feat'],
      ['fix: y', 'fix'],
      ['feat!: breaking', 'feat'],
      ['fix(scope)!: breaking with scope', 'fix'],
      ['Fix: capitalised is still a fix', 'fix'],
    ])('%s -> %s', (subject, expected) => {
      expect(commitType(subject)).toBe(expected);
    });
  });

  describe('non-gated conventional types', () => {
    it.each(['chore', 'docs', 'refactor', 'test', 'perf', 'ci'])(
      '%s: is a real type, just not a gated one',
      (type) => {
        expect(commitType(`${type}: something`)).toBe(type);
      },
    );
  });

  describe('null (not a conventional-commit subject at all)', () => {
    it('returns null for a subject with no colon', () => {
      expect(commitType('bump the widget version')).toBeNull();
    });

    it('returns null for "feat:no-space" — no space after the colon', () => {
      // A decided behaviour worth pinning, not an accident: the regex
      // requires `:\s`, so a colon glued to the next word is not read as a
      // conventional-commit separator.
      expect(commitType('feat:no-space')).toBeNull();
    });

    it('returns null for a fixup! commit, even one that wraps a feat', () => {
      expect(commitType('fixup! feat: x')).toBeNull();
    });

    it('returns null for a GitHub-generated merge commit subject', () => {
      expect(commitType('Merge pull request #14 from o/fix/x')).toBeNull();
    });

    it('returns null for an empty subject', () => {
      expect(commitType('')).toBeNull();
    });

    it('returns null for an undefined subject', () => {
      expect(commitType(undefined)).toBeNull();
    });
  });

  describe('reverts', () => {
    it('unwraps a single revert to the original type', () => {
      expect(commitType('Revert "feat: x"')).toBe('feat');
    });

    it('unwraps a nested (re-applied) revert to the original type', () => {
      expect(commitType('Revert "Revert "feat: x""')).toBe('feat');
    });

    it('unwraps a revert of a non-gated type to that type', () => {
      expect(commitType('Revert "chore: x"')).toBe('chore');
    });

    it('reads a bare "revert:" subject as its own conventional type, not an unwrap', () => {
      // The closest thing to an escape hatch in the whole design: this is
      // NOT `git revert`'s generated wrapper (`Revert "…"`, capital R, the
      // original subject quoted) — it is a hand-typed subject that merely
      // starts with the word "revert". It reads as its own type, `revert`,
      // which is not in GATED_TYPES, so gatedCommits below must not gate it
      // even though the words "undo" and "feat" are sitting right there.
      expect(commitType('revert: undo the feat')).toBe('revert');
    });

    function nestedRevert(depth: number, inner: string): string {
      let subject = inner;
      for (let i = 0; i < depth; i += 1) subject = `Revert "${subject}"`;
      return subject;
    }

    it('resolves a 9-deep revert chain (one under the bound)', () => {
      expect(commitType(nestedRevert(9, 'feat: inner'))).toBe('feat');
    });

    it('returns null for a 10-deep revert chain — the depth bound stops it before the real type is reached', () => {
      // The loop is bounded at depth < 10, i.e. 10 iterations. Each
      // iteration either matches the conventional-commit shape or unwraps
      // exactly one revert layer. 10 layers of wrapping take all 10
      // iterations just to unwrap, so the unwrapped "feat: inner" is never
      // itself checked — the loop exits first and the final `return null`
      // fires. This is the boundary, not an approximation of it: depth 9
      // resolves (previous test), depth 10 does not.
      expect(commitType(nestedRevert(10, 'feat: inner'))).toBeNull();
    });
  });
});

describe('gatedCommits', () => {
  it('skips a merge commit even when its subject reads like a feat', () => {
    const commits = [
      commit('a', 'feat: this looks gated but is a merge', ['p1', 'p2']),
    ];
    expect(gatedCommits(commits)).toEqual([]);
  });

  it('returns only the gated commits from a mixed list, preserving order', () => {
    const feat = commit('a', 'feat(api): add widget');
    const fix = commit('b', 'fix: correct the thing');
    const chore = commit('c', 'chore: tidy up');
    const mergeLooksLikeFeat = commit('d', 'feat: absorbed by a merge', [
      'p1',
      'p2',
    ]);
    const revertOfFeat = commit('e', 'Revert "feat: rolled back"');
    const bareRevert = commit('f', 'revert: undo the feat');

    const commits = [
      feat,
      fix,
      chore,
      mergeLooksLikeFeat,
      revertOfFeat,
      bareRevert,
    ];

    expect(gatedCommits(commits)).toEqual([feat, fix, revertOfFeat]);
  });
});

// --- end-to-end: the real main(), against a disposable git repository ---

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

/** A fresh, disposable git repository with the real checker copied into it. */
function buildRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'changelog-gate-'));

  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  copyFileSync(SCRIPT_SRC, join(dir, 'scripts', 'check-changelog.mjs'));
  copyFileSync(GIT_RANGE_SRC, join(dir, 'scripts', 'lib', 'git-range.mjs'));

  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Changelog Gate Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);

  return dir;
}

interface CommitOptions {
  file?: string;
  content?: string;
  allowEmpty?: boolean;
}

/** Writes `file` (if given), commits with `subject`, and returns the sha. */
function commitInRepo(
  dir: string,
  subject: string,
  { file, content = 'x', allowEmpty = false }: CommitOptions = {},
): string {
  if (file) {
    mkdirSync(join(dir, ...file.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, file), content);
  }
  git(dir, ['add', '-A']);
  const flags = allowEmpty ? ['--allow-empty'] : [];
  git(dir, ['commit', ...flags, '-m', subject]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

interface CheckerResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs the copied checker as a real subprocess and captures its outcome. */
function runChecker(dir: string, args: string[]): CheckerResult {
  try {
    const stdout = execFileSync(
      'node',
      [join(dir, 'scripts', 'check-changelog.mjs'), ...args],
      { cwd: dir, encoding: 'utf8' },
    );
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

describe('check-changelog.mjs end-to-end', () => {
  const repos: string[] = [];

  function newRepo(): string {
    const dir = buildRepo();
    repos.push(dir);
    return dir;
  }

  afterEach(() => {
    while (repos.length) {
      rmSync(repos.pop() as string, { recursive: true, force: true });
    }
  });

  it('exits 0 when a feat commit ships alongside a CHANGELOG.md edit', () => {
    const dir = newRepo();
    const base = commitInRepo(dir, 'chore: init', { file: 'README.md' });
    commitInRepo(dir, 'feat(api): add widget', { file: 'src/widget.ts' });
    const head = commitInRepo(dir, 'docs: changelog entry', {
      file: 'CHANGELOG.md',
      content: '## Unreleased\n- Added: widget\n',
    });

    const result = runChecker(dir, ['--base', base, '--head', head]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('passed');
  });

  it('exits 1 when a feat commit ships with no CHANGELOG.md edit', () => {
    const dir = newRepo();
    const base = commitInRepo(dir, 'chore: init', { file: 'README.md' });
    const head = commitInRepo(dir, 'feat(api): add widget', {
      file: 'src/widget.ts',
    });

    const result = runChecker(dir, ['--base', base, '--head', head]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not touch CHANGELOG.md');
    expect(result.stderr).toContain('feat(api): add widget');
  });

  it('exits 0 for a docs-only range', () => {
    const dir = newRepo();
    const base = commitInRepo(dir, 'chore: init', { file: 'README.md' });
    const head = commitInRepo(dir, 'docs: update readme', {
      file: 'README.md',
      content: 'updated',
    });

    const result = runChecker(dir, ['--base', base, '--head', head]);

    expect(result.status).toBe(0);
  });

  it('exits 0 for an empty range (base === head)', () => {
    const dir = newRepo();
    const base = commitInRepo(dir, 'chore: init', { file: 'README.md' });

    const result = runChecker(dir, ['--base', base, '--head', base]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('no commits');
  });

  it('exits 1 when --base or --head is missing', () => {
    const dir = newRepo();
    commitInRepo(dir, 'chore: init', { file: 'README.md' });

    const result = runChecker(dir, []);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--base');
    expect(result.stderr).toContain('--head');
  });

  it('exits 1 for an unknown revision', () => {
    const dir = newRepo();
    const head = commitInRepo(dir, 'chore: init', { file: 'README.md' });

    const result = runChecker(dir, [
      '--base',
      'deadbeef'.repeat(5),
      '--head',
      head,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('could not read');
  });

  // The regression this spec exists to catch: --first-parent must stay in
  // check-changelog.mjs's call to commitsBetween(). See the header comment
  // on that call in scripts/check-changelog.mjs, and this spec's own header
  // for how the load-bearing-ness of this one test was verified by hand.
  it('REGRESSION GUARD (--first-parent): does not false-positive on a topic branch that merges in a feat from main', () => {
    const dir = newRepo();

    // The topic branch's own history: a stale base, then one chore commit.
    // Never anything gated, on its own line of development.
    const staleBase = commitInRepo(dir, 'chore: init', { file: 'base.txt' });
    git(dir, ['checkout', '-q', '-b', 'topic']);
    commitInRepo(dir, 'chore: topic work', { file: 'topic.txt' });

    // Meanwhile, main moves on without this branch: another engineer's feat
    // lands directly on main, after the point this topic branch forked from.
    git(dir, ['checkout', '-q', 'main']);
    commitInRepo(dir, 'feat(api): unrelated feature landed on main', {
      file: 'feature.ts',
    });

    // The topic branch absorbs it by merging main back in. The merge commit
    // has two parents; its second parent carries the other engineer's feat.
    git(dir, ['checkout', '-q', 'topic']);
    git(dir, [
      'merge',
      '--no-ff',
      '-m',
      "Merge branch 'main' into topic",
      'main',
    ]);
    const head = git(dir, ['rev-parse', 'HEAD']).trim();

    const result = runChecker(dir, ['--base', staleBase, '--head', head]);

    // With --first-parent, the walk from head follows only the topic
    // branch's own line of development: the merge commit (skipped, 2
    // parents) and "chore: topic work". The absorbed feat is on main's line,
    // not topic's, so it is invisible to this walk and the branch — which
    // never itself authored a feat or a fix — passes cleanly.
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('no feat/fix commits');
  });
});
