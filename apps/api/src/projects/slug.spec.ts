import {
  PROJECT_SLUG_MAX_LENGTH,
  PROJECT_SLUG_PATTERN,
  deriveProjectSlug,
} from './slug';

/**
 * The derivation half of the slug rule (#404). The collision half — that a
 * taken slug REFUSES rather than gets a numeric suffix — is asserted in
 * `projects.service.spec.ts`, because refusing is a service behaviour and this
 * function knows nothing about what is already stored.
 */
describe('deriveProjectSlug (#404)', () => {
  it('lowercases and joins words with single hyphens', () => {
    expect(deriveProjectSlug('Billing Platform')).toBe('billing-platform');
  });

  it('collapses a run of separators into ONE hyphen', () => {
    // The point: a naive per-character replacement would emit
    // `billing---invoicing`, which PROJECT_SLUG_PATTERN itself rejects, so the
    // function would produce values it declares invalid.
    const slug = deriveProjectSlug('Billing  &  Invoicing');
    expect(slug).toBe('billing-invoicing');
    expect(slug).toMatch(PROJECT_SLUG_PATTERN);
  });

  it('trims leading and trailing separators', () => {
    expect(deriveProjectSlug('  --Platform--  ')).toBe('platform');
  });

  it('keeps a word whose only problem is a diacritic', () => {
    // "Café" must not derive `caf`: dropping the accented letter silently
    // truncates a word the operator typed in full.
    expect(deriveProjectSlug('Café Ops')).toBe('cafe-ops');
  });

  it('derives an EMPTY slug from a name it cannot represent', () => {
    // Not a bug and not something to paper over with a random handle: the
    // service turns this into a 400 asking for an explicit slug, which is the
    // only answer that does not invent an identifier the operator never chose.
    expect(deriveProjectSlug('日本語')).toBe('');
    expect(deriveProjectSlug('!!!')).toBe('');
  });

  it('truncates to the maximum length without leaving a trailing hyphen', () => {
    // The hazard: slicing at the limit can land exactly on a separator, and
    // emitting `…-` would be a slug this module's own pattern rejects.
    const name = `${'a'.repeat(PROJECT_SLUG_MAX_LENGTH)} tail`;
    const slug = deriveProjectSlug(name);

    expect(slug.length).toBeLessThanOrEqual(PROJECT_SLUG_MAX_LENGTH);
    expect(slug.endsWith('-')).toBe(false);
    expect(slug).toMatch(PROJECT_SLUG_PATTERN);
  });

  it('always derives something the slug pattern accepts, or nothing at all', () => {
    for (const name of [
      'Billing Platform',
      'ACME / Internal Tools',
      '2026 Roadmap',
      'a',
      '   ',
      '---',
      'Ünïcödé Nämës',
      'x'.repeat(200),
    ]) {
      const slug = deriveProjectSlug(name);
      if (slug !== '') expect(slug).toMatch(PROJECT_SLUG_PATTERN);
    }
  });
});

describe('PROJECT_SLUG_PATTERN', () => {
  it.each(['billing', 'billing-platform', 'a', '2026-roadmap', 'x2'])(
    'accepts %s',
    (slug) => expect(slug).toMatch(PROJECT_SLUG_PATTERN),
  );

  it.each([
    '', // empty
    'Billing', // uppercase reads as the same handle to a human
    '-billing', // leading hyphen
    'billing-', // trailing hyphen
    'billing--platform', // hyphen run
    'billing platform', // space
    'billing_platform', // underscore
    'billing/platform', // path separator
  ])('rejects %p', (slug) => expect(slug).not.toMatch(PROJECT_SLUG_PATTERN));
});
