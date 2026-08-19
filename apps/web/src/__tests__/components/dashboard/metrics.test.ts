import { describe, it, expect } from 'vitest';
import { METRIC_DEFINITIONS, METRIC_LIST } from '../../../components/dashboard/metrics';
import { METRIC_IDS } from '../../../types/cockpit';

/**
 * The six success metrics.
 *
 * VISION §10 says the web application "exists primarily to show them", which
 * makes this data module the closest thing the frontend has to a product
 * specification — worth testing exhaustively, and cheap to.
 */
describe('metric definitions', () => {
  it('defines exactly the six metrics, in VISION §10 order', () => {
    expect(METRIC_LIST.map((metric) => metric.id)).toEqual([...METRIC_IDS]);
    expect(METRIC_LIST).toHaveLength(6);
  });

  /**
   * Iterating the runtime list rather than trusting the `Record` type: a
   * missing key is a compile error already, but a key that exists and points
   * at the WRONG definition compiles perfectly.
   */
  it('keys every definition by its own id', () => {
    for (const id of METRIC_IDS) {
      expect(METRIC_DEFINITIONS[id].id).toBe(id);
    }
  });

  it('gives every metric a label, a definition and a help line', () => {
    for (const metric of METRIC_LIST) {
      expect(metric.label.length).toBeGreaterThan(0);
      // Point 2 of the honesty contract: an unwired tile still teaches what
      // will be measured, which is impossible without these two strings.
      expect(metric.definition.length).toBeGreaterThan(0);
      expect(metric.help.length).toBeGreaterThan(0);
    }
  });

  /**
   * VISION §10 states a target for exactly one of the six ("Target: seconds."
   * on detection latency). Inventing targets for the other five would be
   * fabricating product goals in a UI data file.
   */
  it('carries a target only where VISION states one', () => {
    const withTarget = METRIC_LIST.filter((metric) => metric.target !== undefined);
    expect(withTarget.map((metric) => metric.id)).toEqual(['detectionLatency']);
    expect(METRIC_DEFINITIONS.detectionLatency.target).toBe('Target: seconds.');
  });

  /**
   * First-pass acceptance is the only higher-is-better metric, and VISION §10
   * makes it the one that decides the roadmap. Getting its direction backwards
   * would make every sparkline description say the opposite of the truth.
   */
  it('marks first-pass acceptance as the only higher-is-better metric', () => {
    const higher = METRIC_LIST.filter((m) => m.direction === 'higher-is-better');
    expect(higher.map((m) => m.id)).toEqual(['firstPassAcceptance']);
  });

  describe('formatting', () => {
    it('renders detection latency in compound units', () => {
      const { format } = METRIC_DEFINITIONS.detectionLatency;
      expect(format(45)).toBe('45s');
      expect(format(330)).toBe('5m 30s');
      expect(format(7380)).toBe('2h 3m');
    });

    it('renders dead time to one decimal hour', () => {
      expect(METRIC_DEFINITIONS.deadTimePerDay.format(2.34)).toBe('2.3 h');
    });

    it('renders ratios as whole percent from a 0..1 fraction', () => {
      expect(METRIC_DEFINITIONS.firstPassAcceptance.format(0.82)).toBe('82%');
      // Quota burn can legitimately exceed the window — that is the condition
      // the metric exists to catch, so it must not be clamped.
      expect(METRIC_DEFINITIONS.quotaBurn.format(1.35)).toBe('135%');
    });

    it('renders cost with cents', () => {
      expect(METRIC_DEFINITIONS.costPerMergedPr.format(12.4)).toContain('12.40');
    });

    it('renders attempts to one decimal', () => {
      expect(METRIC_DEFINITIONS.attemptsPerWorkOrder.format(1.25)).toBe('1.3');
    });

    /**
     * No formatter has a "no data" branch, and none may invent one. Zero is a
     * MEASUREMENT and must format as a measurement; absence is handled one
     * level up, in `MetricTile`, as an em dash.
     */
    it('formats a genuine zero as a number rather than as absence', () => {
      for (const metric of METRIC_LIST) {
        expect(metric.format(0)).not.toBe('—');
        expect(metric.format(0).length).toBeGreaterThan(0);
      }
    });
  });
});
