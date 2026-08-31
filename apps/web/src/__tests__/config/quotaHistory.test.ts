/**
 * Config tests — the quota vocabulary registry, exhaustive over all three
 * closed unions it describes (#476).
 *
 * Follows `runStatus.test.ts` exactly, for the same reason: a
 * `Record<Union, …>` already makes a MISSING key a compile error, but not a
 * key that exists and is wrong — a descriptor filed under the wrong key, a
 * label duplicated between two values, a token pointing at a colour that no
 * longer exists. Those are runtime facts, so every assertion below iterates
 * the RUNTIME lists (`RATE_LIMIT_REASONS`, `EPISODE_DISPOSITIONS`,
 * `QUOTA_PRESSURES`) rather than a hand-copied array, so a value added to a
 * union but not to the config fails the suite instead of silently rendering
 * with `undefined`.
 *
 * `unknown` gets its own pinned assertion in every group that has one:
 * `config/quotaHistory.ts`'s header calls `token: null` a decision, not an
 * oversight — "an admission must not be dressed as a verdict" — and a
 * well-meaning edit that gave `unknown` a colour to "make it consistent"
 * would be exactly the regression this file exists to catch.
 */

import { describe, it, expect } from 'vitest';
import { isValidElement } from 'react';
import {
  EPISODE_DISPOSITION_DESCRIPTORS,
  EPISODE_DISPOSITION_LIST,
  QUOTA_PRESSURE_DESCRIPTORS,
  RATE_LIMIT_REASON_DESCRIPTORS,
  RATE_LIMIT_REASON_LIST,
  getEpisodeDispositionDescriptor,
  getQuotaPressureDescriptor,
  getRateLimitReasonDescriptor,
} from '../../config/quotaHistory';
import { statusTokens } from '../../theme/tokens';
import {
  EPISODE_DISPOSITIONS,
  QUOTA_PRESSURES,
  RATE_LIMIT_REASONS,
} from '../../types/quota';

