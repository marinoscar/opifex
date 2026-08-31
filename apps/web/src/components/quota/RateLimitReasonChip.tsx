/**
 * The one and only way a `RateLimitReason` is rendered (#476).
 *
 * A sibling of `dashboard/StatusChip` rather than a fork of it: that
 * component's argument is a `RunStatus`, and widening it to a fourth
 * vocabulary would mean a component that cannot tell you what its argument
 * means. What IS shared is the rule and the palette — every value carries ICON
 * + TEXT LABEL + COLOUR, always all three, and the colours come from
 * `theme/tokens.ts` via `config/quotaHistory.ts` rather than from a hex
 * written here.
 *
 * ## Why this component exists at all
 *
 * #476 is explicit that `rate-limit` and `quota-exhausted` must stay
 * distinguishable, because they are different operational facts: an overage
 * refused while the window is still live typically clears in minutes, while a
 * spent window waits for its reset. The API refuses to flatten them, and a
 * cell that printed the raw wire word would flatten them anyway — two
 * lowercase hyphenated strings in a narrow column read as one thing with a
 * suffix. So they get different words, different icons and different colours.
 */

import { Chip, Tooltip } from '@mui/material';
import type { ChipProps } from '@mui/material';
import { getRateLimitReasonDescriptor } from '../../config/quotaHistory';
import type { RateLimitReason } from '../../types/quota';
import { useQuotaChipSx } from './quotaChipStyles';

export interface RateLimitReasonChipProps {
  reason: RateLimitReason;
  /** `small` in table rows (the default), `medium` beside a heading. */
  size?: ChipProps['size'];
  showTooltip?: boolean;
}

export function RateLimitReasonChip({
  reason,
  size = 'small',
  showTooltip = true,
}: RateLimitReasonChipProps) {
  const descriptor = getRateLimitReasonDescriptor(reason);
  const sx = useQuotaChipSx(descriptor.token);
  const Icon = descriptor.Icon;

  const chip = (
    <Chip
      size={size}
      icon={<Icon fontSize={size === 'small' ? 'small' : 'medium'} />}
      label={descriptor.label}
      variant="outlined"
      // A stable hook for tests and future CSS that depends on neither the
      // wording nor the colour. It carries the WIRE value, not the label, so a
      // test asserts the fact rather than the phrasing.
      data-reason={reason}
      sx={sx}
    />
  );

  if (!showTooltip) return chip;

  return (
    <Tooltip title={descriptor.description} enterTouchDelay={0}>
      <span style={{ display: 'inline-flex' }}>{chip}</span>
    </Tooltip>
  );
}

export default RateLimitReasonChip;
