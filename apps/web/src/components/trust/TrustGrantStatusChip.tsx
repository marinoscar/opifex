/**
 * The one and only way a `TrustGrantStatus` is rendered.
 *
 * A sibling of `approvals/ApprovalStatusChip` and `dashboard/StatusChip`, not
 * a fork of either: each takes a different vocabulary, and a component widened
 * to three of them could not tell you what its argument means. What IS shared
 * is the rule and the palette — every status carries ICON + TEXT LABEL +
 * COLOUR, always all three, and the colours come from `theme/tokens.ts` via
 * `config/trustStatus.ts` rather than from a hex written here.
 */

import { Chip, Tooltip } from '@mui/material';
import type { ChipProps } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { getTrustGrantStatusDescriptor } from '../../config/trustStatus';
import { statusTokens } from '../../theme/tokens';
import type { TrustGrantStatus } from '../../types/trust';

export interface TrustGrantStatusChipProps {
  status: TrustGrantStatus;
  /** `small` in table rows (the default), `medium` beside a page heading. */
  size?: ChipProps['size'];
  showTooltip?: boolean;
}

export function TrustGrantStatusChip({
  status,
  size = 'small',
  showTooltip = true,
}: TrustGrantStatusChipProps) {
  const theme = useTheme();
  const descriptor = getTrustGrantStatusDescriptor(status);
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
      data-grant-status={status}
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

export default TrustGrantStatusChip;
