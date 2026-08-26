import { ServiceUnavailableException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  CURRENT_KEY_VERSION,
  ENCRYPTION_KEY_ENV_VAR,
  SealedSecret,
  SettingsEncryptionUnavailableException,
  encryptionKeyStatus,
  open,
  resolveSecret,
  seal,
} from './secret-box';

/**
 * The two setting keys used throughout. They differ only in the slot, which is
 * the point: a ciphertext for one must not open under the other.
 */
const GITHUB_KEY = 'github.token';
const SUPERVISOR_KEY = 'supervisor.apiKey';

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');

const GITHUB_TOKEN = 'github_pat_11ABCDEFG0abcdefghijKLMNOPqrstuvwxyz012345';

function useKey(value: string | undefined): void {
  if (value === undefined) {
    delete process.env[ENCRYPTION_KEY_ENV_VAR];
  } else {
    process.env[ENCRYPTION_KEY_ENV_VAR] = value;
  }
}

describe('secret-box', () => {
  const originalKey = process.env[ENCRYPTION_KEY_ENV_VAR];

  beforeEach(() => {
    useKey(KEY_A);
  });

  afterAll(() => {
    useKey(originalKey);
  });

  describe('seal / open round-trip', () => {
    it('returns the original plaintext', () => {
      const sealed = seal(GITHUB_TOKEN, GITHUB_KEY);
      const result = open(sealed, GITHUB_KEY);

      expect(result).toEqual({ ok: true, plaintext: GITHUB_TOKEN });
    });

    it('round-trips multi-byte characters without corrupting them', () => {
      // A credential is normally ASCII, but a settings value is not
      // necessarily one, and a utf8/latin1 mismatch in either direction would
      // only ever show up here.
      const value = 'contraseña-🔐-秘密-value-long-enough';

      const result = open(seal(value, GITHUB_KEY), GITHUB_KEY);

      expect(result).toEqual({ ok: true, plaintext: value });
    });

    it('never stores the plaintext anywhere in the envelope', () => {
      const sealed = seal(GITHUB_TOKEN, GITHUB_KEY);

      expect(JSON.stringify(sealed)).not.toContain(GITHUB_TOKEN);
      // Not even a recognisable prefix: a ciphertext that leaked `github_pat_`
      // would tell a reader of the table which issuer the credential is from.
      expect(JSON.stringify(sealed)).not.toContain('github_pat_');
    });

    it('uses a fresh 96-bit IV per write, so equal plaintexts differ', () => {
      const first = seal(GITHUB_TOKEN, GITHUB_KEY);
      const second = seal(GITHUB_TOKEN, GITHUB_KEY);

      expect(first.iv).not.toEqual(second.iv);
      expect(Buffer.from(first.iv, 'base64')).toHaveLength(12);
      // The consequence that matters: a reader of the table cannot tell that
      // two settings hold the same credential.
      expect(first.ciphertext).not.toEqual(second.ciphertext);
    });

    it('stores a 128-bit auth tag and the current key version', () => {
      const sealed = seal(GITHUB_TOKEN, GITHUB_KEY);

      expect(Buffer.from(sealed.authTag, 'base64')).toHaveLength(16);
      expect(sealed.keyVersion).toBe(CURRENT_KEY_VERSION);
    });

    it('refuses to seal an empty plaintext, so "no secret" has one shape', () => {
      expect(() => seal('', GITHUB_KEY)).toThrow(/non-empty plaintext/);
    });

    it('refuses an empty setting key rather than binding to an empty AAD', () => {
      expect(() => seal(GITHUB_TOKEN, '')).toThrow(/non-empty setting key/);
      expect(() => open(seal(GITHUB_TOKEN, GITHUB_KEY), '  ')).toThrow(
        /non-empty setting key/,
      );
    });
  });

  describe('tampering', () => {
    it('fails to open a ciphertext with a flipped bit, rather than returning garbage', () => {
      const sealed = seal(GITHUB_TOKEN, GITHUB_KEY);
      const bytes = Buffer.from(sealed.ciphertext, 'base64');
      bytes[0] ^= 0x01;

      const result = open(
        { ...sealed, ciphertext: bytes.toString('base64') },
        GITHUB_KEY,
      );

      expect(result.ok).toBe(false);
      // Asserted on the union rather than on `plaintext`, because the failure
      // arm has no `plaintext` to assert on -- which is the guarantee.
      expect(result).not.toHaveProperty('plaintext');
      if (!result.ok) expect(result.reason).toBe('decrypt_failed');
    });

    it('fails to open when the auth tag is replaced', () => {
      const sealed = seal(GITHUB_TOKEN, GITHUB_KEY);

      const result = open(
        { ...sealed, authTag: randomBytes(16).toString('base64') },
        GITHUB_KEY,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('decrypt_failed');
    });

    it('fails to open when the IV is swapped for another write of the same value', () => {
      const sealed = seal(GITHUB_TOKEN, GITHUB_KEY);
      const other = seal(GITHUB_TOKEN, GITHUB_KEY);

      const result = open({ ...sealed, iv: other.iv }, GITHUB_KEY);

      expect(result.ok).toBe(false);
    });

    it('reports a truncated envelope as malformed rather than crashing', () => {
      const sealed = seal(GITHUB_TOKEN, GITHUB_KEY);

      const result = open({ ...sealed, iv: 'AAAA' }, GITHUB_KEY);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('malformed_envelope');
    });

    it('refuses a key version it does not know, instead of trying the current key', () => {
      const sealed = seal(GITHUB_TOKEN, GITHUB_KEY);

      const result = open({ ...sealed, keyVersion: 99 }, GITHUB_KEY);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('unsupported_key_version');
    });

    it('fails to open under a different encryption key', () => {
      const sealed = seal(GITHUB_TOKEN, GITHUB_KEY);

      useKey(KEY_B);
      const result = open(sealed, GITHUB_KEY);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('decrypt_failed');
    });
  });

  /**
   * The AAD tests. These are the ones that would pass vacuously if written
   * carelessly -- a round-trip test passes whether or not `setAAD` is called
   * at all -- so each asserts that an operation which WOULD succeed without
   * the AAD in fact fails.
   */
  describe('additional authenticated data binds a ciphertext to its slot', () => {
    it('does not open a github.token ciphertext under supervisor.apiKey', () => {
      // The attack in full: the operator's GitHub token, moved by anyone able
      // to write the settings table into the slot the supervisor reads. Same
      // encryption key, same envelope, byte-for-byte identical row.
      const sealed = seal(GITHUB_TOKEN, GITHUB_KEY);

      const moved = open(sealed, SUPERVISOR_KEY);

      expect(moved.ok).toBe(false);
      if (!moved.ok) expect(moved.reason).toBe('decrypt_failed');

      // And the control: the same envelope still opens in its own slot, so the
      // failure above is the AAD and not a broken envelope.
      expect(open(sealed, GITHUB_KEY)).toEqual({
        ok: true,
        plaintext: GITHUB_TOKEN,
      });
    });

    it('does not open under a setting key that merely differs in case or shape', () => {
      const sealed = seal(GITHUB_TOKEN, GITHUB_KEY);

      // Near misses, because a sloppier binding -- lowercasing, stripping
      // punctuation, comparing prefixes -- would let these through.
      for (const nearMiss of [
        'github.Token',
        'github_token',
        'github.token ',
        'github.tokens',
        'github.tok',
      ]) {
        const result = open(sealed, nearMiss);
        expect(result.ok).toBe(false);
      }
    });

    it('refuses a rewritten keyVersion before it ever reaches the cipher', () => {
      const sealed: SealedSecret = seal(GITHUB_TOKEN, GITHUB_KEY);

      // STATED HONESTLY, because mutation testing caught this one passing for
      // the wrong reason: what rejects version 2 today is the supported-version
      // check, NOT the AAD. `keyVersion` is inside the additional data, so a
      // rewritten version cannot be used to steer `open` at a different key
      // once a second version exists -- but with exactly one supported version
      // there is no way to exercise that from outside the module, and a test
      // asserting it here would pass whether or not the version were bound.
      // The case becomes real, and should be added, when rotation lands.
      const result = open({ ...sealed, keyVersion: 2 }, GITHUB_KEY);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('unsupported_key_version');
    });
  });

  describe('with no encryption key configured', () => {
    beforeEach(() => {
      useKey(undefined);
    });

    it('reports the gap rather than throwing at import or status time', () => {
      // The boot-does-not-fail guarantee, expressed the only way a unit test
      // can: this module is imported and usable with no key present, and says
      // so when asked.
      expect(encryptionKeyStatus()).toEqual({
        configured: false,
        problem: `${ENCRYPTION_KEY_ENV_VAR} is not set`,
      });
    });

    it('answers a secret write with a 503 that names the variable', () => {
      let thrown: unknown;
      try {
        seal(GITHUB_TOKEN, GITHUB_KEY);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(SettingsEncryptionUnavailableException);
      expect(thrown).toBeInstanceOf(ServiceUnavailableException);
      expect((thrown as ServiceUnavailableException).getStatus()).toBe(503);
      expect((thrown as Error).message).toContain(ENCRYPTION_KEY_ENV_VAR);
      // The message has to be actionable on its own: an operator reading a 503
      // body should not have to find the source to learn what to generate.
      expect((thrown as Error).message).toContain('openssl rand -base64 32');
    });

    it('rejects a key that does not decode to 32 bytes, naming the length', () => {
      useKey(randomBytes(16).toString('base64'));

      expect(encryptionKeyStatus()).toEqual({
        configured: false,
        problem: `${ENCRYPTION_KEY_ENV_VAR} must decode to exactly 32 bytes, got 16`,
      });
      expect(() => seal(GITHUB_TOKEN, GITHUB_KEY)).toThrow(
        SettingsEncryptionUnavailableException,
      );
    });

    it('treats a stored ciphertext it cannot open as an error, not an absence', () => {
      useKey(KEY_A);
      const sealed = seal(GITHUB_TOKEN, GITHUB_KEY);
      useKey(undefined);

      const result = open(sealed, GITHUB_KEY);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('key_unavailable');
    });
  });

  describe('resolveSecret', () => {
    it('prefers the stored secret over the environment value', () => {
      const sealed = seal(GITHUB_TOKEN, GITHUB_KEY);

      expect(
        resolveSecret({
          sealed,
          settingKey: GITHUB_KEY,
          envValue: 'stale-env-token-value',
        }),
      ).toEqual({ state: 'ok', source: 'stored', value: GITHUB_TOKEN });
    });

    it('falls back to the environment only when nothing is stored', () => {
      expect(
        resolveSecret({
          sealed: null,
          settingKey: GITHUB_KEY,
          envValue: 'env-token',
        }),
      ).toEqual({ state: 'ok', source: 'env', value: 'env-token' });
    });

    it('reports absence when neither a row nor an environment value exists', () => {
      expect(resolveSecret({ sealed: null, settingKey: GITHUB_KEY })).toEqual({
        state: 'absent',
      });

      // An empty env var is absence, not a credential of length zero.
      expect(
        resolveSecret({ sealed: null, settingKey: GITHUB_KEY, envValue: '' }),
      ).toEqual({ state: 'absent' });
    });

    /**
     * The central guarantee of the module, stated three ways because a single
     * assertion here would be easy to satisfy by accident.
     */
    describe('a decrypt failure is never an environment fallback', () => {
      const STALE_ENV_TOKEN = 'github_pat_ROTATED_AWAY_FROM_LONG_AGO_0000';

      it('does not resurrect the environment value when the key is wrong', () => {
        const sealed = seal(GITHUB_TOKEN, GITHUB_KEY);
        useKey(KEY_B);

        const result = resolveSecret({
          sealed,
          settingKey: GITHUB_KEY,
          envValue: STALE_ENV_TOKEN,
        });

        expect(result.state).toBe('error');
        expect(result).not.toHaveProperty('value');
        expect(JSON.stringify(result)).not.toContain(STALE_ENV_TOKEN);
      });

      it('does not resurrect the environment value when the row was tampered with', () => {
        const sealed = seal(GITHUB_TOKEN, GITHUB_KEY);
        const bytes = Buffer.from(sealed.ciphertext, 'base64');
        bytes[bytes.length - 1] ^= 0xff;

        const result = resolveSecret({
          sealed: { ...sealed, ciphertext: bytes.toString('base64') },
          settingKey: GITHUB_KEY,
          envValue: STALE_ENV_TOKEN,
        });

        expect(result).toMatchObject({
          state: 'error',
          reason: 'decrypt_failed',
        });
        expect(result).not.toHaveProperty('value');
      });

      it('does not resurrect the environment value when the key is missing', () => {
        // The most likely real-world shape of this: an operator sets the key,
        // stores a secret, and a later deploy loses the variable. Falling back
        // here would make the deployment look healthy on a credential the
        // operator believes they replaced.
        const sealed = seal(GITHUB_TOKEN, GITHUB_KEY);
        useKey(undefined);

        const result = resolveSecret({
          sealed,
          settingKey: GITHUB_KEY,
          envValue: STALE_ENV_TOKEN,
        });

        expect(result).toMatchObject({
          state: 'error',
          reason: 'key_unavailable',
        });
        expect(result).not.toHaveProperty('value');
      });

      it('keeps error distinct from absent, so one check cannot swallow the other', () => {
        const sealed = seal(GITHUB_TOKEN, GITHUB_KEY);
        useKey(KEY_B);

        const failed = resolveSecret({ sealed, settingKey: GITHUB_KEY });
        const missing = resolveSecret({ sealed: null, settingKey: GITHUB_KEY });

        expect(failed.state).toBe('error');
        expect(missing.state).toBe('absent');
        expect(failed.state).not.toEqual(missing.state);
      });
    });

    it('carries a message an operator can act on, without the plaintext in it', () => {
      const sealed = seal(GITHUB_TOKEN, GITHUB_KEY);
      useKey(KEY_B);

      const result = resolveSecret({ sealed, settingKey: GITHUB_KEY });

      expect(result.state).toBe('error');
      if (result.state === 'error') {
        expect(result.message).toContain(GITHUB_KEY);
        expect(result.message).not.toContain(GITHUB_TOKEN);
      }
    });
  });
});
