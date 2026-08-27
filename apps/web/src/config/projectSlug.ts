/**
 * The project slug rule, mirrored for a PREVIEW only (#404, #406).
 *
 * A copy of `apps/api/src/projects/slug.ts`, written against that file. It
 * exists so the New project form can say what handle a name will produce
 * before the request is sent — the one thing about a project an operator is
 * most likely to be surprised by later, since derivation happens once, at
 * creation, and a rename never moves it.
 *
 * ## This never DECIDES a slug
 *
 * The API derives the real one. Sending this build's answer as an explicit
 * `slug` would turn a preview into a decision and would freeze today's
 * derivation into every project created by a stale tab. So the form leaves the
 * field empty when the operator did not type one, and what comes back from the
 * API is what the screen then shows. If the two ever disagree, the API is
 * right and the disagreement is visible rather than silent.
 *
 * ## An empty derivation is a real answer
 *
 * A name of `"日本語"` or `"!!!"` carries no character this alphabet can
 * represent. The API answers 400 asking for an explicit slug rather than
 * inventing a handle nobody can remember, so this returns `null` for that case
 * and the form asks for one up front instead of letting the operator find out
 * by being refused.
 */

/**
 * Lowercase alphanumerics joined by single hyphens, no leading or trailing
 * hyphen. Deliberately narrower than "URL-safe": a slug that differs from
 * another only by case or by a percent-escape is a slug two people will read
 * as the same thing.
 */
export const PROJECT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Long enough for a real name, short enough to stay a handle. */
export const PROJECT_SLUG_MAX_LENGTH = 64;

/**
 * What the API would derive from `name`, or `null` when it would derive
 * nothing.
 */
export function deriveSlugPreview(name: string): string | null {
  const derived = name
    .normalize('NFKD')
    // Strip the combining marks NFKD just separated out, so "Café" derives
    // `cafe` rather than losing the whole word to the rule below.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Any run of characters outside the alphabet becomes ONE hyphen, so
    // "Billing  &  Invoicing" does not derive a hyphen run the pattern above
    // would then reject.
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, PROJECT_SLUG_MAX_LENGTH)
    // Truncation can land on a hyphen; trim again rather than show a slug this
    // module's own pattern rejects.
    .replace(/-+$/, '');

  return derived === '' ? null : derived;
}
