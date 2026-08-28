import { parseSteeringInstruction } from './steering-instruction.parser';

/**
 * The deterministic path (#425).
 *
 * The claims worth testing are not "it found some numbers" — they are the ones
 * that decide whether a model is invoked at all, and whether a number in a
 * sentence becomes a label write. Two in particular:
 *
 *  - a sentence the parser does not understand must come back UNCONFIDENT
 *    rather than half-parsed, because a half-parse is what proposes a
 *    destructive diff from an instruction nobody wrote;
 *  - a digit run that is not an issue reference must NOT become one.
 */
describe('parseSteeringInstruction', () => {
  describe('explicit issue numbers, which need no model', () => {
    it('reads a bare list introduced by a scope word', () => {
      const parsed = parseSteeringInstruction('only work on issues 1, 2 and 3');

      expect(parsed.confident).toBe(true);
      expect(parsed.ambiguity).toBeNull();
      expect(parsed.targets.map((t) => t.number)).toEqual([1, 2, 3]);
      expect(parsed.intent).toBe('ready');
      expect(parsed.exclusive).toBe(true);
    });

    it('reads the terse form the issue quotes verbatim', () => {
      // #425 states "only do 1 2 3" is parseable deterministically. If this
      // ever needs a model, the acceptance criterion has been lost.
      const parsed = parseSteeringInstruction('only do 1 2 3');

      expect(parsed.confident).toBe(true);
      expect(parsed.targets.map((t) => t.number)).toEqual([1, 2, 3]);
    });

    it('reads a repository-qualified reference', () => {
      const parsed = parseSteeringInstruction('work on acme/app#12');

      expect(parsed.targets).toEqual([
        {
          kind: 'issue',
          owner: 'acme',
          name: 'app',
          number: 12,
          reference: 'acme/app#12',
        },
      ]);
    });

    it('counts an issue named twice as one issue', () => {
      // Two operations against one issue would double the blast radius, which
      // is the number an operator reads before confirming a destructive change.
      const parsed = parseSteeringInstruction('work on #12 and issue 12');

      expect(parsed.targets).toHaveLength(1);
    });

    it('is a pure function of its argument', () => {
      // The token regex is module-scoped and global. A shared /g regex that
      // keeps its cursor between calls makes the second call disagree with the
      // first, and nothing else in this file would catch it.
      const first = parseSteeringInstruction('only work on #1 and #2');
      const second = parseSteeringInstruction('only work on #1 and #2');

      expect(second).toEqual(first);
      expect(second.targets).toHaveLength(2);
    });
  });

  describe('a number in prose is not an issue reference', () => {
    it('refuses a digit run with no scope word in front of it', () => {
      // The parser's own version of hallucinating an issue number, and worse
      // than the model's because it looks deterministic.
      // Deliberately opens with a FILLER rather than a verb: a probe that
      // opened with an unrecognised word ("fix …") would pass even if the
      // parser armed every number by default, because the unknown word would
      // disarm it again. Mutation-tested — see the pull request.
      const parsed = parseSteeringInstruction('the 404 handler is broken');

      expect(parsed.targets).toEqual([]);
      expect(parsed.ignoredNumbers).toEqual([404]);
      expect(parsed.confident).toBe(false);
    });

    it('takes the armed run and leaves the prose number alone', () => {
      const parsed = parseSteeringInstruction(
        'the 404 handler is broken, only do 1 2 3',
      );

      expect(parsed.targets.map((t) => t.number)).toEqual([1, 2, 3]);
      expect(parsed.ignoredNumbers).toEqual([404]);
    });

    it('says how to name the number it declined to read', () => {
      const parsed = parseSteeringInstruction('the 404 handler is broken');

      expect(parsed.notes.join(' ')).toContain('#404');
    });

    it('always reads a hash-prefixed number, prose or not', () => {
      const parsed = parseSteeringInstruction('the #404 handler is broken');

      expect(parsed.targets.map((t) => t.number)).toEqual([404]);
    });
  });

  describe('"only" is destructive, and its scope is decided here', () => {
    it('separates the else-clause hold from the targets', () => {
      const parsed = parseSteeringInstruction(
        'only work on #1, #2 and #3 and hold everything else',
      );

      expect(parsed.confident).toBe(true);
      expect(parsed.intent).toBe('ready');
      expect(parsed.exclusive).toBe(true);
      expect(parsed.elseIntent).toBe('hold');
    });

    it('un-readies rather than holds when no hold was asked for', () => {
      // "Only work on 1, 2 and 3" is narrower than "and hold everything else".
      // Widening it would put a stronger statement on record than the operator
      // made, and a hold is the harder of the two to undo by accident.
      const parsed = parseSteeringInstruction('only work on #1, #2 and #3');

      expect(parsed.exclusive).toBe(true);
      expect(parsed.elseIntent).toBe('unready');
    });

    it('reads "the rest" as an else-clause too', () => {
      const parsed = parseSteeringInstruction('work on #1 and hold the rest');

      expect(parsed.exclusive).toBe(true);
      expect(parsed.elseIntent).toBe('hold');
    });

    it('does not let "only" next to a hold verb un-ready anything', () => {
      // "Only hold 1 and 2" restricts nothing: holding two issues says nothing
      // about the others, and reading it as "un-ready the rest" would invent a
      // destructive clause the sentence does not contain.
      const parsed = parseSteeringInstruction('only hold #1 and #2');

      expect(parsed.intent).toBe('hold');
      expect(parsed.exclusive).toBe(false);
      expect(parsed.notes.join(' ')).toContain('does not un-ready');
    });
  });

  describe('what it refuses to decide', () => {
    it('reports an epic named in prose rather than guessing', () => {
      const parsed = parseSteeringInstruction(
        'just the auth epic, hold everything else',
      );

      expect(parsed.confident).toBe(false);
      expect(parsed.targets).toEqual([]);
      expect(parsed.ambiguity).toContain('no issue or epic number');
    });

    it('refuses two contradictory verbs with nothing to attach the hold to', () => {
      const parsed = parseSteeringInstruction('release #5 and hold #7');

      expect(parsed.confident).toBe(false);
      expect(parsed.ambiguity).toContain('both');
    });

    it('refuses a bare reference with no verb and no restriction', () => {
      // `#12` alone says nothing about whether to work it or hold it.
      const parsed = parseSteeringInstruction('#12');

      expect(parsed.confident).toBe(false);
      expect(parsed.ambiguity).toContain('no verb');
    });
  });

  describe('epics', () => {
    it('marks a reference introduced by "epic" as an epic', () => {
      const parsed = parseSteeringInstruction('work on epic #419');

      expect(parsed.targets).toEqual([
        {
          kind: 'epic',
          owner: null,
          name: null,
          number: 419,
          reference: '#419',
        },
      ]);
    });

    it('reads a bare number after "epic" as an epic', () => {
      const parsed = parseSteeringInstruction('only run epic 419');

      expect(parsed.targets[0]).toMatchObject({ kind: 'epic', number: 419 });
    });

    it('goes back to issues after a new scope word', () => {
      const parsed = parseSteeringInstruction('work on epic #419, issue #12');

      expect(parsed.targets.map((t) => [t.kind, t.number])).toEqual([
        ['epic', 419],
        ['issue', 12],
      ]);
    });
  });
});
