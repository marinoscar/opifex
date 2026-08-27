/**
 * The project slug rule (#404), decided here rather than fallen into.
 *
 * ## Supplied, or derived once — never re-derived
 *
 * `slug` is `@unique` and is the handle an operator types, filters on and puts
 * in a link. So it is OPERATOR-SUPPLIED when they supply one, and DERIVED FROM
 * THE NAME only when they do not, so the common case is a single field:
 * `{ name: "Billing Platform" }` becomes `billing-platform`.
 *
 * Derivation happens exactly once, at creation. Renaming a project later does
 * NOT re-derive its slug, because the slug is the stable handle and a rename
 * is a change of label, not of identity — silently moving the handle under
 * everything that referenced it is the failure mode having a slug at all is
 * meant to avoid.
 *
 * ## A collision REFUSES; it is never silently suffixed
 *
 * The alternative — appending `-2` — was rejected deliberately. A suffix
 * invents a handle nobody chose and nobody can predict: the operator who asked
 * for `billing` and got `billing-2` has no signal that they collided, and
 * every later reference to `billing` silently resolves to somebody else's
 * project. Refusing costs one extra round trip and the operator picks the
 * name, which is the only party that knows whether the collision was a
 * duplicate or a genuinely different project. `ProjectsService` therefore
 * answers 409 and NAMES the taken slug, including when the slug was derived
 * and the operator never typed it.
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

export const PROJECT_SLUG_MESSAGE =
  'A project slug is lowercase letters, numbers and single hyphens, and cannot start or end with a hyphen';

/**
 * Derive a slug from a project name.
 *
 * Returns an empty string when the name carries no characters this alphabet
 * can represent — a name of `"日本語"` or `"!!!"` derives to nothing, and the
 * caller must refuse rather than invent a handle. That case is the reason this
 * returns a string instead of throwing: refusing is the SERVICE's job, and it
 * has the vocabulary (a 400 naming the missing field) that this pure function
 * does not.
 */
export function deriveProjectSlug(name: string): string {
  return (
    name
      .normalize('NFKD')
      // Strip the combining marks NFKD just separated out, so "Café" derives
      // `cafe` rather than losing the whole word to the non-alphanumeric rule
      // below.
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      // Any run of characters outside the alphabet becomes ONE hyphen, so
      // "Billing  &  Invoicing" does not derive a slug with a hyphen run in
      // it that `PROJECT_SLUG_PATTERN` would then reject.
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, PROJECT_SLUG_MAX_LENGTH)
      // Truncation can land on a hyphen; trim again rather than emit a slug
      // this module's own pattern rejects.
      .replace(/-+$/, '')
  );
}
