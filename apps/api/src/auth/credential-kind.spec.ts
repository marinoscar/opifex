import {
  DEVICE_REFRESH_TOKEN_PREFIX,
  credentialKindFromClaim,
  credentialKindFromRefreshToken,
  describeCredentialKind,
  readCredentialKind,
} from './credential-kind';

/**
 * The vocabulary #346 rests on.
 *
 * Small functions, but the two defaults they encode are the whole security
 * property, and they point in OPPOSITE directions on purpose — which is
 * exactly the kind of thing a later refactor "tidies up" into one consistent
 * rule and silently breaks. Both are asserted here as behaviour rather than
 * left to the comments that explain them.
 */
describe('credential kind (#346)', () => {
  describe('credentialKindFromClaim', () => {
    it('reads the two kinds a JWT may legitimately claim', () => {
      expect(credentialKindFromClaim('interactive')).toBe('interactive');
      expect(credentialKindFromClaim('device-code')).toBe('device-code');
    });

    it('answers unknown — never interactive — for an absent claim', () => {
      // FAIL CLOSED. An access token minted before #346 shipped carries no
      // `cred`, and so does one minted by any future path that forgets to say.
      // Reading absence as proof of a human is the silent privilege
      // escalation the guard exists to prevent.
      expect(credentialKindFromClaim(undefined)).toBe('unknown');
      expect(credentialKindFromClaim(null)).toBe('unknown');
    });

    it('does not believe a token that claims to be a personal access token', () => {
      // A PAT is an opaque string checked against a hash and is never signed
      // as a JWT, so a token making this claim is a forgery attempt rather
      // than a credential. It lands on unknown and is refused.
      expect(credentialKindFromClaim('personal-access-token')).toBe('unknown');
    });

    it('narrows non-string claims rather than comparing them', () => {
      expect(credentialKindFromClaim(true)).toBe('unknown');
      expect(credentialKindFromClaim(['interactive'])).toBe('unknown');
      expect(credentialKindFromClaim({ kind: 'interactive' })).toBe('unknown');
    });
  });

  describe('credentialKindFromRefreshToken', () => {
    it('reads the device prefix', () => {
      expect(
        credentialKindFromRefreshToken(`${DEVICE_REFRESH_TOKEN_PREFIX}abc123`),
      ).toBe('device-code');
    });

    it('reads an unprefixed token as interactive', () => {
      // The one default that falls the privileged way, and it is safe for a
      // reason local to this carrier rather than by general principle: exactly
      // two code paths create a `refresh_tokens` row, and the device flow is
      // the one that prefixes. A PAT has no refresh token at all.
      expect(credentialKindFromRefreshToken('deadbeef')).toBe('interactive');
    });
  });

  describe('readCredentialKind', () => {
    it('reads what the strategy or the guard recorded', () => {
      expect(readCredentialKind({ credentialKind: 'device-code' })).toBe(
        'device-code',
      );
    });

    it('answers unknown when nothing recorded anything', () => {
      // Covers the case that matters most: a request that reached the guard
      // without passing anything that resolves a kind.
      expect(readCredentialKind({})).toBe('unknown');
      expect(readCredentialKind(undefined)).toBe('unknown');
      expect(readCredentialKind(null)).toBe('unknown');
    });
  });

  describe('describeCredentialKind', () => {
    it('names each kind in words an operator can act on', () => {
      expect(describeCredentialKind('personal-access-token')).toBe(
        'a personal access token',
      );
      expect(describeCredentialKind('device-code')).toBe('a device-flow token');
      expect(describeCredentialKind('interactive')).toBe(
        'an interactive session',
      );
      expect(describeCredentialKind('unknown')).toContain(
        'cannot be shown to be an interactive session',
      );
    });
  });
});