describe('RATE_LIMIT_REASON_DESCRIPTORS', () => {
  it('describes exactly the RateLimitReason union, with no extras', () => {
    expect(Object.keys(RATE_LIMIT_REASON_DESCRIPTORS).sort()).toEqual(
      [...RATE_LIMIT_REASONS].sort(),
    );
    expect(RATE_LIMIT_REASON_LIST).toHaveLength(RATE_LIMIT_REASONS.length);
  });

  it('lists the descriptors in the API declaration order', () => {
    expect(RATE_LIMIT_REASON_LIST.map((d) => d.reason)).toEqual([
      ...RATE_LIMIT_REASONS,
    ]);
  });

  it.each([...RATE_LIMIT_REASONS])(
    '%s: descriptor agrees with the key it is filed under',
    (reason) => {
      expect(RATE_LIMIT_REASON_DESCRIPTORS[reason].reason).toBe(reason);
      expect(getRateLimitReasonDescriptor(reason)).toBe(
        RATE_LIMIT_REASON_DESCRIPTORS[reason],
      );
    },
  );

  it.each([...RATE_LIMIT_REASONS])(
    '%s: has a label, a description and an icon component',
    (reason) => {
      const descriptor = RATE_LIMIT_REASON_DESCRIPTORS[reason];
      expect(descriptor.label.trim().length).toBeGreaterThan(0);
      expect(descriptor.description.trim().length).toBeGreaterThan(0);
      expect(descriptor.Icon).toBeTruthy();
      expect(
        isValidElement(descriptor.Icon),
        `${reason} Icon must be a component, not a rendered element`,
      ).toBe(false);
    },
  );

  it('gives both reasons distinct labels and distinct icons', () => {
    // #476 is explicit that `rate-limit` and `quota-exhausted` must never be
    // flattened into one "rate limited" — a shared label or icon would do
    // exactly that visually, even with the wire values kept apart.
    const labels = RATE_LIMIT_REASON_LIST.map((d) => d.label);
    const icons = RATE_LIMIT_REASON_LIST.map((d) => d.Icon);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it.each([...RATE_LIMIT_REASONS])(
    '%s: names a status token that exists in both modes',
    (reason) => {
      const { token } = RATE_LIMIT_REASON_DESCRIPTORS[reason];
      expect(statusTokens.light[token]).toBeDefined();
      expect(statusTokens.dark[token]).toBeDefined();
    },
  );

  it('reuses run-status tokens by meaning, not by borrowing a new hue', () => {
    // The file's own mapping: the vendor refusing an overage (quiet, usually
    // clears itself) reads as `blocked`; the window itself being spent
    // (louder, waits for a reset) reads as `stalled`.
    expect(RATE_LIMIT_REASON_DESCRIPTORS['rate-limit'].token).toBe('blocked');
    expect(RATE_LIMIT_REASON_DESCRIPTORS['quota-exhausted'].token).toBe(
      'stalled',
    );
  });
});

describe('EPISODE_DISPOSITION_DESCRIPTORS', () => {
  it('describes exactly the EpisodeDisposition union, with no extras', () => {
    expect(Object.keys(EPISODE_DISPOSITION_DESCRIPTORS).sort()).toEqual(
      [...EPISODE_DISPOSITIONS].sort(),
    );
    expect(EPISODE_DISPOSITION_LIST).toHaveLength(EPISODE_DISPOSITIONS.length);
  });

  it('lists the descriptors in the API declaration order', () => {
    expect(EPISODE_DISPOSITION_LIST.map((d) => d.disposition)).toEqual([
      ...EPISODE_DISPOSITIONS,
    ]);
  });

  it.each([...EPISODE_DISPOSITIONS])(
    '%s: descriptor agrees with the key it is filed under',
    (disposition) => {
      expect(EPISODE_DISPOSITION_DESCRIPTORS[disposition].disposition).toBe(
        disposition,
      );
      expect(getEpisodeDispositionDescriptor(disposition)).toBe(
        EPISODE_DISPOSITION_DESCRIPTORS[disposition],
      );
    },
  );

  it.each([...EPISODE_DISPOSITIONS])(
    '%s: has a label, a description and an icon component',
    (disposition) => {
      const descriptor = EPISODE_DISPOSITION_DESCRIPTORS[disposition];
      expect(descriptor.label.trim().length).toBeGreaterThan(0);
      expect(descriptor.description.trim().length).toBeGreaterThan(0);
      expect(descriptor.Icon).toBeTruthy();
      expect(
        isValidElement(descriptor.Icon),
        `${disposition} Icon must be a component, not a rendered element`,
      ).toBe(false);
    },
  );

  it('gives every disposition a distinct label and a distinct icon', () => {
    const labels = EPISODE_DISPOSITION_LIST.map((d) => d.label);
    const icons = EPISODE_DISPOSITION_LIST.map((d) => d.Icon);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it.each(
    [...EPISODE_DISPOSITIONS].filter(
      (disposition) => disposition !== 'unknown',
    ),
  )('%s: names a status token that exists in both modes', (disposition) => {
    const { token } = EPISODE_DISPOSITION_DESCRIPTORS[disposition];
    expect(token).not.toBeNull();
    expect(statusTokens.light[token!]).toBeDefined();
    expect(statusTokens.dark[token!]).toBeDefined();
  });

  it('gives `unknown` NO status token — an admission, not a verdict', () => {
    // The one assertion this whole file exists to protect. `token: null`
    // means the chip renders in the theme's own secondary text colour: not
    // alarming, not reassuring, which is exactly the claim `unknown` makes.
    // A well-intentioned "let's give it a colour too" edit is the regression;
    // this line is what turns that edit red.
    expect(EPISODE_DISPOSITION_DESCRIPTORS.unknown.token).toBeNull();
  });

  it('marks only the two live verdicts as open', () => {
    // `open` drives whether the row's `resumesAt` is meaningful — true only
    // for the two dispositions the API derives from CURRENT run state.
    const open = EPISODE_DISPOSITION_LIST.filter((d) => d.open).map(
      (d) => d.disposition,
    );
    expect(open.sort()).toEqual(['awaiting-park', 'parked'].sort());
  });
});

describe('QUOTA_PRESSURE_DESCRIPTORS', () => {
  it('describes exactly the QuotaPressure union, with no extras', () => {
    expect(Object.keys(QUOTA_PRESSURE_DESCRIPTORS).sort()).toEqual(
      [...QUOTA_PRESSURES].sort(),
    );
  });

  it.each([...QUOTA_PRESSURES])(
    '%s: descriptor agrees with the key it is filed under',
    (pressure) => {
      expect(QUOTA_PRESSURE_DESCRIPTORS[pressure].pressure).toBe(pressure);
      expect(getQuotaPressureDescriptor(pressure)).toBe(
        QUOTA_PRESSURE_DESCRIPTORS[pressure],
      );
    },
  );

  it.each([...QUOTA_PRESSURES])(
    '%s: has a label and a description',
    (pressure) => {
      const descriptor = QUOTA_PRESSURE_DESCRIPTORS[pressure];
      expect(descriptor.label.trim().length).toBeGreaterThan(0);
      expect(descriptor.description.trim().length).toBeGreaterThan(0);
    },
  );

  it.each([...QUOTA_PRESSURES].filter((pressure) => pressure !== 'unknown'))(
    '%s: names a status token that exists in both modes',
    (pressure) => {
      const { token } = QUOTA_PRESSURE_DESCRIPTORS[pressure];
      expect(token).not.toBeNull();
      expect(statusTokens.light[token!]).toBeDefined();
      expect(statusTokens.dark[token!]).toBeDefined();
    },
  );

  it('gives `unknown` NO status token — unread is not healthy', () => {
    // A runner that reported no rate-limit signal at all has an UNKNOWN
    // position, not a good one; painting it green (or red) would both be lies,
    // in different directions.
    expect(QUOTA_PRESSURE_DESCRIPTORS.unknown.token).toBeNull();
  });
});
