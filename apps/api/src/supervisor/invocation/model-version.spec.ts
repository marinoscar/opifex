import {
  MODEL_VERSION_FLOOR,
  classifyModelId,
  formatModelVersion,
  parseModelVersion,
  type ModelAdmission,
} from './model-version';
import type { SupervisorModelProvider } from './supervisor-model.config';

/**
 * The version filter, against REAL model ids from both vendors (#393).
 *
 * ## Why the table is the test
 *
 * #393's acceptance criterion asks for "a pure, unit-tested function with a
 * table of real model ids from both vendors — including ids that deliberately
 * do not parse", and the reason it is specified that way is that every
 * plausible bug in this file is a bug about ONE id. A regular expression that
 * reads `claude-haiku-4-5-20251001` as 4.5.20251001, or `gpt-4o-mini-2024-07-18`
 * as version 2024, is not wrong in general — it is wrong about the id that
 * happens to be shaped like that, and it looks perfectly correct against every
 * other row. So the rows are the specification, and none of them is invented:
 * each is an id one of the two vendors has actually published.
 *
 * ## The row type that matters most
 *
 * `version_unrecognised`. Those rows are not "cases we do not handle" — they
 * are the behaviour the epic decided on. A change that made one of them parse
 * would need a reason; a change that made one of them DISAPPEAR would be the
 * failure this whole file exists to prevent, and `model-catalog.service.spec.ts`
 * asserts that half of it against the list the endpoint returns.
 */

interface Row {
  readonly id: string;
  /** `null` where the id deliberately does not parse. */
  readonly version: string | null;
  readonly status: ModelAdmission;
  /** Why this row is in the table at all. */
  readonly because: string;
}

const ANTHROPIC: readonly Row[] = [
  {
    id: 'claude-sonnet-5',
    version: '5.0',
    status: 'admitted',
    because: 'a bare major with no minor is 5.0, not unparseable',
  },
  {
    id: 'claude-opus-4-6',
    version: '4.6',
    status: 'admitted',
    because: 'exactly the floor, and the floor is inclusive',
  },
  {
    id: 'claude-sonnet-4-5-20250929',
    version: '4.5',
    status: 'below_threshold',
    because: 'one minor under the floor, with a date on the end',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    version: '4.5',
    status: 'below_threshold',
    because: 'THE date case: 4.5, never 4.5.20251001',
  },
  {
    id: 'claude-opus-4-1-20250805',
    version: '4.1',
    status: 'below_threshold',
    because: 'a dated point release',
  },
  {
    id: 'claude-opus-4-20250514',
    version: '4.0',
    status: 'below_threshold',
    because: 'a major with a date and no minor',
  },
  {
    id: 'claude-3-5-sonnet-20241022',
    version: null,
    status: 'version_unrecognised',
    because:
      'the pre-4 scheme put the version in the MIDDLE; that scheme is gone, ' +
      'so the id is marked rather than guessed at',
  },
  {
    id: 'claude-3-haiku-20240307',
    version: null,
    status: 'version_unrecognised',
    because: 'the same middle-version scheme, with no minor',
  },
  {
    id: 'claude-3-7-sonnet-latest',
    version: null,
    status: 'version_unrecognised',
    because: 'an alias, which carries no version at all',
  },
];

const OPENAI: readonly Row[] = [
  {
    id: 'gpt-5.6-luna',
    version: '5.6',
    status: 'admitted',
    because: 'a dotted minor followed by a qualifier',
  },
  {
    id: 'gpt-5.4',
    version: '5.4',
    status: 'admitted',
    because: 'exactly the floor, and the floor is inclusive',
  },
  {
    id: 'gpt-5.4-mini',
    version: '5.4',
    status: 'admitted',
    because: 'the size qualifier TRAILS the version on this vendor',
  },
  {
    id: 'gpt-5-pro',
    version: '5.0',
    status: 'below_threshold',
    because:
      'gpt-5 really is older than gpt-5.4; admitting it would get the ' +
      'filter’s own job backwards',
  },
  {
    id: 'gpt-5-mini',
    version: '5.0',
    status: 'below_threshold',
    because: 'the same major, one step under the floor',
  },
  {
    id: 'gpt-4.1',
    version: '4.1',
    status: 'below_threshold',
    because: 'a whole major behind',
  },
  {
    id: 'gpt-4.1-mini',
    version: '4.1',
    status: 'below_threshold',
    because: 'a dotted version with a qualifier, a major behind',
  },
  {
    id: 'gpt-3.5-turbo',
    version: '3.5',
    status: 'below_threshold',
    because: 'the oldest chat id still published',
  },
  {
    id: 'text-embedding-3-small',
    version: '3.0',
    status: 'below_threshold',
    because:
      'a two-word family name, so the anchor is not simply the second segment',
  },
  {
    id: 'whisper-1',
    version: '1.0',
    status: 'below_threshold',
    because:
      'not a chat model at all; the floor removes it without a special case',
  },
  {
    id: 'dall-e-3',
    version: '3.0',
    status: 'below_threshold',
    because: 'a family name containing a dash',
  },
  {
    id: 'gpt-4o',
    version: null,
    status: 'version_unrecognised',
    because: '4o is not a number this scheme can order',
  },
  {
    id: 'gpt-4o-mini-2024-07-18',
    version: null,
    status: 'version_unrecognised',
    because:
      'THE anchor case: an unanchored parser reads 2024 here and admits a ' +
      'superseded model as the newest in the catalogue',
  },
  {
    id: 'o3-mini',
    version: null,
    status: 'version_unrecognised',
    because: 'the o-series puts a digit in the family name itself',
  },
  {
    id: 'daybreak-blue-latest',
    version: null,
    status: 'version_unrecognised',
    because: 'a codename alias, carrying no version anywhere',
  },
  {
    id: 'chat-latest',
    version: null,
    status: 'version_unrecognised',
    because: 'an alias that always points at whatever is current',
  },
];

