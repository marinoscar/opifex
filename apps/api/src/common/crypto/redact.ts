/**
 * Masking for anything a secret can reach: audit rows, logs, API responses
 * (#337, epic #332).
 *
 * ## Why this ships before there is a secret to mask
 *
 * `system-settings.service.ts` writes the entire new settings document into
 * `audit_events.meta` on every write. Today that document holds a theme flag
 * and a feature map, so it is harmless. The moment epic #332 puts a credential
 * into a settings document, that same line writes it to the audit log in
 * plaintext — and an audit log is the one table in the system nobody is
 * allowed to go back and rewrite. There is no later fix: a redaction added
 * after the fact protects the next write and none of the ones already on disk.
 *
 * So the ordering is deliberate. The masking lands while the exposure is still
 * theoretical, because it is the only moment at which landing it is free.
 *
 * ## Why the mask is fixed-width
 *
 * `maskSecret` returns a constant run of asterisks, not one per character. A
 * length-preserving mask leaks the length, and a credential's length is a
 * strong fingerprint of its ISSUER — `ghp_` tokens, `sk-ant-` keys and Google
 * client secrets all have characteristic lengths, and a reader of the audit
 * log would learn which kind of credential is in a slot without being able to
 * read it. The last four characters are revealed only above a floor where four
 * characters are a negligible fraction of the whole, which is what makes them
 * useful for "is this the token I just pasted?" without being useful for
 * guessing the rest.
 */

/**
 * How many trailing characters a long value reveals. Four is the industry
 * convention (card PANs, cloud console credential lists) and is enough for a
 * human to match a value against one they hold.
 */
export const REVEALED_SUFFIX_LENGTH = 4;

/**
 * Below this length, nothing is revealed at all.
 *
 * At 16 characters four is a quarter of the value, which is already generous;
 * anything shorter than that is either not a real credential or one weak
 * enough that a quarter of it matters. Erring toward revealing nothing costs
 * only convenience.
 */
export const MIN_LENGTH_FOR_SUFFIX = 16;

/**
 * The fixed-width mask. Its length says nothing about the value's.
 *
 * ASCII rather than a nicer-looking bullet run: this string ends up in a JSONB
 * column, in Pino output, in terminals of unknown encoding and in test
 * assertions, and every one of those is a place a multi-byte character can
 * come back different from how it went in.
 */
export const MASK = '********';

/**
 * Masks a secret for display or storage.
 *
 * Never returns more than the last `REVEALED_SUFFIX_LENGTH` characters of the
 * input, and returns none of them for anything shorter than
 * `MIN_LENGTH_FOR_SUFFIX`. Absent and empty values return the mask too rather
 * than an empty string, so a masked field always LOOKS masked — an empty
 * string in an audit row reads as "this field was cleared", which is a
 * different and possibly untrue claim.
 */
export function maskSecret(value: string | null | undefined): string {
  if (typeof value !== 'string' || value === '') {
    return MASK;
  }

  if (value.length < MIN_LENGTH_FOR_SUFFIX) {
    return MASK;
  }

  return `${MASK}${value.slice(-REVEALED_SUFFIX_LENGTH)}`;
}

/**
 * Field names whose values are masked wherever they appear.
 *
 * Matched as substrings against the field name with `_`, `-` and `.` removed
 * and the whole thing lowercased, so `api_key`, `apiKey`, `API-KEY` and
 * `github.token` all hit the same entry.
 *
 * A denylist is the wrong default in general — it fails open, and the failure
 * is silent. It is used here anyway because the alternative needs the settings
 * registry (#335), which does not exist yet, and because these call sites
 * currently serialise WHOLE DOCUMENTS of unknown shape. `redactSettingsMeta`
 * therefore also takes an explicit `secretKeys` set, and #339 is expected to
 * pass the registry's own list once it has one; this list is the floor, not
 * the ceiling.
 *
 * Bare `key` is deliberately absent: it would swallow `keyVersion`,
 * `settingKey` and `publicKey`, and a mask over a field name is indisting-
 * uishable from a mask over a real secret, so over-masking degrades the audit
 * log's usefulness in a way nobody would notice either.
 */
