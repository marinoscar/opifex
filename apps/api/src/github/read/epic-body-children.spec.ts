import { parseEpicBodyChildren } from './epic-body-children';

/**
 * The prose parser (#424).
 *
 * Every fixture here is either taken verbatim from a real epic in this
 * repository or is a shape a human plausibly types. The two rules that stop
 * this from being a guessing machine — section-scoped, first-reference-only —
 * each have a test whose fixture is the exact line that motivated the rule.
 */
describe('parseEpicBodyChildren', () => {
  const numbers = (body: string | null) =>
    parseEpicBodyChildren(body).refs.map((r) => r.number);

  describe('the child section', () => {
    it('reads a plain task list under "Child work"', () => {
      expect(
        numbers(['## Child work', '', '- [x] #24', '- [ ] #25'].join('\n')),
      ).toEqual([24, 25]);
    });

    it('accepts "Children", which real epics use', () => {
      // #403 and #391 are both written this way; the template renders
      // "Child work". The drift already exists in the data.
      expect(numbers(['### Children', '- [ ] #404'].join('\n'))).toEqual([404]);
    });

    it('accepts the heading at any level', () => {
      expect(numbers(['###### Child issues', '- [ ] #7'].join('\n'))).toEqual([
        7,
      ]);
    });

    it('stops at the next heading of the same level', () => {
      const body = [
        '### Child work',
        '- [ ] #420',
        '',
        '### Exit criteria',
        '- [ ] #999 must not be a child',
      ].join('\n');

      expect(numbers(body)).toEqual([420]);
    });

    it('keeps subheadings INSIDE the section', () => {
      // #332 groups its children under wave subheadings. Stopping at the next
      // heading of any level would truncate that epic to its first wave.
      const body = [
        '## Child work',
        '#### Wave 0',
        '- [ ] #333',
        '#### Wave 1',
        '- [ ] #335',
        '## Exit criteria',
        '- [ ] #999',
      ].join('\n');

      expect(numbers(body)).toEqual([333, 335]);
    });

    it('ignores a task list with no child section at all', () => {
      // The conservative half of Rule 1. A false child becomes a label write
      // on an unrelated issue, so an epic that does not use the heading
      // resolves to nothing rather than to a guess.
      const parsed = parseEpicBodyChildren(
        ['## Exit criteria', '- [ ] #999 something'].join('\n'),
      );

      expect(parsed.sectionFound).toBe(false);
      expect(parsed.refs).toEqual([]);
    });

    it('distinguishes "no child list" from "an empty child list"', () => {
      expect(parseEpicBodyChildren('## Child work\n\nTBD.').sectionFound).toBe(
        true,
      );
      expect(parseEpicBodyChildren('## Notes\n\n- [ ] #1').sectionFound).toBe(
        false,
      );
    });

    it('does not read a heading inside a fenced code block', () => {
      const body = [
        '## Child work',
        '```md',
        '## Exit criteria',
        '```',
        '- [ ] #12',
      ].join('\n');

      expect(numbers(body)).toEqual([12]);
    });

    it('returns an empty answer for a null or empty body', () => {
      expect(parseEpicBodyChildren(null).sectionFound).toBe(false);
      expect(parseEpicBodyChildren('').refs).toEqual([]);
    });
  });

  describe('the reference in an item', () => {
    it('takes the FIRST reference and ignores later ones on the line', () => {
      // Verbatim from epic #332. #345 is a dependency of #333, and is itself
      // a child listed further down; taking every reference on the line would
      // have made it a child of #333's line instead.
      const body = [
        '### Child work',
        '- [ ] #333 — `docs(adr)`: operator settings resolution *(blocks #345)*',
      ].join('\n');

      expect(numbers(body)).toEqual([333]);
    });

    it('survives bold, code spans and em dashes around the reference', () => {
      // Verbatim shape from epic #419.
      const body = [
        '### Child work',
        '- [ ] #420 — **`fix(runners)`: the runner never passes `--model`.**',
      ].join('\n');

      expect(numbers(body)).toEqual([420]);
    });

    it('reads a cross-repository reference', () => {
      const parsed = parseEpicBodyChildren(
        '## Child work\n- [ ] other-org/other-repo#77 — elsewhere',
      );

      expect(parsed.refs).toEqual([
        expect.objectContaining({
          owner: 'other-org',
          name: 'other-repo',
          number: 77,
        }),
      ]);
    });

    it('reads a full issue URL', () => {
      const parsed = parseEpicBodyChildren(
        '## Child work\n- [ ] https://github.com/acme/app/issues/91',
      );

      expect(parsed.refs).toEqual([
        expect.objectContaining({ owner: 'acme', name: 'app', number: 91 }),
      ]);
    });

    it('leaves owner and name null for a bare reference', () => {
      // Resolved against the epic's own repository by the service, which is
      // the only layer that knows what that is.
      expect(parseEpicBodyChildren('## Child work\n- [ ] #5').refs[0]).toEqual(
        expect.objectContaining({ owner: null, name: null, number: 5 }),
      );
    });

    it('does not treat a word-glued hash as a reference', () => {
      const parsed = parseEpicBodyChildren(
        '## Child work\n- [ ] release v1#2 is not an issue',
      );

      expect(parsed.refs).toEqual([]);
      expect(parsed.unparsed).toEqual(['release v1#2 is not an issue']);
    });

    it('reports a malformed reference instead of dropping it silently', () => {
      // The drift Rule 1 cannot prevent. A human learns their item is
      // invisible to the factory only if something says so.
      const parsed = parseEpicBodyChildren(
        [
          '## Child work',
          '- [ ] #123 — fine',
          '- [ ] issue 456 — no hash, so no reference',
          '- [ ] #  789 — a space after the hash',
        ].join('\n'),
      );

      expect(parsed.refs.map((r) => r.number)).toEqual([123]);
      expect(parsed.unparsed).toEqual([
        'issue 456 — no hash, so no reference',
        '#  789 — a space after the hash',
      ]);
    });

    it('ignores non-task lines in the section', () => {
      // #17's section opens with "All merged in #135." — prose, not a child.
      const body = ['## Child work', 'All merged in #135.', '- [x] #52'].join(
        '\n',
      );

      expect(numbers(body)).toEqual([52]);
    });

    it('ignores a bullet that is not a checkbox', () => {
      expect(
        numbers(
          ['## Child work', '- #61 plain bullet', '- [ ] #62'].join('\n'),
        ),
      ).toEqual([62]);
    });

    it('deduplicates a repeated reference, keeping the first', () => {
      // So the service's visited set never has to call a typo a cycle.
      expect(
        numbers(
          ['## Child work', '- [ ] #8 first', '- [ ] #8 again'].join('\n'),
        ),
      ).toEqual([8]);
    });

    it('does not carry the checkbox state', () => {
      // Deliberate: `- [x]` is one human's bookkeeping and goes stale the
      // moment an issue is reopened. State comes from GitHub or not at all,
      // so there is nothing here to mistake for it.
      const parsed = parseEpicBodyChildren('## Child work\n- [x] #24');

      expect(Object.keys(parsed.refs[0]).sort()).toEqual([
        'name',
        'number',
        'owner',
        'raw',
      ]);
    });
  });
});
