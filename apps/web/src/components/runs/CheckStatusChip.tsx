/**
 * The one and only way a `CheckStatus` is rendered (#104).
 *
 * Same rule as every other status chip in the app — `StatusChip`,
 * `ApprovalStatusChip`, `PromotionRungChip`: ICON + TEXT LABEL + COLOUR,
 * always all three, with the colour resolved from `theme/tokens.ts` via
 * `config/watchdogCoverage.ts`. Nothing about a status is spelled out here.
 *
 * There is no `iconOnly`, no dot variant and no `showLabel` prop, for a
 * sharper reason than usual: the status this component exists to make visible
 * is `unavailable`, and a status an operator has to infer from a hue is a
 * status they can miss — which is the precise failure #104 was filed about.
 */

import { Chip, Tooltip } from '@mui/material';
import type { ChipProps } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { getCheckStatusDescriptor } from '../../config/watchdogCoverage';
import { statusTokens } from '../../theme/tokens';
import type { CheckStatus } from '../../types/cockpit';

export interface CheckStatusChipProps {
  status: CheckStatus;
  size?: ChipProps['size'];
  showTooltip?: boolean;
}

export function CheckStatusChip({
  status,
  size = 'small',
  showTooltip = true,
}: CheckStatusChipProps) {
  const theme = useTheme();
  const descriptor = getCheckStatusDescriptor(status);
  const token =
    statusTokens[theme.palette.mode === 'dark' ? 'dark' : 'light'][
      descriptor.token
    ];
  const Icon = descriptor.Icon;

  const chip = (
    <Chip
      size={size}
      icon={<Icon fontSize={size === 'small' ? 'small' : 'medium'} />}
      label={descriptor.label}
      variant="outlined"
      // A stable hook for tests and future CSS that depends on neither the
      // wording nor the colour.
      data-check-status={status}
      sx={{
        color: token.fg,
        backgroundColor: token.surface,
        borderColor: token.fg,
      }}
    />
  );

  if (!showTooltip) return chip;

  return (
    <Tooltip title={descriptor.description} enterTouchDelay={0}>
      <span style={{ display: 'inline-flex' }}>{chip}</span>
    </Tooltip>
  );
}

export default CheckStatusChip;
