#!/usr/bin/env node
/**
 * Apply `.github/labels.yml` to a repository, or report how far it has drifted
 * (#195).
 *
 * ## Why this exists
 *
 * The file declared 32 labels and nothing had ever applied them. None of the
 * seven `factory:*` / `factory/*` labels existed on the repository, which is
 * not cosmetic: VISION §3.3 makes input labels the operator's control surface —
 * *"you can always fix the factory by editing GitHub"* — and a label that does
 * not exist cannot be put on an issue. So no issue could carry `factory:ready`,
 * the desired-state projection had nothing to find, and the reconciler computed
 * zero actions on every tick, correctly, forever. Epic #16's observation week
 * would have produced an empty diff log.
 *
 * `input-labels.spec.ts` already checks the implemented labels against this
 * file. That compares code to the file and neither of them to GitHub, which is
 * why the gap was invisible to CI.
 *
 * ## It never deletes
 *
 * A label present on GitHub and absent from the file is REPORTED, never
 * removed. Deleting a label strips it from every issue that carries it, and
 * that is not recoverable from this file — the file knows the label's name and
 * colour, not which issues had it. An unrecognised label is far more likely to
 * be a human's than a mistake, and the cost of the two errors is nowhere near
 * symmetric.
 *
 * ## Why it is not gated by GITHUB_WRITES_ENABLED
 *
 * That flag gates what the control plane does to issues during a tick — whether
 * the factory acts. Creating the label taxonomy is operator setup, the same
 * category as registering a repository, and it happens before the loop has
 * anything to say. Gating it on the same switch would mean the observation week
 * could not be set up without turning on the writes it is meant to withhold.
 *
 * ## Usage
 *
 *   node scripts/sync-labels.mjs                 # check the default repo
 *   node scripts/sync-labels.mjs --apply         # create and update
 *   node scripts/sync-labels.mjs --repo o/n      # somewhere else
 *
 * Checking is the default and writing needs `--apply`, so a mistyped flag reads
 * rather than writes. Authentication is the `gh` CLI's, so this uses whatever
 * the operator is already logged in as and stores no token of its own.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LABELS_FILE = join(REPO_ROOT, '.github', 'labels.yml');

/** Read the declared taxonomy. */
export function declaredLabels(source = readFileSync(LABELS_FILE, 'utf8')) {
  const parsed = parse(source);
  if (!Array.isArray(parsed)) {
    throw new Error('.github/labels.yml must be a list of labels');
  }

  return parsed.map((label) => {
    if (!label?.name) {
      throw new Error(
        `A label in .github/labels.yml has no name: ${JSON.stringify(label)}`,
      );
    }
    return {
      name: String(label.name),
      // GitHub stores colours without the leading '#', case-insensitively.
      color: String(label.color ?? '')
        .replace(/^#/, '')
        .toLowerCase(),
      description: String(label.description ?? ''),
    };
  });
}

/**
 * The label PREFIXES, restated here and nowhere else in this file.
 *
 * The origin is `apps/api/src/github/labels/factory-labels.ts`
 * (`INPUT_LABEL_PREFIX`, `MIRROR_LABEL_PREFIX`) and
 * `apps/api/src/github/labels/ignored-labels.ts` (`NEEDS_LABEL_PREFIX`,
 * `TIER_LABEL_PREFIX`). This script is plain `.mjs` and cannot import the
 * TypeScript, so the values are restated — ONCE, as named constants, with
 * `sync-labels.spec.ts` asserting they still equal the code's. A copy nothing
 * checks is a copy that drifts, and a drifted separator here would silently
 * reclassify every label in the report.
 */
export const LABEL_PREFIXES = {
  input: 'factory:',
  mirror: 'factory/',
  needs: 'needs:',
  tier: 'tier:',
};

/**
 * The kinds, in the order the report prints them: most urgent first.
 *
 * The same three-way split `.github/labels.yml`'s header states, plus the
 * bucket for everything that is neither (#303). Two of the three kinds use a
 * colon, so the classification cannot be "does it contain a colon" — it is the
 * prefix, and for `factory` the separator, exactly as `isMirrorLabel` does it.
 */
export const LABEL_KINDS = ['input', 'mirror', 'routing', 'other'];

/**
 * Why a missing label of this kind matters, said once per section.
 *
 * A missing input label and a missing routing label are not the same news: the
 * first means the repository cannot be steered at all, the second means work
 * still runs, just never anywhere but the defaults. Printing them in one flat
 * list made an operator work that out for themselves, from the names (#303).
 */
const KIND_HEADINGS = {
  input: `Input labels (${LABEL_PREFIXES.input}) — your control surface. Missing: this repository cannot be steered.`,
  mirror: `Mirror labels (${LABEL_PREFIXES.mirror}) — Opifex's own writes. Missing: the factory cannot report what it is doing.`,
  routing: `Routing labels (${LABEL_PREFIXES.needs}/${LABEL_PREFIXES.tier}) — what the work needs. Missing: work runs, but only on the defaults.`,
  other:
    'Other labels (type, phase, component) — organisational; nothing in the control loop reads them.',
};

/**
 * Which kind a label name belongs to. Derived, never a list of names.
 *
 * `factory` is matched case-sensitively and by its separator, because that is
 * how the read boundary matches it. `needs:`/`tier:` are matched case-
 * INsensitively, because that is how `NEEDS_BY_LABEL` and `MODEL_TIER_BY_LABEL`
 * are looked up — an operator who typed `Tier:Large` gets the tier, so the
 * report must call it a routing label too rather than filing it under "other".
 *
 * Anything matching no prefix is `other`, never dropped: this script's whole
 * posture is that an unrecognised label is far more likely to be a human's
 * than a mistake.
 */
export function labelKind(name) {
  if (name.startsWith(LABEL_PREFIXES.mirror)) return 'mirror';
  if (name.startsWith(LABEL_PREFIXES.input)) return 'input';

  const lower = name.toLowerCase();
  if (
    lower.startsWith(LABEL_PREFIXES.needs) ||
    lower.startsWith(LABEL_PREFIXES.tier)
  ) {
    return 'routing';
  }
  return 'other';
}

/**
 * The drift report, as lines, grouped by kind.
 *
 * Pure and returning lines rather than printing, for the same reason
 * `diffLabels` is pure: the shape of this output is the part an operator
 * reads, so it needs to be assertable without a `gh` login. `main` prints
 * exactly what comes back and decides nothing about wording.
 *
 * It reports the diff and only the diff — what gets created or updated is
 * `main`'s business and is unchanged by any of this.
 */
export function formatDriftReport({ missing, changed, extra }) {
  const lines = [];

  // Undeclared labels first, as before, and each tagged with its kind: an
  // undeclared `tier:huge` on the repository is a different finding from
  // somebody's `wontfix`, and the tag is the cheapest way to say so without a
  // second set of headings for a list that is not part of the taxonomy.
  for (const name of extra) {
    lines.push(
      `~ ${name} [${labelKind(name)}] exists but is not declared — left alone, never deleted`,
    );
  }

  const entries = [
    ...missing.map((label) => ({
      name: label.name,
      line: `+ ${label.name} (missing)`,
    })),
    ...changed.map((label) => ({
      name: label.name,
      line: `± ${label.name} (${label.differences.join(', ')})`,
    })),
  ];

  for (const kind of LABEL_KINDS) {
    const ofKind = entries.filter((entry) => labelKind(entry.name) === kind);
    if (ofKind.length === 0) continue;

    if (lines.length > 0) lines.push('');
    lines.push(KIND_HEADINGS[kind]);
    for (const entry of ofKind) lines.push(`  ${entry.line}`);
  }

  return lines;
}

/**
 * GitHub's own constraints, checked before anything is written.
 *
 * The first real run of `--apply` created four labels and then died on the
 * fifth with HTTP 422 — three declared descriptions were over the 100-character
 * cap (#197). Half-applied is the worst of the three possible states: the drift
 * report shrinks, `gh label list` looks partly right, and nothing says the run
 * did not finish.
 *
 * So the whole declaration is validated first and every offender is named at
 * once. Reporting one per attempt would mean discovering the file's problems
 * one round trip at a time.
 */
export function validateLabels(labels) {
  const problems = [];
  const seen = new Set();

  for (const label of labels) {
    if (seen.has(label.name)) {
      problems.push(`${label.name}: declared more than once`);
    }
    seen.add(label.name);

    if (label.description.length > 100) {
      problems.push(
        `${label.name}: description is ${label.description.length} characters, ` +
          'and GitHub allows 100',
      );
    }
    if (!/^[0-9a-f]{6}$/.test(label.color)) {
      problems.push(
        `${label.name}: color '${label.color}' is not six hex digits`,
      );
    }
  }
  return problems;
}

/**
 * Compare declared against actual.
 *
 * Pure, so the tests can drive it without a network or a `gh` login.
 */
export function diffLabels(declared, actual) {
  const byName = new Map(actual.map((label) => [label.name, label]));

  const missing = [];
  const changed = [];
  for (const label of declared) {
    const existing = byName.get(label.name);
    if (!existing) {
      missing.push(label);
      continue;
    }
    const differences = [];
    if (existing.color !== label.color) {
      differences.push(`color ${existing.color} -> ${label.color}`);
    }
    if ((existing.description ?? '') !== label.description) {
      // A description that has moved is a label whose MEANING has moved, which
      // matters more here than colour: it is the only place the input/mirror
      // distinction is written down where an operator will read it.
      differences.push('description');
    }
    if (differences.length > 0) changed.push({ ...label, differences });
  }

  const declaredNames = new Set(declared.map((label) => label.name));
  const extra = actual
    .filter((label) => !declaredNames.has(label.name))
    .map((label) => label.name);

  return { missing, changed, extra };
}

const gh = (args) =>
  execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });

