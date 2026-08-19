/**
 * Config tests — the run-status registry, exhaustive over the `RunStatus`
 * union.
 *
 * Epic #19. `Record<RunStatus, …>` already makes a MISSING key a compile
 * error. What it cannot catch is a key that exists and is wrong — a descriptor
 * whose `status` field disagrees with the key it is filed under, a label
 * duplicated between two statuses, a token that points at a color that was
 * removed. Those are runtime facts, so they are asserted at runtime here,
 * driven by `RUN_STATUSES` rather than by `Object.keys` so a status added to
 * the union but not to the list fails too.
 */

import { describe, it, expect } from 'vitest';
import { isValidElement } from 'react';
import {
  RUN_STATUS_DESCRIPTORS,
  RUN_STATUS_LIST,
  getRunStatusDescriptor,
} from '../../config/runStatus';
import { statusTokens } from '../../theme/tokens';
import { RUN_STATUSES } from '../../types/cockpit';
import type { RunStatus } from '../../types/cockpit';

describe('runStatus registry', () => {
  it('describes exactly the RunStatus union, with no extras', () => {
    expect(Object.keys(RUN_STATUS_DESCRIPTORS).sort()).toEqual([...RUN_STATUSES].sort());
    expect(RUN_STATUS_LIST).toHaveLength(RUN_STATUSES.length);
  });

  it('lists the descriptors in RUN_STATUSES order', () => {
    // The order is the reading order of the cockpit: healthy first, then the
    // failure modes in escalation order, `quarantined` last.
    expect(RUN_STATUS_LIST.map((d) => d.status)).toEqual([...RUN_STATUSES]);
  });

  it.each([...RUN_STATUSES])('%s: descriptor agrees with the key it is filed under', (status) => {
    expect(RUN_STATUS_DESCRIPTORS[status].status).toBe(status);
    expect(getRunStatusDescriptor(status)).toBe(RUN_STATUS_DESCRIPTORS[status]);
  });

  it.each([...RUN_STATUSES])('%s: has a label and a one-line meaning', (status) => {
    const descriptor = RUN_STATUS_DESCRIPTORS[status];
    expect(descriptor.label.trim().length).toBeGreaterThan(0);
    // The description is not filler: it is the tooltip and the accessible
    // explanation, and it is where the difference between "kill it" (stalled)
    // and "leave it alone" (blocked) actually reaches the operator.
    expect(descriptor.description.trim().length).toBeGreaterThan(0);
    expect(descriptor.description.trim()).toMatch(/\.$/);
  });

  it('gives every status a unique label', () => {
    const labels = RUN_STATUS_LIST.map((d) => d.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it.each([...RUN_STATUSES])('%s: declares Icon as a component, not a rendered element', (status) => {
    // Same rule as `destinations.ts`: `StatusChip` draws the icon at `small`
    // in a table row and `medium` in a panel header, so a pre-rendered element
    // would bake one size into every surface.
    const { Icon } = RUN_STATUS_DESCRIPTORS[status];
    expect(Icon).toBeTruthy();
    expect(isValidElement(Icon), `${status} Icon must be a component`).toBe(false);
  });

  it('gives every status a distinct icon', () => {
    // Icon + label + color, always all three — an icon shared between two
    // statuses silently demotes the set back to two channels.
    const icons = RUN_STATUS_LIST.map((d) => d.Icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it.each([...RUN_STATUSES])('%s: names a token that exists in both modes', (status) => {
    const { token } = RUN_STATUS_DESCRIPTORS[status];
    expect(statusTokens.light[token]).toBeDefined();
    expect(statusTokens.dark[token]).toBeDefined();
  });

  it('escalates exactly the states a human has to resolve', () => {
    // VISION §9: `blocked` parks and auto-resumes with jitter, so it is NOT an
    // escalation however alarming the word sounds; `running` is simply
    // healthy. Everything else ends with a person doing something.
    const escalating = RUN_STATUS_LIST.filter((d) => d.needsAttention).map((d) => d.status);
    expect(escalating.sort()).toEqual((['failed', 'quarantined', 'stalled'] as RunStatus[]).sort());
  });
});
