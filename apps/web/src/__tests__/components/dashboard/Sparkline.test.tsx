import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import {
  Sparkline,
  summarizeTrend,
} from '../../../components/dashboard/Sparkline';

describe('Sparkline', () => {
  /**
   * The single most important assertion about this component.
   *
   * A one-point (or zero-point) polyline degenerates into a flat horizontal
   * stroke, and a flat line is not a neutral drawing — it READS as "stable",
   * which is a measurement. Claiming stability when the truth is "we have one
   * sample" is the exact fabrication the honesty contract forbids.
   */
  describe('refuses to draw a line it cannot justify', () => {
    it('renders nothing for zero points', () => {
      const { container } = render(<Sparkline values={[]} ariaLabel="Trend" />);
      expect(container).toBeEmptyDOMElement();
    });

    it('renders nothing for a single point', () => {
      const { container } = render(
        <Sparkline values={[42]} ariaLabel="Trend" />,
      );
      expect(container).toBeEmptyDOMElement();
    });

    it('draws from two points up', () => {
      render(<Sparkline values={[1, 2]} ariaLabel="Trend" />);
      expect(screen.getByRole('img', { name: 'Trend' })).toBeInTheDocument();
    });
  });

  describe('accessibility', () => {
    /**
     * The accessible name is the real deliverable: a 100x32 line has no axis,
     * no scale and no labels, so nobody can read a value off it. The drawing
     * is decoration around the sentence.
     */
    it('exposes itself as an image with the caller-supplied description', () => {
      render(
        <Sparkline
          values={[1, 2, 3]}
          ariaLabel="Detection latency trend: rising over the last 3 samples — worse."
        />,
      );

      expect(
        screen.getByRole('img', {
          name: 'Detection latency trend: rising over the last 3 samples — worse.',
        }),
      ).toBeInTheDocument();
    });
  });

  describe('drawing', () => {
    it('plots one point per value, left to right, y inverted', () => {
      render(<Sparkline values={[0, 10]} ariaLabel="Trend" />);

      const polyline = screen.getByRole('img').querySelector('polyline');
      const points = polyline?.getAttribute('points')?.split(' ') ?? [];

      expect(points).toHaveLength(2);
      // First sample at x=0, last at the right edge of the viewBox.
      expect(points[0].startsWith('0.00,')).toBe(true);
      expect(points[1].startsWith('100.00,')).toBe(true);

      // SVG y grows downward, so the LARGER value must have the SMALLER y or
      // the series is drawn upside down.
      const [, firstY] = points[0].split(',').map(Number);
      const [, lastY] = points[1].split(',').map(Number);
      expect(lastY).toBeLessThan(firstY);
    });

    it('draws a constant series down the middle rather than at an edge', () => {
      // Unlike the one-point case this IS a real reading — "it did not move".
      render(<Sparkline values={[5, 5, 5]} ariaLabel="Trend" />);

      const polyline = screen.getByRole('img').querySelector('polyline');
      const ys = (polyline?.getAttribute('points') ?? '')
        .split(' ')
        .map((point) => Number(point.split(',')[1]));

      expect(new Set(ys).size).toBe(1);
      expect(ys[0]).toBeGreaterThan(0);
      expect(ys[0]).toBeLessThan(32);
    });

    it('marks the most recent sample with a dot', () => {
      render(<Sparkline values={[1, 5]} ariaLabel="Trend" />);
      const circle = screen.getByRole('img').querySelector('circle');
      expect(circle?.getAttribute('cx')).toBe('100.00');
    });

    /**
     * No hex may appear in this file: `currentColor` is what lets the line
     * inherit the tile's emphasis and invert with the theme for free — the
     * same rule the brand marks follow.
     */
    it('inherits its color instead of hardcoding one', () => {
      render(<Sparkline values={[1, 2]} ariaLabel="Trend" />);
      const svg = screen.getByRole('img');

      expect(svg.querySelector('polyline')?.getAttribute('stroke')).toBe(
        'currentColor',
      );
      expect(svg.querySelector('circle')?.getAttribute('fill')).toBe(
        'currentColor',
      );
      expect(svg.innerHTML).not.toMatch(/#[0-9a-f]{3,6}/i);
    });
  });
});

describe('summarizeTrend', () => {
  it('reports rising and falling from first sample to last', () => {
    expect(summarizeTrend([1, 5, 9])).toBe('rising');
    expect(summarizeTrend([9, 5, 1])).toBe('falling');
  });

  it('reports flat for a series that returns to where it started', () => {
    // The picture wobbles, but the answer to "where did it end up compared to
    // where it started" is "nowhere", and that is what the word must say.
    expect(summarizeTrend([5, 9, 1, 5])).toBe('flat');
  });

  it('reports flat for a constant series', () => {
    expect(summarizeTrend([3, 3, 3])).toBe('flat');
  });

  it('reports flat rather than guessing when there is not enough data', () => {
    expect(summarizeTrend([])).toBe('flat');
    expect(summarizeTrend([7])).toBe('flat');
  });

  it('scales its flat threshold to the series own range', () => {
    // A 0.3% move inside a large range is noise; the same absolute move in a
    // tiny range is the whole story. An absolute epsilon could not do both,
    // and these metrics range from a 0..1 ratio to dollars.
    expect(summarizeTrend([100, 200, 100.2])).toBe('flat');
    expect(summarizeTrend([0.1, 0.2, 0.3])).toBe('rising');
  });
});
