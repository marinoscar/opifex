import { ServiceUnavailableException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Authenticated encryption at rest for operator-supplied secrets (#337, epic
 * #332).
 *
 * This is the first REVERSIBLE cryptography in the repository. Everything that
 * came before it — `pat.service.ts`, `auth.service.ts:534`,
 * `device-auth.service.ts:457` — is unsalted one-way SHA-256 over a token this
 * process generated itself, where an unsalted digest is fine precisely because
 * the input is 256 bits of `randomBytes`. None of that machinery applies here:
 * a GitHub token or a Claude credential has to come back out again, and it was
 * chosen by somebody else.
 *
 * ## Why AES-256-GCM, and why the AAD is not optional
 *
 * GCM is authenticated: `open` cannot return a plaintext that somebody edited
 * in the database, because `final()` verifies the tag over the ciphertext
 * before releasing anything. An unauthenticated mode (CBC, CTR) would decrypt
 * a tampered row into plausible garbage and hand it to a caller, which for a
 * credential means "authenticates as somebody else" rather than "fails".
 *
 * The additional authenticated data is the SETTING KEY, and that is the part
 * worth reading twice. Confidentiality alone does not bind a ciphertext to
 * WHERE IT IS STORED. Without an AAD, a row is a portable blob: anyone who can
 * write the settings table — or restore a stale backup of it — can copy the
 * ciphertext sitting in `github.token` into `supervisor.apiKey`, and it will
 * decrypt cleanly, because it is a perfectly valid ciphertext under the same
 * key. The secret is then in use in a slot its owner never authorised, with no
 * error anywhere. Binding the setting key into the tag makes that copy fail to
 * open, which is the whole reason this parameter is required rather than
 * defaulted.
 *
 * The key version is bound too, so that a future rotation cannot be downgraded
 * by rewriting the version field on a stored row.
 *
 * ## Why an absent key does not fail the boot
 *
 * `config/env.validation.ts` explains at length which variables are worth a
 * startup failure and which are not, and this one lands in the second group
 * with the Google credentials (#138), the database (#161) and `GITHUB_TOKEN`.
 * The test is not importance, it is whether the rest of the service is still
 * telling the truth without it. Without `JWT_SECRET` every authorization
 * decision is void and there is nothing safe left to serve. Without
 * `OPIFEX_SETTINGS_ENCRYPTION_KEY` the API answers every existing request
 * correctly and can say precisely which capability is missing — so it boots,
 * `seal` refuses with a 503 that names the variable, and reads fall back to
 * the environment.
 *
 * ## Why a failed decrypt is NEVER that fallback
 *
 * A stored ciphertext that will not open is a different fact from no stored
 * ciphertext at all, and collapsing the two is the specific failure epic #332
 * exists to remove. If an operator rotated a GitHub token, stored the new one,
 * and the row later fails to open under a restored or mismatched key, falling
 * back to `process.env.GITHUB_TOKEN` would silently resurrect the OLD token —
 * and every call would keep working, which is exactly why nobody would look.
 * So `open` returns a discriminated result whose failure arm has no `plaintext`
 * field at all, and `resolveSecret` gives the error its own `state` that is not
 * `'absent'`. A caller cannot reach a string without saying which case it is
 * handling, and cannot handle "absent" in a way that accidentally swallows
 * "error".
 */

/** The environment variable holding the base64 32-byte data key. */
export const ENCRYPTION_KEY_ENV_VAR = 'OPIFEX_SETTINGS_ENCRYPTION_KEY';

/** AES-256 takes a 32-byte key. */
const KEY_BYTES = 32;

/**
 * 96 bits, the size GCM is specified and optimised for. A different length is
 * legal but sends node down a GHASH-derived path, and every interoperable
 * implementation assumes 12.
 */
const IV_BYTES = 12;

/** The full 128-bit GCM tag. Truncating it would weaken forgery resistance. */
const AUTH_TAG_BYTES = 16;

const ALGORITHM = 'aes-256-gcm';

/**
 * Written into every envelope so a later key rotation is a value change rather
 * than a schema migration: version 2 ciphertexts can sit alongside version 1
 * ones in the same column, and `open` can pick the right key per row.
 */
export const CURRENT_KEY_VERSION = 1;

/** Versions this build knows how to open. Rotation adds to this set. */
const SUPPORTED_KEY_VERSIONS: ReadonlySet<number> = new Set([
  CURRENT_KEY_VERSION,
]);

/**
 * The stored envelope. Every field is base64 except the version, so the whole
 * thing is safe in a JSON column or spread across text columns (#336) without
 * further encoding.
 */
export interface SealedSecret {
  /** Base64 AES-256-GCM ciphertext. */
  readonly ciphertext: string;
  /** Base64 96-bit nonce, fresh per write. */
  readonly iv: string;
  /** Base64 128-bit GCM tag, verified by `open`. */
  readonly authTag: string;
  /** Which data key sealed this. See `CURRENT_KEY_VERSION`. */
  readonly keyVersion: number;
}

/**
 * Why an `open` failed. Reported rather than thrown, because every one of
 * these is a fact about stored data that a caller has to surface to an
 * operator — not an exception to be caught and ignored one frame up.
 */
export type OpenFailureReason =
  /** No usable `OPIFEX_SETTINGS_ENCRYPTION_KEY` in the environment. */
  | 'key_unavailable'
  /** The envelope's own fields are the wrong shape — truncated row, bad JSON. */
  | 'malformed_envelope'
  /** Sealed by a build that knew a key version this one does not. */
  | 'unsupported_key_version'
  /** The tag did not verify: wrong key, edited row, or wrong setting key. */
  | 'decrypt_failed';

/**
 * The result of an `open`.
 *
 * Deliberately a discriminated union and not `string | null`. With a nullable
 * string, `open(...) ?? process.env.GITHUB_TOKEN` compiles, reads naturally,
 * and is the exact bug this module is written to prevent. Here the failure arm
 * carries no `plaintext` at all, so TypeScript refuses to hand a caller a
 * string until it has narrowed on `ok`.
 */
export type OpenResult =
  | { readonly ok: true; readonly plaintext: string }
  | {
      readonly ok: false;
      readonly reason: OpenFailureReason;
      readonly message: string;
    };

/**
 * Thrown by `seal` when there is no usable data key.
 *
 * Extends `ServiceUnavailableException` so the global `HttpExceptionFilter`
 * renders it as a 503 naming the variable with no per-controller mapping, and
 * is still its own class so a caller that wants to react to it specifically
 * (a readiness probe, a settings write path) can `instanceof` it rather than
 * matching on a message string.
 */
export class SettingsEncryptionUnavailableException extends ServiceUnavailableException {
  constructor(problem: string) {
    super(
      `Secrets cannot be stored: ${problem}. Set ${ENCRYPTION_KEY_ENV_VAR} to ` +
        `32 random bytes, base64-encoded (generate one with: ` +
        `openssl rand -base64 32) and restart the API. The API boots without ` +
        `it deliberately, so that everything not involving secrets keeps ` +
        `working; only writing a secret requires it.`,
    );
  }
}

/** Whether the process has a usable data key, and if not, why not. */
export interface EncryptionKeyStatus {
  readonly configured: boolean;
  /** Present exactly when `configured` is false; safe to log and to surface. */
  readonly problem?: string;
}

/**
 * Reads and validates the data key, reporting rather than throwing.
 *
 * Read per call instead of cached at import: a cached key makes the module's
 * behaviour depend on import order, which is untestable without a reset hook
 * and surprising in a process that reads `.env` files after the fact. The cost
 * is one 32-byte base64 decode per operation, which is nothing next to the AES
 * work it precedes.
 */
function loadKey(): { key: Buffer } | { problem: string } {
  const raw = process.env[ENCRYPTION_KEY_ENV_VAR];

  if (raw === undefined || raw.trim() === '') {
    return { problem: `${ENCRYPTION_KEY_ENV_VAR} is not set` };
  }

  // Node's base64 decoder is lenient — it skips characters it does not
  // recognise rather than failing — so the byte length is the only check that
  // actually rejects a truncated or mistyped value.
  const key = Buffer.from(raw.trim(), 'base64');

  if (key.length !== KEY_BYTES) {
    return {
      problem:
        `${ENCRYPTION_KEY_ENV_VAR} must decode to exactly ${KEY_BYTES} bytes, ` +
        `got ${key.length}`,
    };
  }

  return { key };
}

/**
 * Whether secrets can be written right now.
 *
 * For readiness reporting and for the settings UI, which should be able to say
 * "secret storage is unavailable" before an operator types a credential into a
 * form that is going to 503.
 */
export function encryptionKeyStatus(): EncryptionKeyStatus {
  const loaded = loadKey();
  return 'key' in loaded
    ? { configured: true }
    : { configured: false, problem: loaded.problem };
}

/**
 * The additional authenticated data: the setting key this ciphertext belongs
 * to, plus the key version it was sealed under.
 *
 * The version is included so that adding version 2 later cannot be undone by
 * an attacker rewriting `keyVersion` back to 1 on a stored row — the tag would
 * no longer verify. The separator is a colon and the version is always digits,
 * so no `(version, settingKey)` pair can encode to the same bytes as another.
 */
function additionalData(keyVersion: number, settingKey: string): Buffer {
  return Buffer.from(`v${keyVersion}:${settingKey}`, 'utf8');
}

/**
 * A setting key of `''` would bind every ciphertext to the same AAD, quietly
 * reintroducing the portability this module exists to prevent — so it is a
 * hard error in both directions rather than a tolerated edge case. It can only
 * ever be a programming mistake: a setting key comes from the registry, never
 * from user input.
 */
function assertSettingKey(settingKey: string): void {
  if (typeof settingKey !== 'string' || settingKey.trim() === '') {
    throw new Error(
      'seal/open require a non-empty setting key: it is the additional ' +
        'authenticated data that binds a ciphertext to the slot it is stored ' +
        'in, and an empty one would let ciphertexts be moved between slots.',
    );
  }
}

/**
 * Encrypts `plaintext` for storage under `settingKey`.
 *
 * @throws {SettingsEncryptionUnavailableException} 503, naming the variable,
 *   when no data key is configured. Writing a secret is the one operation that
 *   genuinely cannot degrade: there is no honest half-measure between storing
 *   a credential encrypted and storing it in the clear.
 */
export function seal(plaintext: string, settingKey: string): SealedSecret {
  assertSettingKey(settingKey);

  if (typeof plaintext !== 'string' || plaintext === '') {
    // Clearing a secret is deleting the row, not sealing an empty string.
    // Allowing both would give "no secret" two representations, and the second
    // one would open successfully into a credential of length zero.
    throw new Error(
      'seal requires a non-empty plaintext; clear a secret by removing the ' +
        'stored value instead of sealing an empty string.',
    );
  }

  const loaded = loadKey();
  if (!('key' in loaded)) {
    throw new SettingsEncryptionUnavailableException(loaded.problem);
  }

  // Fresh per write, never derived from the setting key or a counter: GCM
  // loses confidentiality AND authenticity outright if a nonce repeats under
  // the same key, and a per-setting nonce would repeat on every update to that
  // setting.
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv(ALGORITHM, loaded.key, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  cipher.setAAD(additionalData(CURRENT_KEY_VERSION, settingKey));

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyVersion: CURRENT_KEY_VERSION,
  };
}

/**
 * Decrypts a stored envelope, verifying that it was sealed for `settingKey`.
 *
 * Never throws for anything that could come from the database — a wrong key, a
 * tampered row, a truncated envelope and a ciphertext lifted from a different
 * setting all come back as `{ ok: false }` with a reason the caller is
 * expected to log and surface. It DOES throw for an empty `settingKey`, which
 * cannot come from data and is always a bug in the caller.
 */
export function open(sealed: SealedSecret, settingKey: string): OpenResult {
  assertSettingKey(settingKey);

  const loaded = loadKey();
  if (!('key' in loaded)) {
    // Note this is a failure and NOT an absence. A configured-but-unopenable
    // secret with the key missing must not read as "no secret is stored", or
    // the caller's env fallback would engage on a row that exists.
    return {
      ok: false,
      reason: 'key_unavailable',
      message: `Cannot decrypt '${settingKey}': ${loaded.problem}`,
    };
  }

  if (!SUPPORTED_KEY_VERSIONS.has(sealed.keyVersion)) {
    return {
      ok: false,
      reason: 'unsupported_key_version',
      message:
        `Cannot decrypt '${settingKey}': it was sealed with key version ` +
        `${String(sealed.keyVersion)}, which this build does not know.`,
    };
  }

  const iv = Buffer.from(sealed.iv ?? '', 'base64');
  const authTag = Buffer.from(sealed.authTag ?? '', 'base64');
  const ciphertext = Buffer.from(sealed.ciphertext ?? '', 'base64');

  if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
    // Checked before `createDecipheriv`, which throws a raw node error for a
    // bad IV length rather than returning one — and an envelope this broken is
    // a storage problem worth naming differently from a failed tag.
    return {
      ok: false,
      reason: 'malformed_envelope',
      message:
        `Cannot decrypt '${settingKey}': stored envelope is malformed ` +
        `(iv ${iv.length}B, tag ${authTag.length}B; expected ` +
        `${IV_BYTES}B and ${AUTH_TAG_BYTES}B).`,
    };
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, loaded.key, iv, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAAD(additionalData(sealed.keyVersion, settingKey));
    decipher.setAuthTag(authTag);

    // `final()` is what verifies the tag; `update()` alone returns unverified
    // plaintext. Both are concatenated, and `final()` is never skipped — a
    // decrypt that returns `update()`'s output without it is the classic way
    // to end up with an authenticated cipher that authenticates nothing.
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return { ok: true, plaintext: plaintext.toString('utf8') };
  } catch {
    // The underlying message is deliberately dropped: it is always some form
    // of "unsupported state or unable to authenticate data", which tells an
    // operator nothing and tells an attacker probing the endpoint slightly
    // more than nothing.
    return {
      ok: false,
      reason: 'decrypt_failed',
      message:
        `Cannot decrypt '${settingKey}': the stored value failed ` +
        `authentication. The encryption key may have changed, or the row may ` +
        `have been altered or copied from a different setting.`,
    };
  }
}

/**
 * Where a resolved secret came from — or why there is none.
 *
 * `'absent'` and `'error'` are separate states on purpose, and that separation
 * is the entire point of this type. The natural shape, `string | null`, forces
 * a caller to represent "stored but unreadable" as `null`, and the very next
 * line anybody writes is `?? process.env.X`. Here `state === 'absent'` is the
 * only case where falling back is correct, and it is impossible to write that
 * check in a way that also catches `state === 'error'`.
 */
export type SecretResolution =
  | {
      readonly state: 'ok';
      readonly source: 'stored' | 'env';
      readonly value: string;
    }
  | { readonly state: 'absent' }
  | {
      readonly state: 'error';
      readonly reason: OpenFailureReason;
      readonly message: string;
    };

/**
 * The read path: prefer the stored secret, fall back to the environment only
 * when nothing is stored, and never fall back on a failure to decrypt.
 *
 * Pure, and takes the environment value as an argument rather than reading
 * `ConfigService`, so that the database overlay (#339) owns wiring and this
 * module owns only the rule.
 */
export function resolveSecret(input: {
  readonly sealed: SealedSecret | null | undefined;
  readonly settingKey: string;
  readonly envValue?: string | null;
}): SecretResolution {
  const { sealed, settingKey, envValue } = input;

  if (sealed) {
    const result = open(sealed, settingKey);
    return result.ok
      ? { state: 'ok', source: 'stored', value: result.plaintext }
      : // No env fallback here, ever. See this module's header: the operator
        // has already rotated away from whatever `envValue` holds, and using
        // it would make a broken deployment look like a working one.
        { state: 'error', reason: result.reason, message: result.message };
  }

  if (envValue !== undefined && envValue !== null && envValue !== '') {
    return { state: 'ok', source: 'env', value: envValue };
  }

  return { state: 'absent' };
}
