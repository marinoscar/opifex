import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ALL_INPUT_LABELS, ALL_MIRROR_LABELS } from './factory-labels';
import { MODEL_TIER_BY_LABEL, NEEDS_BY_LABEL } from './ignored-labels';
import {
  kindOf,
  MAX_LABEL_DESCRIPTION_LENGTH,
  PROVISIONED_LABELS,
  PROVISIONED_LABEL_NAMES,
  validateDeclaration,
  type DeclaredLabel,
} from './label-taxonomy';

/**
 * The taxonomy in code and the taxonomy in `.github/labels.yml` must agree, in
 * BOTH directions (#415).
 *
 * The API provisions from the code copy — it runs in a container and cannot
 * read the file (see `label-taxonomy.ts`'s header on #382). The developer CLI
 * `scripts/sync-labels.mjs` provisions from the file. Two copies with no check
 * between them is two things that provision different sets, and the difference
 * would show up as a label that exists on the repositories one of them touched
 * and not the other — with nothing anywhere saying which is right.
 */

const labelsYml = readFileSync(
  join(__dirname, '..', '..', '..', '..', '..', '.github', 'labels.yml'),
  'utf8',
);

/**
 * The file, parsed with a regex rather than a YAML library.
 *
 * `yaml` is a dependency of the developer CLI, not of the API, and pulling it
 * into a unit test to read a file with a fixed three-line shape would add a
 * production-adjacent dependency for no gain. `input-labels.spec.ts` already
 * reads this file the same way.
 */
const declaredInFile: DeclaredLabel[] = [
  ...labelsYml.matchAll(
    /^- name: "([^"]+)"\n {2}color: "([^"]+)"\n {2}description: "([^"]*)"/gm,
  ),
].map((match) => ({
  name: match[1],
  color: match[2].toLowerCase(),
  description: match[3],
  // Not read from the file — the file has no such field. Derived, exactly as
  // the code derives it, which is itself part of what is being checked.
  kind: kindOf(match[1]) as DeclaredLabel['kind'],
}));

describe('the declared label taxonomy', () => {
  it('parses the taxonomy file at all', () => {
    // Guards the guard. A parser that matched nothing would make every parity
    // assertion below pass against an empty list — the exact vacuous-green
    // failure `input-labels.spec.ts` already defends against.
    expect(declaredInFile.length).toBeGreaterThanOrEqual(30);
    expect(declaredInFile.map((label) => label.name)).toContain(
      'factory:ready',
    );
  });

  it('declares something to provision', () => {
    expect(PROVISIONED_LABELS.length).toBeGreaterThanOrEqual(15);
  });

  it('declares nothing GitHub would reject', () => {
    // Run over the real declaration, so a 101-character description fails CI
    // rather than a repository half-way through provisioning (#197).
    expect(validateDeclaration(PROVISIONED_LABELS)).toEqual([]);
  });

  it('reports every problem at once rather than the first', () => {
    // The property #197 actually needs. Asserted on a synthetic declaration,
    // because the real one is (and must stay) clean.
    const problems = validateDeclaration([
      {
        name: 'factory:ready',
        color: 'nothex',
        description: '',
        kind: 'input',
      },
      {
        name: 'factory:ready',
        color: 'ffffff',
        description: 'x'.repeat(MAX_LABEL_DESCRIPTION_LENGTH + 1),
        kind: 'input',
      },
    ]);

    expect(problems).toHaveLength(3);
    expect(problems.join('\n')).toContain('not six lower-case hex digits');
    expect(problems.join('\n')).toContain('declared more than once');
    expect(problems.join('\n')).toContain('GitHub allows 100');
  });

  it('rejects a kind that contradicts the name', () => {
    // The `kind` field is convenience, not a second source of truth: the
    // prefix decides, and a hand-written disagreement is a declaration bug.
    expect(
      validateDeclaration([
        {
          name: 'factory/dispatched',
          color: 'ffffff',
          description: '',
          kind: 'input',
        },
      ]),
    ).toEqual([
      expect.stringContaining(
        "declared as 'input' but its prefix says 'mirror'",
      ),
    ]);
  });
});

