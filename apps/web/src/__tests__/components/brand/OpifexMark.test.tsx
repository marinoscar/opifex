/**
 * Component tests — the brand mark and wordmark.
 *
 * Epic #19. Two properties are load-bearing and neither is visual:
 *
 *  1. **No hardcoded color.** Both components paint in `currentColor` so they
 *     invert with the theme for free. A single hex here means an invisible
 *     logo in one of the two modes, and it would be found by a person, not by
 *     a test, at some point after release.
 *  2. **An accessible name, and a way to opt out of it.** The mark is the app
 *     bar's link to `/`. Announced twice (mark + adjacent label) it is noise;
 *     announced zero times it is an unlabelled link.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OpifexMark } from '../../../components/brand/OpifexMark';
import { OpifexWordmark } from '../../../components/brand/OpifexWordmark';

describe('OpifexMark', () => {
  it('exposes itself as a named image by default', () => {
    render(<OpifexMark />);
    expect(screen.getByRole('img', { name: 'Opifex' })).toBeInTheDocument();
  });

  it('accepts a caller-supplied accessible name', () => {
    render(<OpifexMark title="Opifex home" />);
    expect(
      screen.getByRole('img', { name: 'Opifex home' }),
    ).toBeInTheDocument();
  });

  it('drops out of the accessibility tree entirely when decorative', () => {
    // `title={null}` is for the case where a visible "Opifex" label sits right
    // next to it. Half-measures (role="img" with no name, or an empty label)
    // leave an unnamed image in the tree, which is worse than either extreme.
    const { container } = render(<OpifexMark title={null} />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(container.querySelector('svg')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });

  it('paints only in currentColor', () => {
    const { container } = render(<OpifexMark />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    // The real assertion: nothing anywhere in the markup is a literal color.
    expect(svg.outerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(svg.outerHTML).not.toMatch(/rgba?\(/i);
  });

  it('renders the queue-and-dispatch geometry at a size that survives 16px', () => {
    const { container } = render(<OpifexMark size={16} />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
    expect(svg).toHaveAttribute('width', '16');
    // Three bars plus one ascending stroke. Round caps and a stroke width of 2
    // are what keep them separable once scaled to a favicon.
    expect(svg.querySelectorAll('line')).toHaveLength(3);
    expect(svg.querySelectorAll('path')).toHaveLength(1);
    expect(svg.getAttribute('stroke-linecap')).toBe('round');
    expect(svg.getAttribute('stroke-width')).toBe('2');
  });

  it('is never a tab stop', () => {
    // The wrapper (a link or a button) owns focus; an SVG in the tab order is
    // an extra stop with nothing to activate.
    const { container } = render(<OpifexMark />);
    expect(container.querySelector('svg')).toHaveAttribute(
      'focusable',
      'false',
    );
  });
});

describe('OpifexWordmark', () => {
  it('announces once, as a single named image', () => {
    render(<OpifexWordmark />);
    expect(screen.getAllByRole('img', { name: 'Opifex' })).toHaveLength(1);
  });

  it('paints only in currentColor, text included', () => {
    const { container } = render(<OpifexWordmark />);
    const svg = container.querySelector('svg')!;
    // Glyphs are filled, not stroked, so the `<text>` needs its own
    // `currentColor` — it does not inherit the mark group's stroke.
    expect(svg.querySelector('text')?.getAttribute('fill')).toBe(
      'currentColor',
    );
    expect(svg.outerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it('keeps its drawn width pinned to the viewBox', () => {
    // Without `textLength`/`lengthAdjust` the lockup visibly resizes when the
    // Inter webfont swaps in over the fallback stack.
    const { container } = render(<OpifexWordmark height={24} />);
    const text = container.querySelector('text')!;
    expect(text).toHaveAttribute('textLength');
    expect(text).toHaveAttribute('lengthAdjust', 'spacingAndGlyphs');
    expect(text.getAttribute('font-family')).toBe('inherit');
  });

  it('scales width with height, preserving the lockup ratio', () => {
    const { container } = render(<OpifexWordmark height={12} />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('height', '12');
    expect(svg).toHaveAttribute('width', '66'); // 132:24 at half height
  });
});
