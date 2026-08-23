import { describe, expect, it } from 'vitest';

import {
  EVENT_SOURCE_COLORS,
  EVENT_SOURCE_DESCRIPTIONS,
  EVENT_SOURCE_LABELS,
  EVENT_TYPE_LABELS,
} from '../../config/runEvents';
import { RUN_EVENT_TYPES } from '../../types/cockpit';

/**
 * VISION §9: *a synthesized event must never masquerade as a report.* These
 * tables are what keep that true in the UI, so they are asserted rather than
 * assumed.
 */

const SOURCES = ['runner', 'git', 'control-plane'] as const;

describe('the event source vocabulary', () => {
  it('uses VISION §9 wording verbatim', () => {
    expect(EVENT_SOURCE_LABELS).toEqual({
      runner: 'runner-reported',
      git: 'git-derived',
      'control-plane': 'control-plane-synthesized',
    });
  });

  it('gives all three sources distinct labels', () => {
    // The whole point of the discriminator. If two rendered the same, an
    // operator could not tell a report from an inference.
    const labels = SOURCES.map((source) => EVENT_SOURCE_LABELS[source]);
    expect(new Set(labels).size).toBe(3);
  });

  it('gives all three distinct colours as well as labels', () => {
    // Colour is never the only signal — each carries a label too — but the
    // three must still be distinguishable at a glance.
    const colors = SOURCES.map((source) => EVENT_SOURCE_COLORS[source]);
    expect(new Set(colors).size).toBe(3);
  });

  it('draws a synthesized event so it does not look like a report', () => {
    // Grey, deliberately: it is the one that must not read as something a
    // runner said.
    expect(EVENT_SOURCE_COLORS['control-plane']).toBe('default');
    expect(EVENT_SOURCE_COLORS.runner).not.toBe('default');
  });

  it('explains each source in terms of who claimed it', () => {
    expect(EVENT_SOURCE_DESCRIPTIONS.runner).toContain('runner reported');
    expect(EVENT_SOURCE_DESCRIPTIONS.git).toContain('repository');
    expect(EVENT_SOURCE_DESCRIPTIONS['control-plane']).toContain('concluded');
  });
});

describe('the event type vocabulary', () => {
  it('labels every one of the six types', () => {
    // A missing entry would render `undefined` in the timeline.
    for (const type of RUN_EVENT_TYPES) {
      expect(EVENT_TYPE_LABELS[type]).toBeTruthy();
    }
  });

  it('keeps the wire form out of the label', () => {
    // `run.blocked` is a protocol identifier; six of them stacked read as
    // noise in a column a human is scanning.
    for (const label of Object.values(EVENT_TYPE_LABELS)) {
      expect(label).not.toContain('run.');
    }
  });
});
