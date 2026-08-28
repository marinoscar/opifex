import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LABEL_ACTIONS } from './label-provisioning.service';

/**
 * The never-delete guarantee, asserted against the SOURCE.
 *
 * `reversibility.spec.ts` makes exactly this argument for `GitHubWriteService`
 * and it applies unchanged here: the real enforcement is that no method
 * exists, and a unit test can only call methods that are there. The failure
 * being guarded is somebody ADDING one — a convenience "prune the taxonomy",
 * a tidy-up that removes what drifted rather than fixing it — and no
 * behavioural test can see that, because the behaviour it would break is
 * behaviour nobody wrote a test for.
 *
 * Why deleting is the line: a label removed from a repository is removed from
 * every issue that carried it, silently, and the taxonomy cannot put it back —
 * it knows names, colours and descriptions, and nothing at all about which
 * issues had which label. `scripts/sync-labels.mjs` reached the same
 * conclusion, and adds the asymmetry that settles it: an undeclared label is
 * far more likely to be a human's than a mistake, and the cost of the two
 * possible errors is nowhere near equal.
 */

const source = readFileSync(
  join(__dirname, 'label-provisioning.service.ts'),
  'utf8',
);

/**
 * The same source with its comments removed.
 *
 * Needed for exactly one assertion: this file's header EXPLAINS at length why
 * it does not use `guardedWrite`, so a naive substring check on the full text
 * would fail on the explanation rather than on the call. Grepping the code
 * asserts what the code does; grepping the prose would only assert that nobody
 * wrote down their reasoning.
 */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('the label provisioning surface never deletes', () => {
  const forbiddenMethodNames = [
    'deleteLabel',
    'removeLabel',
    'delete',
    'remove',
    'prune',
    'sync',
    'reconcileLabels',
  ];

  it.each(forbiddenMethodNames)('has no %s adapter', (name) => {
    // A method that does not exist cannot be called by a future mistake, by a
    // misconfigured trust grant, or by a supervisor that has talked itself
    // into tidying up.
    expect(source).not.toMatch(new RegExp(`\\b(async\\s+)?${name}\\s*\\(`));
  });

  it('issues no request with a destructive method', () => {
    // Two methods, and only two: POST to create a label, PATCH to correct one.
    expect(source).not.toContain("method: 'DELETE'");
    expect(source).not.toContain("method: 'PUT'");
    expect(source.match(/method: 'POST'/g) ?? []).toHaveLength(1);
    expect(source.match(/method: 'PATCH'/g) ?? []).toHaveLength(1);
  });

  it('touches no path outside a repository label collection', () => {
    // `/issues`, `/git/refs` and the rest belong to other surfaces under their
    // own guards. This one may reach labels and nothing else.
    const paths = [...source.matchAll(/`\/repos\/[^`]*`/g)].map((m) => m[0]);

    expect(paths.length).toBeGreaterThanOrEqual(2);
    for (const path of paths) {
      expect(path).toContain('/labels');
    }
  });

  it('offers no vocabulary for having deleted something', () => {
    // The report cannot say a label was deleted, so a caller cannot be told
    // one was — which would be the first thing to change if somebody added
    // the capability.
    expect([...LABEL_ACTIONS]).toEqual([
      'none',
      'created',
      'updated',
      'failed',
    ]);
  });

  it('keeps the guard that restricts it to the declared taxonomy', () => {
    // Guards the guard: `assertDeclaredLabel` deleted, or stopped being called
    // before a write, would leave this surface able to create any label at all
    // — and the behavioural specs would still pass, because they only ever
    // pass declared names.
    expect(source).toContain('export function assertDeclaredLabel');
    expect(
      source.match(/assertDeclaredLabel\(label\.name\);/g) ?? [],
    ).toHaveLength(2);
  });

  it('does not reach for the write service kill switch', () => {
    // Not an oversight — the point. `github.writesEnabled` governs whether the
    // factory acts on issues during a tick, and gating operator setup on it
    // would mean the observation week could not be set up without turning on
    // the writes the switch exists to withhold. Stated in the source, and
    // proven behaviourally in `label-provisioning.service.spec.ts`; asserted
    // here so a well-meaning "shouldn't this be guarded too?" has to argue
    // with a test rather than slip through.
    expect(code).not.toContain('guardedWrite');
    expect(code).not.toContain('GitHubWriteService');
    expect(code).not.toContain('writesEnabled');
    // And the explanation is still in the source, so the next reader finds the
    // reasoning rather than an unexplained absence.
    expect(source).toContain('github.writesEnabled');
  });
});
