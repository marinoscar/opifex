/**
 * Which scopes a deployment offers, and what each one puts on the wire (#460).
 *
 * The catalogue is a pure function for the reason `steeringChat.ts` is: the
 * option an operator reads before writing labels across somebody else's
 * backlog is the feature, and a pure function can be asserted directly instead
 * of through a render.
 *
 * The cases here are the ones a plausible implementation gets wrong:
 *
 *  - a picker offering only projects, which reaches NOTHING on a deployment
 *    where every repository predates #404 and none has been assigned one —
 *    the failure ADR-0020 decision 3 rules out at the API layer and the epic
 *    says must not be reproduced one layer up;
 *  - two scope fields on one request, which the API answers 400 to;
 *  - a select with one entry on a single-repository deployment, which
 *    ADR-0020 leaves alone deliberately;
 *  - "every observed repository" as the meaning of an empty field rather than
 *    as something chosen, which is the whole of ADR-0020 decision 2.
 */

import { describe, expect, it } from 'vitest';

import {
  UNSCOPED,
  UNSCOPED_ID,
  buildScopeCatalogue,
  findScope,
  unscopedIsUnambiguous,
  type ScopeOption,
} from '../../config/steeringScope';
import {
  OTHER_PROJECT_ID,
  PROJECT_ID,
  projectFixture,
  repositoryFixture,
} from '../mocks/repositories';

/** Registered, in steering's sense: observed and not retired. */
function registered(fullName: string, projectId: string | null = null) {
  const [owner, name] = fullName.split('/');
  return repositoryFixture({
    id: `id-${fullName}`,
    owner,
    name,
    fullName,
    projectId,
    observeEnabled: true,
  });
}

const BILLING = projectFixture({
  id: PROJECT_ID,
  name: 'Billing Platform',
  slug: 'billing-platform',
});
const PLATFORM = projectFixture({
  id: OTHER_PROJECT_ID,
  name: 'Platform',
  slug: 'platform',
});

/** The scope fields on the wire, so "at most one" can be counted. */
const SCOPE_FIELDS = ['repository', 'project', 'allRepositories'] as const;

function scopeFieldsOf(option: ScopeOption): string[] {
  return SCOPE_FIELDS.filter(
    (field) => (option.request as Record<string, unknown>)[field] !== undefined,
  );
}

function labels(options: readonly ScopeOption[]): string[] {
  return options.map((option) => option.label);
}

