/**
 * DataTable test suites — shared issue #243 regression guard.
 *
 * The rule, stated once: no control may be hidden with `opacity: 0` while
 * remaining hit-testable (`pointer-events` anything other than `none`). That
 * is the exact bug filed as issue #243 — a hover-revealed control that sat at
 * `opacity: 0` on a touch device stayed fully tappable, silently starring
 * photos the user could not see.
 *
 * Before issue #257 this guard was copy-pasted, with tiny drifts, into FOUR
 * test files (`ResponsiveDataTable.test.tsx`, `DataTableFilters.test.tsx`,
 * `DataTableLayoutPrefs.test.tsx`, `DataTableExport.test.tsx` — the export
 * suite's copy additionally swept `[role="menuitem"]`, since its menu's
 * controls are menu items rather than bare buttons). This module is the one
 * copy; every one of those files, plus the new shared conformance suite
 * (`conformance/runDataTableConformanceSuite.tsx`), imports it instead of
 * redefining it.
 */

import { expect } from 'vitest';

/**
 * The *visible* controls a sweep should ever consider — i.e. the ones whose
 * disappearance while remaining tappable would be a bug.
 *
 * Two deliberate exclusions, unchanged from the original guard:
 *  - Bare `<input>`: MUI's Checkbox/Radio put a transparent native input
 *    exactly on top of a painted SVG. That is the correct pattern (the hit
 *    target coincides with a visible affordance) and is the opposite of
 *    #243, so the sweep looks at the painted `.MuiCheckbox-root` instead.
 *  - MUI X's own hover-revealed column-header chrome (sort/menu buttons) —
 *    not ours to assert on, and reachable by keyboard regardless.
 */
export const DEFAULT_VISIBLE_CONTROL_SELECTOR =
  'button, [role="button"], .MuiCheckbox-root, a[href]';

/** Selector for third-party (MUI X) chrome the sweep should not walk into. */
export const THIRD_PARTY_CHROME_SELECTOR =
  '.MuiDataGrid-columnHeaders, .MuiDataGrid-columnHeader';

/** Human-readable identifier for a failing control, so a regression names the offender. */
export function describeControl(control: HTMLElement): string {
  const label =
    control.getAttribute('aria-label') ??
    control.textContent?.slice(0, 24) ??
    '';
  return `${control.tagName.toLowerCase()}[${label}]`;
}

export interface AssertNoInvisibleHitTargetsOptions {
  /**
   * Overrides {@link DEFAULT_VISIBLE_CONTROL_SELECTOR}. The export suite
   * passes this with `, [role="menuitem"]` appended, since its export menu's
   * controls are menu items rather than plain buttons or checkboxes.
   */
  selector?: string;
  thirdPartyChrome?: string;
}

/**
 * Sweep every visible control under `root` and fail — naming the offender —
 * if any is `opacity: 0` while remaining hit-testable.
 */
export function assertNoInvisibleHitTargets(
  root: HTMLElement,
  options: AssertNoInvisibleHitTargetsOptions = {},
): void {
  const selector = options.selector ?? DEFAULT_VISIBLE_CONTROL_SELECTOR;
  const thirdPartyChrome =
    options.thirdPartyChrome ?? THIRD_PARTY_CHROME_SELECTOR;

  const controls = Array.from(
    root.querySelectorAll<HTMLElement>(selector),
  ).filter((control) => !control.closest(thirdPartyChrome));
  expect(controls.length).toBeGreaterThan(0);

  const offenders = controls
    .filter((control) => {
      const style = getComputedStyle(control);
      return style.opacity === '0' && style.pointerEvents !== 'none';
    })
    .map(describeControl);

  expect(offenders).toEqual([]);
}
