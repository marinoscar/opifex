import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { workOrderIdentity } from '../../src/work-orders/work-order-identity';

/**
 * `docs/PROVENANCE.md` claims to be precise enough that #28's CI check can be
 * written from it alone. That claim is only true while the patterns in the
 * document match what the code actually emits.
 *
 * So this reads the regexes OUT of the document and applies them to real
 * generator output. A spec that drifts from the code is worse than no spec:
 * somebody builds the checker from it, the checker rejects valid commits, and
 * then the checker gets disabled rather than the document fixed.
 */
const PROVENANCE = readFileSync(
  join(__dirname, '../../../../docs/PROVENANCE.md'),
  'utf8',
);

/** Pull a documented pattern out of its table row by trailer name. */
function documentedPattern(trailer: string): RegExp {
  const section = PROVENANCE.slice(PROVENANCE.indexOf(`### \`${trailer}:\``));
  const match = /matching `\^([^`]+)\$`/.exec(section.slice(0, 700));

  if (!match) throw new Error(`No pattern documented for ${trailer}:`);
  return new RegExp(`^${match[1]}$`);
}

describe('the documented trailer vocabulary', () => {
  it('documents a pattern for every trailer it defines', () => {
    for (const trailer of [
      'Work-Order',
      'Issue',
      'Decision',
      'Runner',
      'Run-Id',
      'Attempt',
    ]) {
      expect(() => documentedPattern(trailer)).not.toThrow();
    }
  });

  describe('Work-Order:', () => {
    const pattern = documentedPattern('Work-Order');

    it('matches what the generator actually produces', () => {
      // The pin that matters. #62 owns the format; this document describes it,
      // and a description that rejects the real thing is a trap.
      const identity = workOrderIdentity({
        repository: 'opifex',
        issueNumber: 312,
        baseCommit: 'a3f91c2000000000000000000000000000000000',
        attempt: 1,
      });

      expect(identity).toMatch(pattern);
    });

    it('matches a slugged repository name', () => {
      const identity = workOrderIdentity({
        repository: 'my_repo.name',
        issueNumber: 9,
        baseCommit: 'b'.repeat(40),
        attempt: 12,
      });

      expect(identity).toMatch(pattern);
    });

    it.each([
      ['wo_opifex_312_a3f91c2', 'no attempt'],
      ['wo_opifex_312_a3f91c2_1', 'no a prefix on the attempt'],
      ['wo_opifex_312_A3F91C2_a1', 'an uppercase commit'],
      ['wo_opifex_312_a3f91c_a1', 'a six-character commit'],
      ['WO_opifex_312_a3f91c2_a1', 'the wrong case on the prefix'],
    ])('rejects %s (%s)', (candidate) => {
      expect(candidate).not.toMatch(pattern);
    });
  });

  describe('Issue:', () => {
    const pattern = documentedPattern('Issue');

    it('accepts a same-repository reference', () => {
      expect('#312').toMatch(pattern);
    });

    it.each(['312', 'issue #312', '#', '#0312abc'])(
      'rejects %s',
      (candidate) => {
        expect(candidate).not.toMatch(pattern);
      },
    );
  });

  describe('Decision:', () => {
    const pattern = documentedPattern('Decision');

    it('accepts the ADR numbering this repository actually uses', () => {
      for (const number of ['0001', '0005', '0006']) {
        expect(`ADR-${number}`).toMatch(pattern);
      }
    });

    it.each(['ADR-1', 'ADR-00042', 'adr-0001', '0001'])(
      'rejects %s',
      (candidate) => {
        expect(candidate).not.toMatch(pattern);
      },
    );
  });

  describe('Runner:', () => {
    const pattern = documentedPattern('Runner');

    it('accepts a runner key at a version', () => {
      expect('claude-code-local@2.1.223').toMatch(pattern);
    });

    it('accepts the fake runner, which is a real registrable key', () => {
      expect('fake-runner@0.0.0').toMatch(pattern);
    });

    it.each(['claude-code-local', '@2.1.223', 'Claude-Code@1.0'])(
      'rejects %s',
      (candidate) => {
        expect(candidate).not.toMatch(pattern);
      },
    );
  });

  describe('Run-Id:', () => {
    const pattern = documentedPattern('Run-Id');

    it('accepts a UUID of the shape the run rows use', () => {
      expect('018f2c31-7a4e-7c3b-9f21-4d5e6a7b8c9d').toMatch(pattern);
    });

    it('rejects a runner-chosen external id', () => {
      // #60's finding, restated as a guard: the seam's externalId is opaque
      // and is NOT what goes here.
      expect('fake-018f2c31-7a4e-7c3b-9f21-4d5e6a7b8c9d').not.toMatch(pattern);
    });
  });

  describe('Attempt:', () => {
    const pattern = documentedPattern('Attempt');

    it('accepts a positive integer', () => {
      expect('1').toMatch(pattern);
      expect('12').toMatch(pattern);
    });

    it.each(['0', '-1', '01', '1.5'])('rejects %s', (candidate) => {
      expect(candidate).not.toMatch(pattern);
    });
  });

  describe('what the document commits to', () => {
    it('requires Issue: absolutely of agent-authored commits, and validates it whenever present', () => {
      // Agent-authored: no escape hatch — a work order has no other way to
      // name its issue. Human-authored: recommended rather than required,
      // because the PR's own closing keyword can carry the same edge — but
      // validated wherever it does appear, so a present-but-malformed
      // Issue: is still a hole in the graph regardless of who wrote it.
      expect(PROVENANCE).toMatch(
        /\|\s*`Issue:`\s*\|\s*\*\*required\*\*\s*\|\s*recommended, validated if present\s*\|/,
      );
    });

    it.each(['Work-Order', 'Runner', 'Run-Id', 'Attempt'])(
      'forbids %s: on a human-authored commit',
      (trailer) => {
        expect(PROVENANCE).toMatch(
          new RegExp(
            `\\|\\s*\`${trailer}:\`\\s*\\|\\s*\\*\\*required\\*\\*\\s*\\|\\s*must be absent\\s*\\|`,
          ),
        );
      },
    );

    it.each(['Cost:', 'Tokens:', 'Duration:', 'Elapsed:'])(
      'defines no %s trailer — identity only',
      (forbidden) => {
        // Anything in a commit message is immutable, which makes it the wrong
        // home for a number that might turn out to be measured wrongly.
        expect(PROVENANCE).not.toContain(`### \`${forbidden}\``);
      },
    );

    it('says which side wins when Attempt: and Work-Order: disagree', () => {
      // They are deliberately redundant, so the tie-break has to be stated
      // rather than left to whoever writes the checker.
      // Whitespace-collapsed: the sentence wraps in the source, and a test
      // that breaks on reflowing a paragraph teaches people to stop editing
      // the document.
      expect(PROVENANCE.replace(/\s+/g, ' ')).toContain(
        '`Work-Order:` is authoritative',
      );
    });

    it('names squash merges as the likely hole', () => {
      expect(PROVENANCE).toContain('Squash merges');
    });
  });
});