describe('buildScopeCatalogue', () => {
  it('offers every repository, every project and the unassigned bucket', () => {
    const catalogue = buildScopeCatalogue(
      [BILLING, PLATFORM],
      [
        registered('acme/widgets', PROJECT_ID),
        registered('acme/invoices', PROJECT_ID),
        registered('acme/legacy'),
      ],
    );

    expect(labels(catalogue.options)).toEqual([
      'No scope chosen',
      'Every observed repository',
      'Project: Billing Platform',
      'Project: Platform',
      'No project (1)',
      'acme/widgets',
      'acme/invoices',
      'acme/legacy',
    ]);
    expect(catalogue.onlyRepository).toBeNull();
    expect(catalogue.registered).toBe(3);
  });

  /**
   * The failure mode the epic names explicitly. `projectId` is nullable and on
   * a deployment predating #404 EVERY repository is unassigned, so a picker
   * offering only projects reaches nothing at all.
   */
  it('reaches a repository that is in no project, on both routes to it', () => {
    const catalogue = buildScopeCatalogue(
      [],
      [registered('acme/legacy'), registered('acme/tools')],
    );

    const bucket = catalogue.options.find(
      (option) => option.kind === 'unassigned',
    );
    expect(bucket?.request).toEqual({ project: 'none' });
    expect(bucket?.description).toContain('acme/legacy');

    const direct = catalogue.options.find(
      (option) => option.label === 'acme/legacy',
    );
    expect(direct?.request).toEqual({ repository: 'acme/legacy' });
  });

  it('leaves the bucket out when every repository has a project', () => {
    const catalogue = buildScopeCatalogue(
      [BILLING],
      [
        registered('acme/widgets', PROJECT_ID),
        registered('acme/invoices', PROJECT_ID),
      ],
    );

    expect(
      catalogue.options.some((option) => option.kind === 'unassigned'),
    ).toBe(false);
  });

  /**
   * Every option carries AT MOST ONE of the three fields, so the combination
   * the API answers 400 to has no shape in this module to exist in. Asserted
   * over the whole catalogue rather than option by option: the property is
   * that no reachable choice can violate it.
   */
  it('never puts two scope fields on one request', () => {
    const catalogue = buildScopeCatalogue(
      [BILLING, PLATFORM],
      [
        registered('acme/widgets', PROJECT_ID),
        registered('acme/legacy'),
        registered('acme/tools', OTHER_PROJECT_ID),
      ],
    );

    for (const option of catalogue.options) {
      expect(scopeFieldsOf(option).length).toBeLessThanOrEqual(1);
    }

    expect(
      catalogue.options.map((option) => scopeFieldsOf(option).join('') || '-'),
    ).toEqual([
      '-',
      'allRepositories',
      'project',
      'project',
      'project',
      'repository',
      'repository',
      'repository',
    ]);
  });

  /**
   * ADR-0020 decision 2: the deployment-wide sweep stopped being the meaning
   * of an absent field and became something the operator states.
   */
  it('makes every observed repository a choice, not a default', () => {
    const catalogue = buildScopeCatalogue(
      [],
      [registered('acme/widgets'), registered('acme/legacy')],
    );

    const all = catalogue.options.find(
      (option) => option.kind === 'all-repositories',
    );
    expect(all?.request).toEqual({ allRepositories: true });
    expect(all?.description).toContain('All 2 repositories');

    // And the option that is selected before anybody chooses anything is NOT
    // it. The wide action costs a deliberate selection.
    expect(catalogue.options[0]).toBe(UNSCOPED);
    expect(UNSCOPED.request).toEqual({});
  });

  /**
   * ADR-0020 leaves the single-repository deployment alone: the API resolves a
   * bare `#12` and an "everything else" sweep against it with no scope at all,
   * so a select with one entry would be friction with no risk behind it.
   */
  it('offers no choice at all when exactly one repository is registered', () => {
    const catalogue = buildScopeCatalogue([BILLING], [registered('acme/only')]);

    expect(catalogue.options).toEqual([]);
    expect(catalogue.onlyRepository).toBe('acme/only');
    expect(catalogue.registered).toBe(1);
    expect(unscopedIsUnambiguous(catalogue)).toBe(true);
  });

  it('offers nothing, and names nothing, when nothing is registered', () => {
    const catalogue = buildScopeCatalogue([BILLING], []);

    expect(catalogue.options).toEqual([]);
    expect(catalogue.onlyRepository).toBeNull();
    expect(catalogue.registered).toBe(0);
    // Not "unambiguous": there is nothing to be unambiguous ABOUT, and the
    // composer says so rather than implying an unscoped instruction is fine.
    expect(unscopedIsUnambiguous(catalogue)).toBe(false);
  });

  /** The client-side preview of the API's `empty-scope`, before the trip. */
  it('says when a project would reach nothing', () => {
    const catalogue = buildScopeCatalogue(
      [BILLING, PLATFORM],
      [registered('acme/widgets', PROJECT_ID), registered('acme/legacy')],
    );

    const empty = catalogue.options.find(
      (option) => option.label === 'Project: Platform',
    );
    expect(empty?.description).toContain('would reach nothing');
    // Still offered. The API decides, and a project an operator created is a
    // real thing to have picked and been told about.
    expect(empty?.request).toEqual({ project: OTHER_PROJECT_ID });
  });

  it('names at most three repositories in a description', () => {
    const catalogue = buildScopeCatalogue(
      [],
      [
        registered('acme/a'),
        registered('acme/b'),
        registered('acme/c'),
        registered('acme/d'),
        registered('acme/e'),
      ],
    );

    const bucket = catalogue.options.find(
      (option) => option.kind === 'unassigned',
    );
    expect(bucket?.description).toContain(
      '5 repositories: acme/a, acme/b, acme/c and 2 more.',
    );
  });

  it('is unambiguous unscoped only for exactly one repository', () => {
    expect(
      unscopedIsUnambiguous(
        buildScopeCatalogue(
          [],
          [registered('acme/widgets'), registered('acme/legacy')],
        ),
      ),
    ).toBe(false);
  });
});

describe('findScope', () => {
  it('falls back to unscoped rather than to a stale selection', () => {
    const catalogue = buildScopeCatalogue(
      [],
      [registered('acme/widgets'), registered('acme/legacy')],
    );

    expect(findScope(catalogue.options, 'repository:acme/widgets').label).toBe(
      'acme/widgets',
    );
    // A repository retired since the list was read. Falling back to the wide
    // option, or keeping an id nothing renders, would scope an instruction
    // somewhere the operator can no longer see.
    expect(findScope(catalogue.options, 'repository:acme/gone')).toBe(UNSCOPED);
    expect(findScope([], UNSCOPED_ID)).toBe(UNSCOPED);
  });
});