function actualLabels(repo) {
  const args = [
    'label',
    'list',
    '--limit',
    '200',
    '--json',
    'name,color,description',
  ];
  if (repo) args.push('--repo', repo);
  return JSON.parse(gh(args)).map((label) => ({
    name: label.name,
    color: String(label.color ?? '').toLowerCase(),
    description: label.description ?? '',
  }));
}

function applyLabel(label, exists, repo) {
  const args = exists
    ? ['label', 'edit', label.name]
    : ['label', 'create', label.name];
  args.push('--color', label.color, '--description', label.description);
  if (repo) args.push('--repo', repo);
  gh(args);
}

function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const repoIndex = argv.indexOf('--repo');
  const repo = repoIndex === -1 ? undefined : argv[repoIndex + 1];

  const declared = declaredLabels();

  // Before the network, and before any write: a declaration GitHub will reject
  // should fail here, whole, rather than part-way through the repository.
  const problems = validateLabels(declared);
  if (problems.length > 0) {
    console.error('.github/labels.yml declares labels GitHub will not accept:');
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }

  const actual = actualLabels(repo);
  const { missing, changed, extra } = diffLabels(declared, actual);

  for (const line of formatDriftReport({ missing, changed, extra })) {
    console.log(line);
  }

  if (missing.length === 0 && changed.length === 0) {
    console.log(
      `✓ All ${declared.length} declared labels are present and match.`,
    );
    return;
  }

  if (!apply) {
    console.error(
      `\n${missing.length} missing, ${changed.length} out of date. ` +
        'Run `node scripts/sync-labels.mjs --apply` to fix.',
    );
    process.exit(1);
  }

  const present = new Set(actual.map((label) => label.name));
  const failed = [];
  for (const label of [...missing, ...changed]) {
    try {
      applyLabel(label, present.has(label.name), repo);
      console.log(`  applied ${label.name}`);
    } catch (error) {
      // Carry on. One label GitHub refuses should not decide the fate of the
      // rest — stopping here is what produced the half-applied taxonomy in
      // #197, and leaving the remainder unapplied makes the next run's drift
      // report the only record that anything went wrong.
      const detail = String(error.stderr ?? error.message ?? error).trim();
      failed.push(`${label.name}: ${detail.split('\n')[0]}`);
      console.error(`  FAILED ${label.name}`);
    }
  }

  const applied = missing.length + changed.length - failed.length;
  console.log(`\n✓ Applied ${applied} label(s).`);

  if (failed.length > 0) {
    console.error(`\n${failed.length} label(s) could not be applied:`);
    for (const failure of failed) console.error(`  ${failure}`);
    process.exit(1);
  }
}

// Only when invoked directly, so the tests can import the pure functions.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