const SECRET_NAME_FRAGMENTS: readonly string[] = [
  'secret',
  'token',
  'password',
  'passwd',
  'passphrase',
  'credential',
  'apikey',
  'privatekey',
  'signingkey',
  'encryptionkey',
  'accesskey',
  'authorization',
];

function normaliseFieldName(name: string): string {
  return name.toLowerCase().replace(/[-_.\s]/g, '');
}

function isSecretFieldName(
  name: string,
  extraSecretKeys: ReadonlySet<string>,
): boolean {
  const normalised = normaliseFieldName(name);

  if (extraSecretKeys.has(normalised)) {
    return true;
  }

  return SECRET_NAME_FRAGMENTS.some((fragment) =>
    normalised.includes(fragment),
  );
}

export interface RedactOptions {
  /**
   * Extra field names to treat as secret, matched by the same normalisation as
   * the built-in list. Dotted registry keys work as-is: `github.token`
   * normalises to `githubtoken`, and so does a nested `github` → `token`.
   */
  readonly secretKeys?: Iterable<string>;
}

/**
 * How deep the walk goes before it stops and masks wholesale.
 *
 * A settings document is shallow; anything ten levels down is either a bug or
 * a cycle. The cap is what makes this function safe to call on an arbitrary
 * DTO without a cycle set, and the failure direction is masking too much.
 */
const MAX_DEPTH = 10;

const DEPTH_EXCEEDED = '[redacted: nesting too deep]';

/**
 * Redacts a metadata object before it is written to `audit_events.meta`.
 *
 * Walks the whole structure rather than the top level: settings documents are
 * nested (`{ github: { token } }`), and a top-level-only sweep would have
 * looked correct against today's flat test fixtures while passing every real
 * secret straight through.
 *
 * Non-JSON values (functions, symbols, class instances that are not plain
 * objects) are passed through untouched — this is a redactor, not a
 * serialiser, and the Prisma column's JSON contract is the caller's to keep.
 */
export function redactSettingsMeta(
  meta: Record<string, unknown>,
  options: RedactOptions = {},
): Record<string, unknown> {
  const extra = new Set(
    [...(options.secretKeys ?? [])].map((key) => normaliseFieldName(key)),
  );

  return redactObject(meta, extra, 0);
}

function redactObject(
  value: Record<string, unknown>,
  extra: ReadonlySet<string>,
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, child] of Object.entries(value)) {
    out[key] = isSecretFieldName(key, extra)
      ? // Masked whatever it is. A secret field holding an object — a sealed
        // envelope, say — must not be walked into and partially preserved:
        // the field name already said "this subtree is sensitive".
        maskSecretValue(child)
      : redactValue(child, extra, depth + 1);
  }

  return out;
}

/**
 * A secret-named field whose value is not a string still gets masked rather
 * than dropped, so the audit row records that the field was present.
 */
function maskSecretValue(value: unknown): string {
  return typeof value === 'string' ? maskSecret(value) : MASK;
}

function redactValue(
  value: unknown,
  extra: ReadonlySet<string>,
  depth: number,
): unknown {
  if (depth > MAX_DEPTH) {
    return DEPTH_EXCEEDED;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, extra, depth + 1));
  }

  if (isPlainRecord(value)) {
    return redactObject(value, extra, depth);
  }

  return value;
}

/**
 * True for objects worth walking: plain objects and the DTO instances the
 * settings service passes. `Date`, `Buffer` and friends are left alone — they
 * are leaves as far as redaction is concerned, and enumerating a `Buffer`'s
 * indices would be both useless and enormous.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  if (value instanceof Date || Buffer.isBuffer(value)) {
    return false;
  }

  const prototype: unknown = Object.getPrototypeOf(value);

  return (
    prototype === null ||
    prototype === Object.prototype ||
    // A `createZodDto` class instance: one level of prototype, plain data.
    Object.getPrototypeOf(prototype) === Object.prototype
  );
}
