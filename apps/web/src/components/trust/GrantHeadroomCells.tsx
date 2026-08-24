/**
 * The two cells #101's second acceptance criterion is really about: **a grant
 * near expiry or near its budget ceiling must be obvious at a glance.**
 *
 * Both draw from `nearExpiry` / `nearBudget`, which the API computes, and
 * NEITHER re-derives the threshold from `msUntilExpiry` or
 * `budgetHeadroomFraction`. That is the whole reason those booleans travel: a
 * second copy of "20% headroom is close" in this file is how the amber chip
 * and the progress bar end up disagreeing on one screen, and the day the
 * server's window is tuned the browser would go on using the old one.
 *
 * The warning is amber (`stalled`) and it is never the only channel — the cell
 * says "Expires in 4h" or "$3.00 of $25.00 left" in words, with a bold weight,
 * so the same information survives a greyscale screen and a monochromat.
 *
 * `msUntilExpiry` is SIGNED, and `ExpiryCell` is the reason it must be. A
 * lapsed grant reads "Lapsed 3h ago" in the quiet `blocked` colour, NOT a
 * countdown: silence revoking a grant is the mechanism working, so it must not
 * shout, and it must certainly not be drawn as time remaining.
 */

import { Box, LinearProgress, Stack, Tooltip, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { isAuthorizingGrant } from '../../config/trustStatus';
import { statusTokens } from '../../theme/tokens';
import type { StatusTokenKey } from '../../theme/tokens';
import type { TrustGrant } from '../../types/trust';
import { describeExpiry, formatPercent, formatUsd } from './trustFormat';

/** Resolves one status token for the active theme mode. */
function useStatusToken(key: StatusTokenKey) {
  const theme = useTheme();
  return statusTokens[theme.palette.mode === 'dark' ? 'dark' : 'light'][key];
}

export function ExpiryCell({ grant }: { grant: TrustGrant }) {
  const expiry = describeExpiry(grant.msUntilExpiry);
  // A grant that has ENDED is never drawn as wanting attention, whatever its
  // flags: it authorizes nothing, and amber on a revoked row is noise on the
  // one screen whose job is to make the live warnings stand out.
  const warn = isAuthorizingGrant(grant.status) && grant.nearExpiry;
  const warnToken = useStatusToken('stalled');
  const quietToken = useStatusToken('blocked');

  return (
    <Stack
      direction="row"
      spacing={0.5}
      sx={{ alignItems: 'center', minWidth: 0 }}
    >
      {warn && (
        <WarningAmberIcon
          fontSize="small"
          sx={{ color: warnToken.fg }}
          titleAccess="Near expiry"
        />
      )}
      <Typography
        variant="body2"
        noWrap
        sx={{
          fontWeight: warn ? 600 : 400,
          color: warn
            ? warnToken.fg
            : expiry.lapsed
              ? quietToken.fg
              : 'text.primary',
        }}
      >
        {expiry.text}
      </Typography>
    </Stack>
  );
}

/**
 * Budget headroom, as dollars AND as a bar.
 *
 * The dollars are what an operator decides on; the bar is what makes a $25
 * grant and a $250 grant comparable down a column, which is why
 * `budgetHeadroomFraction` exists at all. The bar's `value` is the fraction
 * SPENT rather than the headroom, because a bar that empties as trust is
 * consumed reads backwards to everyone.
 */
export function BudgetCell({ grant }: { grant: TrustGrant }) {
  const warn = isAuthorizingGrant(grant.status) && grant.nearBudget;
  const warnToken = useStatusToken('stalled');
  const spentFraction = 1 - grant.budgetHeadroomFraction;

  return (
    <Tooltip
      title={`Spent ${formatUsd(grant.spentUsd)} of ${formatUsd(grant.budgetCeilingUsd)}. The grant dies at the ceiling, whether or not anyone is watching.`}
      enterTouchDelay={0}
    >
      <Box sx={{ minWidth: 0, width: '100%' }}>
        <Stack
          direction="row"
          spacing={0.5}
          sx={{ alignItems: 'center', minWidth: 0 }}
        >
          {warn && (
            <WarningAmberIcon
              fontSize="small"
              sx={{ color: warnToken.fg }}
              titleAccess="Near its budget ceiling"
            />
          )}
          <Typography
            variant="body2"
            noWrap
            sx={{
              fontVariantNumeric: 'tabular-nums',
              fontWeight: warn ? 600 : 400,
              color: warn ? warnToken.fg : 'text.primary',
            }}
          >
            {formatUsd(grant.remainingBudgetUsd)} of{' '}
            {formatUsd(grant.budgetCeilingUsd)} left
          </Typography>
        </Stack>
        <LinearProgress
          variant="determinate"
          // Clamped for the BAR only. The numbers above are never clamped —
          // this is a drawing constraint, not a claim about the data.
          value={Math.min(100, Math.max(0, spentFraction * 100))}
          aria-label={`${formatPercent(spentFraction)} of the budget ceiling spent`}
          sx={{
            mt: 0.5,
            height: 4,
            borderRadius: 2,
            ...(warn && {
              '& .MuiLinearProgress-bar': { backgroundColor: warnToken.fg },
            }),
          }}
        />
      </Box>
    </Tooltip>
  );
}