const TABLE: readonly (Row & { provider: SupervisorModelProvider })[] = [
  ...ANTHROPIC.map((row) => ({ ...row, provider: 'anthropic' as const })),
  ...OPENAI.map((row) => ({ ...row, provider: 'openai' as const })),
];

describe('the supervisor model version filter (#393)', () => {
  describe.each(TABLE)('$provider $id — $because', (row) => {
    it(`parses to ${row.version ?? 'nothing'}`, () => {
      const parsed = parseModelVersion(row.provider, row.id);

      expect(parsed === null ? null : formatModelVersion(parsed)).toBe(
        row.version,
      );
    });

    it(`classifies as ${row.status}`, () => {
      expect(classifyModelId(row.provider, row.id).status).toBe(row.status);
    });
  });

  describe('the table itself', () => {
    it('covers all three states on both vendors, so no arm is untested', () => {
      // Without this, deleting every `version_unrecognised` row would leave a
      // green suite that asserts nothing about the rule the epic actually
      // decided.
      for (const rows of [ANTHROPIC, OPENAI]) {
        const states = new Set(rows.map((row) => row.status));
        expect([...states].sort()).toEqual([
          'admitted',
          'below_threshold',
          'version_unrecognised',
        ]);
      }
    });

    it('names each id once', () => {
      const ids = TABLE.map((row) => `${row.provider}:${row.id}`);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('the floor', () => {
    it('is the one the epic decided: 4.6 and 5.4', () => {
      expect(formatModelVersion(MODEL_VERSION_FLOOR.anthropic)).toBe('4.6');
      expect(formatModelVersion(MODEL_VERSION_FLOOR.openai)).toBe('5.4');
    });

    it('admits the floor itself, because "above 5.4" means 5.4 and newer', () => {
      expect(classifyModelId('openai', 'gpt-5.4').status).toBe('admitted');
      expect(classifyModelId('anthropic', 'claude-opus-4-6').status).toBe(
        'admitted',
      );
    });

    it('rejects one minor under it', () => {
      expect(classifyModelId('openai', 'gpt-5.3').status).toBe(
        'below_threshold',
      );
      expect(classifyModelId('anthropic', 'claude-opus-4-5').status).toBe(
        'below_threshold',
      );
    });

    it('compares major before minor, so 5.0 beats 4.9', () => {
      // The bug this catches is a string comparison, or a `major + minor / 10`
      // that collapses once a minor reaches double digits.
      expect(classifyModelId('anthropic', 'claude-opus-5-0').status).toBe(
        'admitted',
      );
      expect(classifyModelId('anthropic', 'claude-opus-4-9').status).toBe(
        'admitted',
      );
      expect(classifyModelId('anthropic', 'claude-opus-4-10').status).toBe(
        'admitted',
      );
      expect(classifyModelId('openai', 'gpt-4.9').status).toBe(
        'below_threshold',
      );
    });
  });

  describe('an id it cannot read at all', () => {
    it('returns null rather than throwing, on either vendor', () => {
      for (const provider of ['anthropic', 'openai'] as const) {
        expect(parseModelVersion(provider, '')).toBeNull();
        expect(parseModelVersion(provider, '   ')).toBeNull();
        expect(parseModelVersion(provider, '---')).toBeNull();
        expect(parseModelVersion(provider, '20251001')).toBeNull();
      }
    });

    it('is still classified, and the classification is the third state', () => {
      // Not `admitted` (which would send a nonsense id to the provider as if
      // it were current) and not `below_threshold` (which would file it with
      // models whose version IS known). The third state exists so that neither
      // of those lies has to be told.
      expect(classifyModelId('openai', '???').status).toBe(
        'version_unrecognised',
      );
      expect(classifyModelId('openai', '???').version).toBeNull();
    });
  });

  it('reads an id the same way whatever case it arrives in', () => {
    // Defensive rather than observed: every published id is lower case today,
    // and a proxy that upper-cased one should not silently drop it.
    expect(parseModelVersion('openai', 'GPT-5.4')).toEqual({
      major: 5,
      minor: 4,
    });
    expect(parseModelVersion('anthropic', ' claude-opus-4-6 ')).toEqual({
      major: 4,
      minor: 6,
    });
  });
});
