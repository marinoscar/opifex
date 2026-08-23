/**
 * DataTable — an `indeterminate` checkbox that also sets the REAL native DOM
 * property, not just the ARIA one.
 *
 * MUI's `Checkbox` (and MUI X's `GridHeaderCheckbox`, which renders the exact
 * same component through DataGrid's own `baseCheckbox` slot) sets
 * `aria-checked="mixed"` on the underlying `<input type="checkbox">` when
 * `indeterminate` is true, but — by its own documented design — never sets
 * the native `HTMLInputElement.indeterminate` IDL property, which has no HTML
 * attribute form and can only be set imperatively via the DOM node (see
 * `@mui/material/Checkbox/Checkbox.js`'s own comment: "This does not set the
 * native input element to indeterminate... However, we set a
 * `data-indeterminate` attribute"). `axe-core`'s `aria-conditional-attr` rule
 * computes a checkbox's "real" state from that native property, not from
 * `data-indeterminate`, sees `aria-checked="mixed"` against an unset native
 * property, and flags it — a genuine, reproducible violation surfaced by this
 * issue's (#257) conformance suite, not a jsdom artifact.
 *
 * This wraps `Checkbox` and syncs the native property via a plain DOM query
 * on its own rendered root — deliberately NOT `slotProps.input.ref` /
 * `inputRef`, which have churned across MUI major versions; a `querySelector`
 * for the one `<input>` MUI always renders inside is stable across all of
 * them.
 *
 * ## Two calling conventions, one component
 *
 * Used two ways, which is why it accepts BOTH of MUI's native-input slot-prop
 * spellings:
 *  - Directly, as an ordinary `Checkbox` replacement (`mobile/CardListRenderer.tsx`'s
 *    select-all checkbox) — MUI's own convention, `slotProps.input`.
 *  - As DataGrid's public `slots.baseCheckbox` override
 *    (`desktop/DesktopGridRenderer.tsx`, fixing the grid's built-in header
 *    checkbox) — MUI X's base-slot convention for every `base*` component,
 *    `slotProps.htmlInput` (see `@mui/x-data-grid`'s `GridBaseCheckboxProps`).
 *    Individual row checkboxes never go indeterminate, so they do not need
 *    this — see `checkboxColDef` in `DesktopGridRenderer.tsx`.
 */

import { useEffect, useRef } from 'react';
import type { ComponentProps, InputHTMLAttributes, Ref } from 'react';
import { Checkbox } from '@mui/material';
// `@mui/material/utils/useForkRef` is not part of the package's public
// `exports` map (a deep-import 404 under `moduleResolution: "bundler"`); the
// underlying implementation IS a proper public export of `@mui/utils`, which
// `@mui/material` already depends on.
import useForkRef from '@mui/utils/useForkRef';

/** Matches `Checkbox`'s own root ref type — the rendered root is a `<span>`
 * in practice (SwitchBase forces `component="span"`), but MUI's public type
 * for `Checkbox`'s ref is `HTMLButtonElement`; querying `.querySelector`
 * off it does not care which one it actually is at runtime. */
type CheckboxRootElement = HTMLButtonElement;

export interface IndeterminateCheckboxProps extends Omit<
  ComponentProps<typeof Checkbox>,
  'slotProps'
> {
  slotProps?: ComponentProps<typeof Checkbox>['slotProps'] & {
    /** MUI X's `base*` slot convention (see the module docblock). */
    htmlInput?: InputHTMLAttributes<HTMLInputElement>;
  };
  /**
   * DataGrid's `GridHeaderCheckbox` passes its OWN `ref` when calling this as
   * `slots.baseCheckbox` — React 19 delivers that as an ordinary `ref` prop
   * here (this is a plain function component, not `forwardRef`). It has to be
   * forked with our own internal ref (`useForkRef`, below) rather than simply
   * spread onto `<Checkbox>` after it: a later spread would silently WIN over
   * an earlier explicit `ref={...}` in the JSX and orphan our DOM query, which
   * is exactly the bug this component exists to avoid reintroducing.
   */
  ref?: Ref<CheckboxRootElement>;
}

export function IndeterminateCheckbox({
  slotProps,
  ref: externalRef,
  ...rest
}: IndeterminateCheckboxProps) {
  const queryRef = useRef<CheckboxRootElement | null>(null);
  const rootRef = useForkRef(queryRef, externalRef);

  useEffect(() => {
    const input = queryRef.current?.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    if (input) input.indeterminate = Boolean(rest.indeterminate);
  }, [rest.indeterminate]);

  // Normalize both slot-prop conventions onto the one MUI's own `Checkbox`
  // actually reads (`slotProps.input`), so an `aria-label`/`name` supplied
  // either way (DataGrid's `htmlInput`, or a direct caller's `input`) reaches
  // the native element instead of being silently dropped.
  const mergedSlotProps = {
    ...slotProps,
    input: { ...slotProps?.input, ...slotProps?.htmlInput },
  };

  return <Checkbox ref={rootRef} slotProps={mergedSlotProps} {...rest} />;
}
