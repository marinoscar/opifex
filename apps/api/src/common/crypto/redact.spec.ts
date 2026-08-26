import {
  MASK,
  MIN_LENGTH_FOR_SUFFIX,
  REVEALED_SUFFIX_LENGTH,
  maskSecret,
  redactSettingsMeta,
} from './redact';

const LONG_TOKEN = 'github_pat_11ABCDEFG0abcdefghijKLMNOPqrstuvwxyz012345';

describe('maskSecret', () => {
  it('reveals at most the last four characters of a long value', () => {
    const masked = maskSecret(LONG_TOKEN);

    expect(masked.endsWith('2345')).toBe(true);
    expect(masked).toBe(`${MASK}2345`);
  });

  it('reveals nothing else from the value, at any length', () => {
    // The general property rather than one example: whatever comes back, the
    // only characters of the original in it are the last four.
    for (const length of [1, 4, 8, 15, 16, 17, 40, 200]) {
      const value = 'abcdefghij'.repeat(30).slice(0, length);
      const masked = maskSecret(value);

      const revealed = masked.replace(/^\*+/, '');

      expect(revealed.length).toBeLessThanOrEqual(REVEALED_SUFFIX_LENGTH);
      if (revealed.length > 0) {
        expect(value.endsWith(revealed)).toBe(true);
      }
    }
  });

  it('reveals nothing at all below the length floor', () => {
    const short = 'sk-short-secret'; // 15 characters, one under the floor.
    expect(short).toHaveLength(MIN_LENGTH_FOR_SUFFIX - 1);

    expect(maskSecret(short)).toBe(MASK);
    expect(maskSecret('hunter2')).toBe(MASK);
    expect(maskSecret('a')).toBe(MASK);
  });

  it('applies the floor at exactly the documented boundary', () => {
    const atFloor =
      'x'.repeat(MIN_LENGTH_FOR_SUFFIX - REVEALED_SUFFIX_LENGTH) + 'TAIL';
    const belowFloor = atFloor.slice(1);

    expect(atFloor).toHaveLength(MIN_LENGTH_FOR_SUFFIX);
    expect(belowFloor).toHaveLength(MIN_LENGTH_FOR_SUFFIX - 1);

    expect(maskSecret(atFloor)).toBe(`${MASK}TAIL`);
    expect(maskSecret(belowFloor)).toBe(MASK);
  });

  it('does not leak the value length through the mask width', () => {
    // A per-character mask would make a 40-character key and a 72-character
    // one distinguishable in the audit log, which fingerprints the issuer.
    const shortish = 'a'.repeat(20);
    const longer = 'a'.repeat(120);

    expect(maskSecret(shortish)).toHaveLength(maskSecret(longer).length);
  });

  it('masks absent and empty values rather than returning an empty string', () => {
    expect(maskSecret(null)).toBe(MASK);
    expect(maskSecret(undefined)).toBe(MASK);
    expect(maskSecret('')).toBe(MASK);
  });
});

describe('redactSettingsMeta', () => {
  it('leaves non-secret fields untouched, so the audit row stays useful', () => {
    const meta = {
      newValue: {
        ui: { allowUserThemeOverride: true },
        features: { chat: false, exports: true },
      },
    };

    expect(redactSettingsMeta(meta)).toEqual(meta);
  });

  it('masks a secret nested inside the settings document', () => {
    const redacted = redactSettingsMeta({
      newValue: { github: { token: LONG_TOKEN, writesEnabled: true } },
    });

    expect(redacted).toEqual({
      newValue: { github: { token: `${MASK}2345`, writesEnabled: true } },
    });
    expect(JSON.stringify(redacted)).not.toContain(LONG_TOKEN);
  });

  it('masks regardless of how the field name is spelled', () => {
    const redacted = redactSettingsMeta({
      apiKey: LONG_TOKEN,
      api_key: LONG_TOKEN,
      'API-KEY': LONG_TOKEN,
      clientSecret: LONG_TOKEN,
      PASSWORD: LONG_TOKEN,
      oauthToken: LONG_TOKEN,
      privateKey: LONG_TOKEN,
      passphrase: LONG_TOKEN,
      credentials: LONG_TOKEN,
      authorization: LONG_TOKEN,
    });

    expect(JSON.stringify(redacted)).not.toContain(LONG_TOKEN);
    expect(Object.values(redacted)).toEqual(
      Object.values(redacted).map(() => `${MASK}2345`),
    );
  });

  it("masks the stored envelope's own field names", () => {
    const redacted = redactSettingsMeta({
      valueCiphertext: 'qafoDtMZReubIWIeDQ2eR+QN3oXSK5+ihkVb7j/GoEln',
      encryptedValue: 'qafoDtMZReubIWIeDQ2eR+QN3oXSK5+ihkVb7j/GoEln',
    });

    expect(redacted).toEqual({
      valueCiphertext: `${MASK}oEln`,
      encryptedValue: `${MASK}oEln`,
    });
  });

  it('does not mask fields whose names merely contain "key"', () => {
    // Over-masking is invisible: a masked `keyVersion` looks exactly like a
    // masked credential, and the audit log quietly stops being readable.
    const meta = { keyVersion: 1, settingKey: 'github.token', publicKey: 'ok' };

    expect(redactSettingsMeta(meta)).toEqual(meta);
  });

  it('accepts extra secret key names from a caller that knows them', () => {
    const redacted = redactSettingsMeta(
      { claude: { oauth: LONG_TOKEN } },
      { secretKeys: ['claude.oauth', 'oauth'] },
    );

    expect(redacted).toEqual({ claude: { oauth: `${MASK}2345` } });
  });

  it('masks a whole subtree stored under a secret-named field', () => {
    // A sealed envelope living under `token` must not be walked into and
    // half-preserved; the field name already declared the subtree sensitive.
    const redacted = redactSettingsMeta({
      github: { token: { ciphertext: 'AAAA', iv: 'BBBB', keyVersion: 1 } },
    });

    expect(redacted).toEqual({ github: { token: MASK } });
  });

  it('walks into arrays', () => {
    const redacted = redactSettingsMeta({
      providers: [
        { name: 'github', token: LONG_TOKEN },
        { name: 'claude', apiKey: LONG_TOKEN },
      ],
    });

    expect(JSON.stringify(redacted)).not.toContain(LONG_TOKEN);
    expect(redacted).toEqual({
      providers: [
        { name: 'github', token: `${MASK}2345` },
        { name: 'claude', apiKey: `${MASK}2345` },
      ],
    });
  });

  it('does not mutate the object it was given', () => {
    const meta = { github: { token: LONG_TOKEN } };

    redactSettingsMeta(meta);

    expect(meta.github.token).toBe(LONG_TOKEN);
  });

  it('survives a cyclic structure instead of recursing forever', () => {
    const meta: Record<string, unknown> = { name: 'settings' };
    meta.self = meta;

    expect(() => redactSettingsMeta(meta)).not.toThrow();
    expect(JSON.stringify(redactSettingsMeta(meta))).toContain('too deep');
  });

  it('leaves leaf values that are not plain objects alone', () => {
    const when = new Date('2026-01-01T00:00:00.000Z');

    expect(redactSettingsMeta({ updatedAt: when, version: 3 })).toEqual({
      updatedAt: when,
      version: 3,
    });
  });
});
