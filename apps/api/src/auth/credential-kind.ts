/**
 * How a request authenticated — the one fact #346 turns on (epic #332).
 *
 * ## Why this exists at all
 *
 * `apps/api/src/autonomy/never-trustable.ts` forbids writing any `.env` file,
 * because until epic #332 the budget ceilings, the quota limits and the
 * credentials lived in a FILE, and a file write is an effect the guard can
 * name and match. #339 moved that configuration into `operator_settings`, so
 * the write is now an HTTP request and no `file-write` effect is produced.
 * The rule did not become wrong; it became inapplicable, silently, which is
 * the worse of the two.
 *
 * ADR-0018 §6 says exactly what has to replace it, and names it a downgrade
 * rather than smoothing it over: the guarantee moves from structural ("no
 * setter exists anywhere in the process") to access-controlled ("the agent
 * provably cannot reach the setter"). That claim rests on two preconditions,
 * and the ADR is explicit that "either one missing is sufficient to invalidate
 * this decision, not merely weaken it":
 *
 *  - #334, merged, removed the credentials from the agent's subprocess
 *    environment, so it has nothing to authenticate with.
 *  - #346, this file, refuses the write path to any credential that does not
 *    prove a human was present.
 *
 * The two are INDEPENDENT on purpose. #334 alone fails the day some future
 * code path legitimately hands an agent a token; #346 alone fails the day an
 * agent gets hold of a live browser session. Neither is sufficient, and
 * neither is a restatement of the other.
 *
 * ## What "interactive" means here, precisely
 *
 * A human completed an authorization at a keyboard *for this session* and the
 * resulting session token is being presented. Both of the other kinds are
 * built for the opposite case, by their own documentation:
 *
 *  - A **personal access token** authenticates "as the user who created it,
 *    inheriting that user's roles and permissions" and exists for "automated
 *    or non-interactive clients" (`docs/personal-access-tokens.md`). Nothing
 *    about presenting one requires a human to be anywhere near it.
 *  - A **device-flow token** (RFC 8628) is issued precisely so that a device
 *    with no browser can act later, unattended, for up to
 *    `DEVICE_TOKEN_EXPIRY_DAYS`.
 *
 * Both are indistinguishable, in an audit row, from the admin who created
 * them acting deliberately. That is the property #346 removes.
 *
 * ## Unknown is not interactive
 *
 * `credentialKindFromClaim` answers `'unknown'`, never `'interactive'`, for a
 * token carrying no `cred` claim or an unrecognised one — and the guard
 * refuses everything that is not `'interactive'`. This fails CLOSED, and the
 * cost is real and bounded: an access token minted before this code deployed
 * carries no claim, so an admin holding one is refused on this one endpoint
 * until their next token (at most `JWT_ACCESS_TTL_MINUTES`, 15 by default).
 * The other direction — treating an absent claim as proof of a human — would
 * make every future token-minting path that forgets to say so silently
 * privileged, which is the exact failure mode this file exists to close.
 */

/** What presented the credential on a request. */
export type CredentialKind =
  'interactive' | 'personal-access-token' | 'device-code' | 'unknown';

/**
 * The JWT claim name carrying {@link CredentialKind}.
 *
 * Short and namespaced by nothing, because this is a first-party token that
 * only this API mints and only this API verifies. Its VALUES are the union
 * members above verbatim, so a token dumped by hand reads as English rather
 * than as a code a reader has to look up.
 */
export const CREDENTIAL_KIND_CLAIM = 'cred';

/**
 * Prefix marking a refresh token issued by the device-authorization flow.
 *
 * WHY A PREFIX AND NOT A COLUMN. `refresh_tokens` stores a hash, not the
 * token, and the kind has to survive `POST /api/auth/refresh` — otherwise the
 * whole guard is one request away from being bypassed: present a device-flow
 * refresh token, receive an access token minted with no device marker, and
 * write settings with it. The token string itself is the only carrier already
 * round-tripping through the client, and this repository already encodes a
 * token's kind in its prefix (`pat_`, `pat.service.ts:19`), so this is the
 * house convention rather than a new mechanism. The stored hash is taken over
 * the whole string, so lookup and uniqueness are unaffected.
 */
export const DEVICE_REFRESH_TOKEN_PREFIX = 'dvc_';

/** Anything carrying the resolved credential kind for the current request. */
export interface RequestWithCredentialKind {
  credentialKind?: CredentialKind;
}

/**
 * The kind a verified access token claims to be, defaulting to `'unknown'`.
 *
 * The signature is `unknown` in: the claim arrives from a parsed JWT payload,
 * which is `any`-shaped by construction, and narrowing it here is what stops
 * a `cred: true` or a `cred: ['interactive']` from ever reaching a comparison.
 */
export function credentialKindFromClaim(claim: unknown): CredentialKind {
  // Only the two kinds a JWT can legitimately be. A token claiming to be a
  // personal access token would be a forgery — PATs are opaque strings
  // validated against a hash and never signed as JWTs — so it lands on
  // 'unknown' and is refused, rather than being believed.
  if (claim === 'interactive' || claim === 'device-code') {
    return claim;
  }

  return 'unknown';
}

/**
 * The kind a refresh token was issued for.
 *
 * Defaults to `'interactive'`, which is the one place in this file that
 * defaults to the privileged answer, and it is safe for a reason specific to
 * this carrier rather than by general principle: exactly two code paths ever
 * create a row in `refresh_tokens` — the browser/OAuth login and the device
 * flow — and the device flow is the one that prefixes. A personal access
 * token has no refresh token at all. So an unprefixed value is not "unknown
 * provenance", it is the login path, by construction.
 */
export function credentialKindFromRefreshToken(token: string): CredentialKind {
  return token.startsWith(DEVICE_REFRESH_TOKEN_PREFIX)
    ? 'device-code'
    : 'interactive';
}

/** The kind resolved for this request, or `'unknown'` if nothing resolved one. */
export function readCredentialKind(request: unknown): CredentialKind {
  const kind = (request as RequestWithCredentialKind | null | undefined)
    ?.credentialKind;

  return kind ?? 'unknown';
}

/**
 * The noun phrase a refusal uses for a kind.
 *
 * Written for an operator reading a 403 in their own tooling's log, who needs
 * to know which of their credentials was rejected before they can work out
 * what to do instead.
 */
export function describeCredentialKind(kind: CredentialKind): string {
  switch (kind) {
    case 'interactive':
      return 'an interactive session';
    case 'personal-access-token':
      return 'a personal access token';
    case 'device-code':
      return 'a device-flow token';
    case 'unknown':
      return 'a credential that cannot be shown to be an interactive session';
  }
}
