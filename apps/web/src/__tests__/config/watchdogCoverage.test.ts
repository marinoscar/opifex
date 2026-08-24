/**
 * The check-status registry (#104).
 *
 * These assertions look like they are testing a lookup table, and mostly they
 * are — but two of them are the mechanical half of the rule the whole issue
 * turns on: `unavailable` must not share a colour token with the healthy
 * status, and must not share one with a failure either. Both are one careless
 * edit away at any time, and neither would be visible in a diff that only
 * changed a token name.
 */

import { describe, it, expect } from 'vitest';
import {
  CHECK_STATUS_DESCRIPTORS,
  CHECK_STATUS_LIST,
  getCheckStatusDescriptor,
  isGuardedStatus,
} from '../../config/watchdogCoverage';
import { statusTokens } from '../../theme/tokens';
import { CHECK_STATUSES } from '../../types/cockpit';

describe('CHECK_STATUS_DESCRIPTORS', () => {
  it('covers every status with a label, a description and an icon', () => {
    for (const status of CHECK_STATUSES) {
      const descriptor = getCheckStatusDescriptor(status);
      expect(descriptor.status).toBe(status);
      expect(descriptor.label.length).toBeGreaterThan(0);
      expect(descriptor.description.length).toBeGreaterThan(0);
      expect(descriptor.Icon).toBeDefined();
    }
  });

  it('lists the descriptors healthiest-first, matching CHECK_STATUSES', () => {
    expect(CHECK_STATUS_LIST.map((d) => d.status)).toEqual([
      'active',
      'degraded',
      'unavailable',
    ]);
  });

  it('names only tokens the theme actually defines, in both modes', () => {
    for (const mode of ['light', 'dark'] as const) {
      for (const status of CHECK_STATUSES) {
        const token =
          statusTokens[mode][CHECK_STATUS_DESCRIPTORS[status].token];
        expect(token).toBeDefined();
        expect(token.fg).toMatch(/^#/);
      }
    }
  });

  // -------------------------------------------------------------------------
  // The two that matter
  // -------------------------------------------------------------------------

  it('never paints `unavailable` with the healthy status colour', () => {
    // The failure #104 exists to prevent, reduced to a token comparison: a
    // check that could not run must not be the same colour as one that ran and
    // found nothing.
    expect(CHECK_STATUS_DESCRIPTORS.unavailable.token).not.toBe(
      CHECK_STATUS_DESCRIPTORS.active.token,
    );
    expect(CHECK_STATUS_DESCRIPTORS.unavailable.token).not.toBe('succeeded');
  });

  it('never paints `unavailable` as a failure either', () => {
    // Nothing went wrong — a capability is absent. A red badge would send
    // operators looking for a break that does not exist, and a red badge that
    // can never be cleared is one they stop seeing.
    expect(CHECK_STATUS_DESCRIPTORS.unavailable.token).not.toBe('failed');
    expect(CHECK_STATUS_DESCRIPTORS.unavailable.token).not.toBe('quarantined');
  });

  it('keeps all three statuses visually distinct from one another', () => {
    const tokens = CHECK_STATUSES.map(
      (status) => CHECK_STATUS_DESCRIPTORS[status].token,
    );
    expect(new Set(tokens).size).toBe(tokens.length);

    const icons = CHECK_STATUSES.map(
      (status) => CHECK_STATUS_DESCRIPTORS[status].Icon,
    );
    expect(new Set(icons).size).toBe(icons.length);
  });
});

describe('isGuardedStatus', () => {
  it('treats degraded as guarded and unavailable as not', () => {
    // Degraded detection is LATE detection, not absent detection. Collapsing
    // the two into "not active" would tell the operator the same thing about a
    // check running at a coarser threshold as about one that cannot run, and
    // the response to each is different.
    expect(isGuardedStatus('active')).toBe(true);
    expect(isGuardedStatus('degraded')).toBe(true);
    expect(isGuardedStatus('unavailable')).toBe(false);
  });
});
