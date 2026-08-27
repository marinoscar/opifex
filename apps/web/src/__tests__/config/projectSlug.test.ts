/**
 * The slug preview (#406), against the API's own derivation.
 *
 * The cases are taken from `apps/api/src/projects/slug.spec.ts` and from the
 * rules `slug.ts` states, because a preview that disagrees with the API is
 * worse than no preview at all: it would promise a handle the operator does
 * not get, and derivation happens once and is never revisited.
 *
 * `null` for a name that derives nothing is the case worth pinning. The API
 * answers 400 there and asks for an explicit slug rather than inventing one,
 * so the form has to ask up front instead of letting the operator find out by
 * being refused.
 */

import { describe, it, expect } from 'vitest';

import {
  PROJECT_SLUG_MAX_LENGTH,
  PROJECT_SLUG_PATTERN,
  deriveSlugPreview,
} from '../../config/projectSlug';

describe('deriveSlugPreview', () => {
  it('lowercases and joins words with single hyphens', () => {
    expect(deriveSlugPreview('Billing Platform')).toBe('billing-platform');
  });

  it('collapses a run of unusable characters into ONE hyphen', () => {
    // Otherwise the derived slug contains a hyphen run that the pattern the
    // API validates against would then reject.
    expect(deriveSlugPreview('Billing  &  Invoicing')).toBe(
      'billing-invoicing',
    );
  });

  it('keeps a word whose only problem is an accent', () => {
    // NFKD then stripping the combining marks, so "Café" is `cafe` rather than
    // losing the whole word to the non-alphanumeric rule.
    expect(deriveSlugPreview('Café Ops')).toBe('cafe-ops');
  });

  it('trims leading and trailing hyphens', () => {
    expect(deriveSlugPreview('  --Billing--  ')).toBe('billing');
  });

  it('returns null when the name carries nothing this alphabet can hold', () => {
    // A 400 from the API, not a generated identifier nobody can remember.
    expect(deriveSlugPreview('日本語')).toBeNull();
    expect(deriveSlugPreview('!!!')).toBeNull();
    expect(deriveSlugPreview('')).toBeNull();
  });

  it('truncates to the API’s maximum without leaving a trailing hyphen', () => {
    // Truncation can land on a hyphen, and emitting one would preview a slug
    // the API's own pattern rejects.
    const name = `${'a'.repeat(PROJECT_SLUG_MAX_LENGTH)} tail`;
    const preview = deriveSlugPreview(name);

    expect(preview).toHaveLength(PROJECT_SLUG_MAX_LENGTH);
    expect(preview?.endsWith('-')).toBe(false);
  });

  it('never previews a slug the API would reject', () => {
    const names = [
      'Billing Platform',
      'Billing  &  Invoicing',
      'Café Ops',
      '  --Billing--  ',
      'ACME/Widgets v2.0',
      `${'a'.repeat(PROJECT_SLUG_MAX_LENGTH)} tail`,
    ];

    for (const name of names) {
      const preview = deriveSlugPreview(name);
      expect(preview, name).not.toBeNull();
      expect(PROJECT_SLUG_PATTERN.test(preview as string), name).toBe(true);
    }
  });
});
