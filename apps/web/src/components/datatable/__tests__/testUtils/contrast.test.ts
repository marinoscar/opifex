/**
 * Unit tests — the pure WCAG contrast calculator itself (`testUtils/contrast.ts`).
 *
 * Pinned against known reference values (black-on-white is exactly 21:1) so a
 * bug in the calculator can't silently make every theme-contrast assertion in
 * `DataTableContrast.test.tsx` vacuously pass.
 */

import { describe, it, expect } from 'vitest';
import { contrastRatio, flattenOver, parseColor, relativeLuminance } from './contrast';

describe('contrast.ts — parseColor', () => {
  it('parses 6-digit and 3-digit hex', () => {
    expect(parseColor('#000000')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(parseColor('#ffffff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('#F00')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  it('parses rgb() and rgba()', () => {
    expect(parseColor('rgb(25, 118, 210)')).toEqual({ r: 25, g: 118, b: 210, a: 1 });
    expect(parseColor('rgba(25, 118, 210, 0.06)')).toEqual({ r: 25, g: 118, b: 210, a: 0.06 });
  });

  it('throws on an unrecognized format', () => {
    expect(() => parseColor('not-a-color')).toThrow();
  });
});

describe('contrast.ts — relativeLuminance', () => {
  it('black is 0, white is 1', () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 5);
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5);
  });
});

describe('contrast.ts — flattenOver', () => {
  it('a fully-opaque foreground is unaffected by the background', () => {
    expect(flattenOver({ r: 10, g: 20, b: 30, a: 1 }, { r: 255, g: 255, b: 255 })).toEqual({
      r: 10,
      g: 20,
      b: 30,
    });
  });

  it('a 50% foreground is the midpoint of the two colors', () => {
    expect(flattenOver({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255 })).toEqual({
      r: 127.5,
      g: 127.5,
      b: 127.5,
    });
  });
});

describe('contrast.ts — contrastRatio', () => {
  it('black on white is exactly 21:1, the WCAG reference maximum', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 2);
  });

  it('a color against itself is exactly 1:1, the WCAG reference minimum', () => {
    expect(contrastRatio('#1976d2', '#1976d2')).toBeCloseTo(1, 5);
  });

  it('is symmetric — foreground/background order does not matter', () => {
    const a = contrastRatio('#333333', '#eeeeee');
    const b = contrastRatio('#eeeeee', '#333333');
    expect(a).toBeCloseTo(b, 5);
  });

  it('correctly fails a genuinely low-contrast pair (the negative case)', () => {
    // Light grey on white — well below any WCAG threshold. If this ever
    // passed, the calculator itself would be broken.
    const ratio = contrastRatio('#eeeeee', '#ffffff');
    expect(ratio).toBeLessThan(1.5);
  });

  it('flattens a translucent foreground over the supplied background before comparing', () => {
    // A very-low-alpha primary-blue tint over white is nearly white — should
    // have almost no contrast against white text, and strong contrast is
    // wrong here on purpose (proves the flattening step actually ran).
    const flattenedRatio = contrastRatio('rgba(25, 118, 210, 0.06)', '#ffffff', '#ffffff');
    const unflattenedRatio = contrastRatio('rgba(25, 118, 210, 0.06)', '#ffffff');
    expect(flattenedRatio).toBeLessThan(1.2);
    // Without the fallback, the (near-transparent) rgba color's OWN channel
    // values are compared verbatim — a materially different, wrong answer.
    expect(unflattenedRatio).not.toBeCloseTo(flattenedRatio, 1);
  });
});
