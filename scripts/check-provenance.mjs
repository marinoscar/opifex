#!/usr/bin/env node
/**
 * The CI provenance check (#28).
 *
 * VISION §5 is unambiguous about enforcement — "Enforced by CI. A pull request
 * missing them fails its provenance check." — and about why it has to be
 * automated rather than reviewed:
 *
 *   "No PR without one — a single orphan puts a hole in the graph, and holes
 *    are not detectable after the fact."
 *
 * That last clause is the whole argument. A missing trailer cannot be found
 * later by inspection, because there is nothing to inspect. The link simply is
 * not there, and nothing about the commit says it should have been.
 *
 * ## Why this reads docs/PROVENANCE.md instead of hardcoding the patterns
 *
 * #28 requires that the check be "derived from the spec in #26, so the two
 * cannot drift". A checker with its own copy of the regexes satisfies that on
 * the day it is written and then quietly stops: someone edits the document,
 * the checker keeps enforcing the old shape, and the document becomes a lie
 * that nobody notices because CI is still green.
 *
 * So the patterns are extracted from the document at run time, exactly as
 * apps/api/test/provenance/trailer-vocabulary.spec.ts already does against the
 * generator. The document is the specification in a load-bearing sense: edit
 * the table in PROVENANCE.md and this check changes behaviour on the next run.
 * If the document stops parsing, this fails loudly rather than falling back to
 * a default — a checker that silently degrades to "allow everything" is worse
 * than no checker, because it reports success.
 *
 * ## Usage
 *
 *   node scripts/check-provenance.mjs --base <sha> --head <sha>
 *
 * The PR body arrives via the PR_BODY environment variable (GitHub Actions
 * cannot safely interpolate it into a shell argument). Passing --body-file is
 * supported for local runs and tests.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The trailers the specification defines, and who must carry them.
 *
 * Mirrors PROVENANCE.md's "Required by authorship" table. The `Issue:` split is
 * the one that needs explaining: it is required absolutely on agent-authored
 * commits, because a work order has no other way to name its issue and a squash
 * merge destroys the PR-level context that would otherwise stand in. On a
 * human-authored commit the PR's own closing keyword carries the same edge, so
 * the trailer is validated when present and not demanded when absent.
 */
const AGENT_REQUIRED = ['Work-Order', 'Issue', 'Runner', 'Run-Id', 'Attempt'];
const HUMAN_FORBIDDEN = ['Work-Order', 'Runner', 'Run-Id', 'Attempt'];
const ALL_TRAILERS = ['Work-Order', 'Issue', 'Decision', 'Runner', 'Run-Id', 'Attempt'];

/**
 * GitHub's own closing-keyword set, which is what actually decides whether the
 * issue closes on merge. Narrowing it here would fail PRs that GitHub would
 * have linked correctly, which trains people to distrust the check.
 */
