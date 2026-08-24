import { describe, it, expect } from 'vitest';
import {
  formatCheckName,
  formatDeclaration,
  formatThresholdMs,
} from '../../../components/runs/watchdogFormat';

/**
 * The cases here are lifted from the API's own `formatDuration`
 * (`apps/api/src/watchdog/silent-detection.ts`) because the two render the
 * same milliseconds to the same operator, in the same paragraph: the panel
 * prints "Threshold 1m 30s" directly above the watchdog's own reason string,
 * which already contains its rendering of that number. Two spellings of one
 * value is the cheapest way to make it look like two values.
 */
describe('formatThresholdMs', () => {
  it('keeps seconds under a minute', () => {
    expect(formatThresholdMs(45_000)).toBe('45s');
    expect(formatThresholdMs(59_400)).toBe('59s');
  });

  it('shows seconds alongside minutes, and does not round them away', () => {
    // The real `full`-fidelity silence threshold. The trust module's coarser
    // formatDuration renders this as "less than a minute", which is why this
    // one is a separate function.
    expect(formatThresholdMs(90_000)).toBe('1m 30s');
    expect(formatThresholdMs(5 * 60_000)).toBe('5m');
  });

  it('drops to hours and minutes past an hour', () => {
    expect(formatThresholdMs(90 * 60_000)).toBe('1h 30m');
    expect(formatThresholdMs(2 * 60 * 60_000)).toBe('2h 0m');
  });
});

describe('formatCheckName', () => {
  it('derives a display name from the id, without a lookup table', () => {
    expect(formatCheckName('loop-detection')).toBe('Loop detection');
    expect(formatCheckName('silence-detection')).toBe('Silence detection');
    expect(formatCheckName('rate-limit-parking')).toBe('Rate limit parking');
    expect(formatCheckName('git-liveness')).toBe('Git liveness');
  });
});

describe('formatDeclaration', () => {
  it('renders a declared capability', () => {
    expect(formatDeclaration('full')).toBe('Full');
    expect(formatDeclaration('partial')).toBe('Partial');
    expect(formatDeclaration('structured')).toBe('Structured');
    expect(formatDeclaration('heuristic')).toBe('Heuristic');
    expect(formatDeclaration('none')).toBe('None');
  });

  it('never renders a missing manifest as "None"', () => {
    // `none` is a runner that told us it streams nothing — a known, bounded
    // limitation. Null is a runner that told us nothing at all, which is more
    // alarming and is fixed by registering the runner rather than replacing
    // it. Collapsing the two hides the worse one behind the better one.
    expect(formatDeclaration(null)).toBe('No manifest filed');
    expect(formatDeclaration(null)).not.toBe(formatDeclaration('none'));
  });
});
