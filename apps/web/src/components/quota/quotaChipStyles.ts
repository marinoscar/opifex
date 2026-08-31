/**
 * One resolution of "what colour is this chip", shared by the three quota
 * chips (#476).
 *
 * The other status chips in this app (`StatusChip`, `ApprovalStatusChip`,
 * `TrustGrantStatusChip`) each resolve their own token inline, because each
 * has exactly one vocabulary. The quota screen has three — a block reason, a
 * disposition and a vendor pressure — and two of them can carry NO token at
 * all, so the null branch would be written three times and would be the branch
 * most likely to drift.
 *
 * ## The null branch is the interesting one
 *
 * `token: null` means the value is not a verdict: `unknown` on a disposition
 * is an admission that nothing stored says, and `unknown` on a pressure is a
 * reading nobody took. Neither is healthy and neither is broken, so both are
 * drawn in the theme's own secondary text colour rather than in any status
 * hue — see `config/quotaHistory.ts` for the argument. Both values come from
 * `theme.palette`, so the treatment follows light and dark without a second
 * declaration.
 */

import { useTheme } from '@mui/material/styles';
import type { SxProps, Theme } from '@mui/material/styles';
import { statusTokens } from '../../theme/tokens';
import type { StatusTokenKey } from '../../theme/tokens';

/**
 * The `sx` for an outlined chip carrying `token`, or the deliberately
 * status-less treatment when it is null.
 *
 * The outline is the FULL foreground colour, never a faded version of it, for
 * the reason `StatusChip` gives: it inherits the same contrast floor the label
 * is held to, so the chip's boundary cannot be the weak link that fails WCAG
 * 1.4.11 while the text passes.
 */
export function useQuotaChipSx(token: StatusTokenKey | null): SxProps<Theme> {
  const theme = useTheme();

  if (!token) {
    return {
      color: 'text.secondary',
      backgroundColor: 'action.hover',
      borderColor: 'divider',
    };
  }

  const resolved =
    statusTokens[theme.palette.mode === 'dark' ? 'dark' : 'light'][token];

  return {
    color: resolved.fg,
    backgroundColor: resolved.surface,
    borderColor: resolved.fg,
  };
}
