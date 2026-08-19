/**
 * Re-export shim. The WCAG contrast calculator that used to live here now
 * lives at `src/__tests__/utils/contrast.ts`.
 *
 * It moved because it stopped being a DataTable concern: `__tests__/theme/
 * tokens.test.ts` needs the same pure `parseColor`/`flattenOver`/
 * `relativeLuminance`/`contrastRatio` functions to check the status palette,
 * and two copies of a color-math module is how two suites end up disagreeing
 * about what 4.5:1 means.
 *
 * The shim stays so the DataTable suites — which reference this path in their
 * own docblocks as well as their imports — do not have to move with it.
 * Delete it only together with those references.
 */

export {
  parseColor,
  flattenOver,
  relativeLuminance,
  contrastRatio,
  WCAG_AA_NORMAL_TEXT,
  WCAG_AA_LARGE_TEXT,
  WCAG_AA_UI_COMPONENT,
} from '../../../../__tests__/utils/contrast';
