/**
 * Shared git-range reading for the CI checkers under scripts/.
 *
 * Extracted from scripts/check-provenance.mjs when scripts/check-changelog.mjs
 * needed the same walk (#312). Two independent parsers of `git log` output in
 * the same repository is how two checks come to disagree about what "the
 * commits in this pull request" means, and a checker that disagrees with its
 * neighbour is a checker somebody eventually stops believing.
 *
 * Everything here shells out to git and throws on failure. Callers are
 * expected to let that throw reach the top and exit non-zero: per
 * check-provenance.mjs's own rule, "a checker that silently degrades to
 * 'allow everything' is worse than no checker, because it reports success."
 */

import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

// ASCII record/unit separators. Chosen because a commit message can contain
// any printable text — including newlines and any delimiter a person would
// think to type — but not these.
const RECORD = '\x01';
const FIELD = '\x02';

function git(args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * The commits in `base..head`, newest first.
 *
 * `firstParent` limits the walk to the branch's own line of development. It is
 * off by default so the provenance check keeps the behaviour it shipped with:
 * that check exempts merge commits individually and does want to see every
 * commit a pull request would land, trailers and all.
 */
export function commitsBetween(base, head, { firstParent = false } = {}) {
  const args = ['log', `--format=%H${FIELD}%P${FIELD}%s${FIELD}%B${RECORD}`];
  if (firstParent) args.push('--first-parent');
  args.push(`${base}..${head}`);

  return git(args)
    .split(RECORD)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, parents, subject, message] = record.split(FIELD);
      return {
        sha,
        parents: parents.trim().split(/\s+/).filter(Boolean),
        subject,
        message,
      };
    });
}

/**
 * Repository-relative paths the pull request changes, as GitHub's own "Files
 * changed" tab computes them: the three-dot diff, merge-base(base, head) to
 * head. Two-dot would additionally report everything that landed on the base
 * branch since the fork point as though this pull request had reverted it.
 *
 * Throws when the two commits have no merge base, which is the honest outcome:
 * with no fork point there is no "what this pull request changed" to report.
 */
export function changedFiles(base, head) {
  return git(['diff', '--name-only', `${base}...${head}`])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
