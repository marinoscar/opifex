'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

/**
 * Resolves the canonical `infra/compose/.env` file for a script living at
 * `apps/api/scripts/*`, whether the process is running from the main
 * checkout or from a git worktree under `worktrees/<name>/apps/api/scripts`.
 *
 * Fixes #322: the previous fixed `path.resolve(__dirname, '..', '..', '..',
 * 'infra', 'compose', '.env')` offset is correct from the main checkout, but
 * from a worktree it lands on `worktrees/<name>/infra/compose/.env`, which a
 * worktree never carries (only the tracked `.env.example`). `dotenv.config()`
 * on a missing path fails silently, so every Prisma script run from a
 * worktree — which is where CLAUDE.md's mandated workflow puts all
 * development — was quietly falling back to the ambient environment and the
 * `postgres` defaults, surfacing later as a misleading connection error
 * instead of a path problem.
 *
 * Candidate order:
 *   1. The fixed offset from `scriptDir` (`../../../infra/compose/.env`).
 *      In the main checkout this IS the canonical file. In a worktree, this
 *      is also where a developer would deliberately drop a per-worktree
 *      `.env` — and per #322's acceptance criteria, that file must still win
 *      if it exists, so it is checked (and honoured) first, before any git
 *      subprocess runs.
 *   2. The canonical file at the *git common directory's* parent — the real
 *      repository root, found via `git rev-parse --path-format=absolute
 *      --git-common-dir`. That command resolves correctly from inside any
 *      worktree as well as the main checkout (where it simply answers
 *      `<repo>/.git`, the same repository root candidate 1 already used).
 *
 * Never throws. Returns a result object so callers can log exactly what
 * happened — including "nothing found" and "git was unavailable" — instead
 * of continuing silently, which is the failure mode #322 reports.
 *
 * @param {string} scriptDir - `__dirname` of the calling script
 *   (`apps/api/scripts`).
 * @returns {{
 *   path: string | null,
 *   source: 'relative-to-script' | 'git-common-dir' | null,
 *   fixedOffsetPath: string,
 *   gitError: Error | null,
 * }}
 */
function resolveComposeEnvPath(scriptDir) {
  const fixedOffsetPath = path.resolve(
    scriptDir,
    '..',
    '..',
    '..',
    'infra',
    'compose',
    '.env',
  );

  if (fs.existsSync(fixedOffsetPath)) {
    return {
      path: fixedOffsetPath,
      source: 'relative-to-script',
      fixedOffsetPath,
      gitError: null,
    };
  }

  try {
    const commonDir = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: scriptDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();

    // commonDir is `<repo>/.git` for both a normal checkout and any
    // worktree of it — git worktrees share one `.git`, and only a
    // worktree-specific subdirectory *inside* it differs, so its parent is
    // always the real repository root.
    const repoRoot = path.dirname(commonDir);
    const commonDirEnvPath = path.resolve(repoRoot, 'infra', 'compose', '.env');

    if (fs.existsSync(commonDirEnvPath)) {
      return {
        path: commonDirEnvPath,
        source: 'git-common-dir',
        fixedOffsetPath,
        gitError: null,
      };
    }

    // git resolved fine, but neither candidate file exists. Genuinely
    // nothing to load.
    return { path: null, source: null, fixedOffsetPath, gitError: null };
  } catch (err) {
    // git is not on PATH (ENOENT), or scriptDir is not inside a git
    // repository at all (e.g. a container image that copies source without
    // `.git`). Either way, do not crash — fall back to reporting only the
    // fixed-offset result already checked above, and let the caller say so.
    return { path: null, source: null, fixedOffsetPath, gitError: err };
  }
}

module.exports = { resolveComposeEnvPath };
