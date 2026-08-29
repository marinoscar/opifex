import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Every write to `audit_events` has declared what it does about secrets (#361).
 *
 * ## The failure this guards against
 *
 * #337 found `system-settings.service.ts` writing a whole settings document
 * into `audit_events.meta` verbatim and fixed it. #361 found two more sites
 * with the same shape — `users.service.ts` writing the raw `UpdateUserDto`,
 * `storage/objects/objects.service.ts` writing caller-supplied object
 * metadata — and fixed those. Three findings, one at a time, each by somebody
 * looking. The failure mode is not any one of those sites. It is that **the
 * next sink somebody adds forgets**, and nothing notices, and an audit log is
 * the one table nobody is allowed to go back and rewrite: a redaction added
 * after the leak protects the next write and none of the ones on disk.
 *
 * ## Why this is a test and not a shared audit-write helper
 *
 * #361 asks the question directly, so here is the answer and the working.
 *
 * **There is no shared audit-write helper today.** There are twelve
 * `auditEvent.create` calls across eleven files. Four services (users,
 * allowlist, storage objects, system settings) each grew their OWN private
 * `createAuditEvent`; the other eight write to Prisma inline. Introducing a
 * central one means a new module wired into eleven others and twelve call
 * sites rewritten, across cockpit, autonomy, supervisor, repositories,
 * steering and auth — a diff whose risk is concentrated in areas that have
 * nothing to do with this bug.
 *
 * That cost would still be worth paying if a central helper actually closed
 * the hole. It does not, and the reason is measurable rather than
 * theoretical. `interactive-session.guard.ts` records
 * `credentialKind: 'pat' | 'device' | ...` — which KIND of non-interactive
 * credential was refused, which is the entire point of the row. Run that meta
 * through `redactSettingsMeta` and it comes back `credentialKind: '********'`:
 * the field name normalises to `credentialkind`, which contains `credential`,
 * which is on the denylist. So a helper that redacted unconditionally would
 * need a per-call opt-out on the day it shipped — and an opt-out somebody
 * forgets to NOT pass is the same forgettable act as a redaction somebody
 * forgets to add, only inverted and harder to see in review. That is the cost
 * #361 names as "an audit row can no longer record a value that merely looks
 * secret-shaped", made concrete: it is not hypothetical, it is one existing
 * row today.
 *
 * So the redaction stays at each service's existing choke point, where it can
 * be right for that site's data, and **the forgetting is what gets
 * mechanised**. This test enumerates every audit sink in the source and
 * requires each one to appear in `SINK_DISPOSITIONS` below with a stated
 * disposition. A new sink fails until its author writes down which of the
 * three it is — which is a thirty-second act with the payload in front of
 * them, and impossible to do accidentally.
 *
 * It is deliberately blunt, in the manner of `supervisor-isolation.spec.ts`:
 * it asserts over the SOURCE, because a behaviour test only ever covers the
 * paths somebody thought to write.
 *
 * ## When this test fails
 *
 * You added or moved an audit write. Do not delete the entry that is now
 * wrong; look at the `meta` you are about to persist and add a line to
 * `SINK_DISPOSITIONS` saying which of these it is:
 *
 * - `redacted` — the meta can contain caller- or config-supplied KEYS whose
 *   names are unknown ahead of time. Pass it through `redactSettingsMeta`.
 *   The test checks that you actually did.
 * - `fixed-shape` — every field name is written literally in the source and
 *   every value is server-derived. Nothing a caller controls reaches the row.
 * - `free-text` — the meta carries caller- or model-supplied prose under a
 *   fixed field name. Field-name redaction buys nothing here (see
 *   `issue-gate.service.ts` below); the residual risk is stated and accepted.
 */

const API_SRC = join(__dirname, '..', '..');

/** The Prisma call every audit write goes through, on `this.prisma` or a `tx`. */
const AUDIT_WRITE = /\bauditEvent\.create\s*\(/;

type Disposition = 'redacted' | 'fixed-shape' | 'free-text';

interface SinkDisposition {
  readonly disposition: Disposition;
  /** Why that disposition is the right one for this site's payload. */
  readonly reason: string;
}

/**
 * Every file in `apps/api/src` that writes an `audit_events` row.
 *
 * Keys are paths relative to `apps/api/src`, with forward slashes. An
 * ALLOWLIST rather than a blocklist, for the same reason
 * `supervisor-isolation.spec.ts` uses one: the thing being guarded against is
 * a site nobody thought to forbid.
 */
const SINK_DISPOSITIONS: Readonly<Record<string, SinkDisposition>> = {
  'users/users.service.ts': {
    disposition: 'redacted',
    reason:
      'updateUser writes { changes: dto } — the raw UpdateUserDto off the ' +
      'wire. Harmless while that DTO is displayName and isActive; the first ' +
      'credential-bearing user field would land in the log in the clear (#361).',
  },
  'storage/objects/objects.service.ts': {
    disposition: 'redacted',
    reason:
      'updateMetadata writes { metadataChanges: dto.metadata }, and a storage ' +
      "object's metadata is arbitrary caller-supplied JSON — a client can put " +
      'a token in it (#361).',
  },
  'settings/system-settings/system-settings.service.ts': {
    disposition: 'redacted',
    reason:
      'Both callers hand over the ENTIRE new settings document, whose shape ' +
      'epic #332 is actively adding credentials to (#337).',
  },
  'settings/operator-settings/operator-settings.service.ts': {
    disposition: 'redacted',
    reason:
      'Writes the before and after values of an operator setting, which for a ' +
      'secret-marked key IS a credential. Passes secretKeys: [from, to] ' +
      'because the field names carrying the value say nothing about it (#337).',
  },
  'allowlist/allowlist.service.ts': {
    disposition: 'fixed-shape',
    reason:
      'Both callers write { email } and nothing else. An email address is the ' +
      'subject of the row, not a payload echoed into it.',
  },
  'cockpit/queue-steering.service.ts': {
    disposition: 'fixed-shape',
    reason:
      'Identity, repository, issue number, label, outcome and the write plan ' +
      '— all derived from the work order and the server-side plan.',
  },
  'autonomy/never-trustable.service.ts': {
    disposition: 'fixed-shape',
    reason:
      'Rule ids, refusal reasons and effects, all from the rule table, plus ' +
      'three server-side ids.',
  },
  'auth/guards/interactive-session.guard.ts': {
    disposition: 'fixed-shape',
    reason:
      'Records bodyKeys — KEYS ONLY, NEVER VALUES — precisely because a body ' +
      'on the operator-settings route may carry a credential. Note that ' +
      'redacting this row would MASK credentialKind, which is the fact the ' +
      'row exists to record: see this file’s header.',
  },
  'repositories/repositories.service.ts': {
    disposition: 'free-text',
    reason:
      'Fixed shape apart from reason: dto.reason, a 500-character operator ' +
      'note on a retire/un-retire. Free text typed by an admin about a ' +
      'repository; no field name for redaction to match on.',
  },
  'steering/steering.service.ts': {
    disposition: 'free-text',
    reason:
      'Carries instruction: dto.instruction — the operator’s own words, which ' +
      'is the point of the row ("who instructed this, in these words").',
  },
  'github/write/issue-gate.service.ts': {
    disposition: 'free-text',
    reason:
      'Records candidate.title, which is MODEL-GENERATED text, so a ' +
      'supervisor proposal quoting a credential would carry it — the marginal ' +
      'case #361 names. Left as-is deliberately and NOT fixed here: ' +
      'redactSettingsMeta matches field NAMES, and "title" is not secret-' +
      'shaped, so applying it would mask nothing and only look like a fix. ' +
      'Catching a credential quoted inside prose needs value-pattern ' +
      'detection (ghp_…, sk-ant-…), which is a different tool and its own ' +
      'issue.',
  },
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }

  return out;
}

function relativeKey(file: string): string {
  return relative(API_SRC, file).split(sep).join('/');
}

describe('audit_events sinks (#361)', () => {
  const files = sourceFiles(API_SRC);

  const sinks = files
    .filter((file) => AUDIT_WRITE.test(readFileSync(file, 'utf8')))
    .map(relativeKey)
    .sort();

  it('finds the audit sinks at all', () => {
    // Guards every assertion below from passing vacuously over an empty list,
    // which is how a structural test quietly stops testing anything.
    expect(sinks.length).toBeGreaterThan(5);
  });

  it('has a declared disposition for every sink in the source', () => {
    // If this fails on a file you just added: see this file's header. The fix
    // is a line in SINK_DISPOSITIONS, not a deletion here.
    const undeclared = sinks.filter((sink) => !(sink in SINK_DISPOSITIONS));

    expect(undeclared).toEqual([]);
  });

  it('declares no sink that no longer exists', () => {
    // The other direction, so a file that is moved or loses its audit write
    // does not leave a stale entry vouching for code that is gone.
    const stale = Object.keys(SINK_DISPOSITIONS).filter(
      (declared) => !sinks.includes(declared),
    );

    expect(stale).toEqual([]);
  });

  const redacted = Object.entries(SINK_DISPOSITIONS)
    .filter(([, entry]) => entry.disposition === 'redacted')
    .map(([file]) => file);

  it.each(redacted)('%s actually calls redactSettingsMeta', (file) => {
    // The disposition is a claim; this is the check that it is true. Without
    // it, "redacted" would be a comment, and a comment is the mechanism that
    // failed three times already.
    expect(readFileSync(join(API_SRC, file), 'utf8')).toMatch(
      /redactSettingsMeta\s*\(/,
    );
  });

  it('gives every sink a stated reason', () => {
    // A disposition with no reasoning behind it is a rubber stamp. Length is a
    // crude proxy for thought, and a crude proxy is enough to stop an empty
    // string being pasted in to make the suite green.
    const unreasoned = Object.entries(SINK_DISPOSITIONS)
      .filter(([, entry]) => entry.reason.trim().length < 40)
      .map(([file]) => file);

    expect(unreasoned).toEqual([]);
  });
});