describe('kindOf', () => {
  it('separates input from mirror by the separator, not by the word', () => {
    // The `:` vs `/` rule is the whole enforcement mechanism (VISION §3.3).
    expect(kindOf('factory:ready')).toBe('input');
    expect(kindOf('factory/dispatched')).toBe('mirror');
  });

  it('classifies routing labels case-insensitively, as the lookups do', () => {
    // `NEEDS_BY_LABEL` and `MODEL_TIER_BY_LABEL` are keyed lower-case, so an
    // operator who typed `Tier:Large` gets the tier — and a classifier that
    // called it `other` would file a label the factory obeys under
    // "organisational".
    expect(kindOf('needs:cost-reporting')).toBe('routing');
    expect(kindOf('Tier:Large')).toBe('routing');
  });

  it('classifies this repository organisational labels as other', () => {
    for (const name of ['bug', 'epic', 'phase:4', 'api', 'docs']) {
      expect(kindOf(name)).toBe('other');
    }
  });
});

describe('parity with .github/labels.yml', () => {
  it('declares every provisioned label in the file, identically', () => {
    // Direction one: the API provisions a label the file has never heard of.
    // The developer CLI would then report it as undeclared drift on every run
    // of this repository's own taxonomy check.
    const byName = new Map(
      declaredInFile.map((label) => [label.name, label] as const),
    );

    for (const label of PROVISIONED_LABELS) {
      expect(byName.get(label.name)).toEqual(label);
    }
  });

  it('provisions every control-loop label the file declares', () => {
    // Direction two, and the one #303 was: a label declared in the file,
    // created by the CLI, applied by an operator who read the taxonomy — and
    // never created by the API, so it is absent on every repository the
    // operator did not personally run the script against.
    const controlLoop = declaredInFile
      .filter((label) => kindOf(label.name) !== 'other')
      .map((label) => label.name);

    expect(controlLoop.sort()).toEqual(
      PROVISIONED_LABELS.map((label) => label.name).sort(),
    );
  });

  it('provisions no organisational label of this repository', () => {
    // The boundary, asserted rather than implied. `phase:4` and `bug` are
    // conventions of THIS repository; creating them in somebody else's issue
    // tracker because they let Opifex watch it is presumptuous, and nothing in
    // the control loop reads them.
    for (const label of PROVISIONED_LABELS) {
      expect(kindOf(label.name)).not.toBe('other');
    }

    expect(PROVISIONED_LABEL_NAMES.has('bug')).toBe(false);
    expect(PROVISIONED_LABEL_NAMES.has('phase:4')).toBe(false);
  });
});

describe('parity with the implemented vocabularies', () => {
  it('provisions every input label the reconciler obeys', () => {
    // `factory:ready` is the whole eligibility signal, and a label that does
    // not exist cannot be put on an issue — #415 in one line.
    const provisioned = PROVISIONED_LABELS.filter(
      (label) => label.kind === 'input',
    ).map((label) => label.name);

    expect(provisioned.sort()).toEqual([...ALL_INPUT_LABELS].sort());
  });

  it('provisions every mirror label Opifex writes', () => {
    // GitHub creates a missing label on first write, with a RANDOM colour and
    // no description, which destroys the warm/cool palette that carries the
    // input/mirror distinction where the separator cannot.
    const provisioned = PROVISIONED_LABELS.filter(
      (label) => label.kind === 'mirror',
    ).map((label) => label.name);

    expect(provisioned.sort()).toEqual([...ALL_MIRROR_LABELS].sort());
  });

  it('provisions every routing label the factory understands', () => {
    const provisioned = PROVISIONED_LABELS.filter(
      (label) => label.kind === 'routing',
    ).map((label) => label.name);

    expect(provisioned.sort()).toEqual(
      [
        ...Object.keys(NEEDS_BY_LABEL),
        ...Object.keys(MODEL_TIER_BY_LABEL),
      ].sort(),
    );
  });
});