const CLOSING_KEYWORD =
  /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+(#\d+|[\w.-]+\/[\w.-]+#\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+)/i;

/**
 * Pull a documented pattern out of its table row in PROVENANCE.md.
 *
 * Same extraction the trailer-vocabulary spec uses, deliberately: two different
 * readers of the same document that disagree about how to read it would
 * reintroduce exactly the drift this is meant to prevent.
 */
function documentedPattern(provenance, trailer) {
  const start = provenance.indexOf(`### \`${trailer}:\``);
  if (start === -1) {
    throw new Error(
      `docs/PROVENANCE.md defines no section for ${trailer}: — the spec and this check have diverged.`,
    );
  }

  const match = /matching `\^([^`]+)\$`/.exec(provenance.slice(start, start + 700));
  if (!match) {
    throw new Error(
      `docs/PROVENANCE.md documents no pattern for ${trailer}: — the spec and this check have diverged.`,
    );
  }

  return new RegExp(`^${match[1]}$`);
}

function loadPatterns() {
  const provenance = readFileSync(join(REPO_ROOT, 'docs/PROVENANCE.md'), 'utf8');
  return Object.fromEntries(ALL_TRAILERS.map((t) => [t, documentedPattern(provenance, t)]));
}

/**
 * Extract the trailer block: the last contiguous run of `Key: value` lines at
 * the end of the message.
 *
 * Hand-rolled rather than delegating to `git interpret-trailers` because
 * PROVENANCE.md imposes rules git does not — case-sensitive keys, exactly one
 * space after the colon, each key at most once — and a parser that normalises
 * those away cannot report them. Reading the raw message is the only way to
 * see the formatting the spec actually constrains.
 */
export function parseTrailers(message) {
  const lines = message.replace(/\r\n/g, '\n').trimEnd().split('\n');

  let start = lines.length;
  while (start > 0 && /^[A-Za-z][A-Za-z0-9-]*:/.test(lines[start - 1])) start -= 1;

  // A trailer block is the last block. If what precedes it is neither a blank
  // line nor the start of the message, those lines are prose that happens to
  // contain a colon, not trailers.
  if (start === lines.length) return { trailers: [], malformed: [] };
  if (start > 0 && lines[start - 1].trim() !== '') return { trailers: [], malformed: [] };

  const trailers = [];
  const malformed = [];

  for (const line of lines.slice(start)) {
    const [, key, separator, value] = /^([A-Za-z][A-Za-z0-9-]*):(\s*)(.*)$/.exec(line);

    // "One space after the colon. No leading whitespace." Only enforced for
    // keys the vocabulary actually defines — `Co-authored-by:` and friends are
    // other tools' business, and unknown keys are explicitly permitted.
    if (ALL_TRAILERS.includes(key) && separator !== ' ') {
      malformed.push(`${key}: must have exactly one space after the colon`);
    }

    trailers.push({ key, value: value.trim() });
  }

  return { trailers, malformed };
}

/** `ADR-0008` must resolve to exactly one `docs/adr/0008-*.md`. */
function resolvesToAdr(value) {
  const number = value.slice(4);
  const dir = join(REPO_ROOT, 'docs/adr');
  if (!existsSync(dir)) return false;
  return readdirSync(dir).filter((f) => f.startsWith(`${number}-`) && f.endsWith('.md')).length === 1;
}

/**
 * Apply the specification to one commit.
 *
 * Returns a list of human-readable problems. Each one names the field and what
 * to do about it: #28 requires that "the failure message says exactly what to
 * add", because a check that only says "provenance failed" gets bypassed
 * rather than satisfied.
 */
export function checkCommit(commit, patterns) {
  const problems = [];

  // Merge commits are exempt. Their message is generated by GitHub and their
  // author is whoever pressed the button; requiring trailers there would mean
  // failing every merge or rewriting messages nobody wrote.
  if (commit.parents.length > 1) return problems;

  const { trailers, malformed } = parseTrailers(commit.message);
  problems.push(...malformed);

  const present = new Map();
  for (const { key, value } of trailers) {
    if (!ALL_TRAILERS.includes(key)) continue; // unknown keys are permitted and ignored
    if (present.has(key)) {
      problems.push(
        `${key}: appears more than once — a key appears at most once (see docs/PROVENANCE.md, "Multiple issues")`,
      );
      continue;
    }
    present.set(key, value);
  }

  // "This trailer is the machine-readable definition of agent-authored."
  // Work-Order: also counts, so a commit claiming a work order cannot escape
  // the full requirement set by omitting Runner:.
  const agentAuthored = present.has('Runner') || present.has('Work-Order');

  for (const [key, value] of present) {
    if (!patterns[key].test(value)) {
      problems.push(`${key}: value "${value}" does not match the format in docs/PROVENANCE.md`);
    }
  }

  if (present.has('Decision')) {
    const value = present.get('Decision');
    if (patterns.Decision.test(value) && !resolvesToAdr(value)) {
      problems.push(
        `Decision: ${value} names no file under docs/adr/ — a dangling decision reference`,
      );
    }
  }

  if (agentAuthored) {
    // "The five agent trailers are all-or-nothing. A commit carrying Runner:
    // and no Run-Id: is malformed, not partially compliant."
    for (const key of AGENT_REQUIRED) {
      if (!present.has(key)) {
        problems.push(
          `${key}: missing — this commit is agent-authored (it carries ${
            present.has('Runner') ? 'Runner:' : 'Work-Order:'
          }), so all of ${AGENT_REQUIRED.join(', ')} are required`,
        );
      }
    }

    // Redundant with Work-Order:'s _a{n} suffix on purpose, so metric 4 does
    // not require parsing a composite string. If they disagree the identity
    // wins, because it is what everything else resolves through.
    const workOrder = present.get('Work-Order');
    const attempt = present.get('Attempt');
    if (workOrder && attempt) {
      const fromIdentity = /_a(\d+)$/.exec(workOrder)?.[1];
      if (fromIdentity && fromIdentity !== attempt) {
        problems.push(
          `Attempt: ${attempt} disagrees with Work-Order: ${workOrder} (which says attempt ${fromIdentity}); Work-Order: is authoritative`,
        );
      }
    }
  } else {
    for (const key of HUMAN_FORBIDDEN) {
      if (present.has(key)) {
        problems.push(`${key}: present on a human-authored commit, where it must be absent`);
      }
    }
  }

  return problems;
}

function commitsBetween(base, head) {
  const RECORD = '';
  const FIELD = '';
  const raw = execFileSync(
    'git',
    ['log', `--format=%H${FIELD}%P${FIELD}%s${FIELD}%B${RECORD}`, `${base}..${head}`],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );

  return raw
    .split(RECORD)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, parents, subject, message] = record.split(FIELD);
      return { sha, parents: parents.trim().split(/\s+/).filter(Boolean), subject, message };
    });
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const body = args['body-file'] ? readFileSync(args['body-file'], 'utf8') : (process.env.PR_BODY ?? '');

  let patterns;
  try {
    patterns = loadPatterns();
  } catch (error) {
    // Fail loudly. Falling back to a permissive default here would turn a
    // broken spec into a green check, which is the failure this exists to stop.
    console.error(`✗ Cannot read the provenance specification:\n  ${error.message}`);
    process.exit(1);
  }

  const failures = [];

  if (!CLOSING_KEYWORD.test(body)) {
    failures.push(
      'The pull request body has no closing keyword.\n' +
        '  Add one of: Fixes #123 / Closes #123 / Resolves #123\n' +
        '  VISION §5: "No PR without one — a single orphan puts a hole in the graph,\n' +
        '  and holes are not detectable after the fact."',
    );
  }

  for (const commit of commitsBetween(args.base, args.head)) {
    const problems = checkCommit(commit, patterns);
    if (problems.length > 0) {
      failures.push(
        `${commit.sha.slice(0, 9)} ${commit.subject}\n` + problems.map((p) => `    ${p}`).join('\n'),
      );
    }
  }

  if (failures.length > 0) {
    console.error('✗ Provenance check failed.\n');
    for (const failure of failures) console.error(`  ${failure}\n`);
    console.error('  The vocabulary is specified in docs/PROVENANCE.md.');
    process.exit(1);
  }

  console.log('✓ Provenance check passed.');
}

// Only run when invoked directly, so the tests can import the pure functions.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
