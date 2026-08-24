/**
 * The one and only way an `ApprovalStatus` is rendered.
 *
 * A sibling of `dashboard/StatusChip`, not a fork of it: that component's prop
 * is a `RunStatus` and its registry is `config/runStatus.ts`, and widening it
 * to two vocabularies would mean a component that cannot tell you what its
 * argument means. What IS shared is the rule and the palette — every status
 * carries ICON + TEXT LABEL + COLOUR, always all three, and the colours come
 * from `theme/tokens.ts` via `config/approvalStatus.ts` rather than from a hex
 * written here.
 */

import { Chip, Tooltip } from '@mui/material';
import type { ChipProps } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { getApprovalStatusDescriptor } from '../../config/approvalStatus';
import { statusTokens } from '../../theme/tokens';
import type { ApprovalStatus } from '../../types/approvals';

export interface ApprovalStatusChipProps {
  status: ApprovalStatus;
  /** `small` in table rows (the default), `medium` beside a page heading. */
  size?: ChipProps['size'];
  showTooltip?: boolean;
}

export function ApprovalStatusChip({
  status,
  size = 'small',
  showTooltip = true,
}: ApprovalStatusChipProps) {
  const theme = useTheme();
  const descriptor = getApprovalStatusDescriptor(status);
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
      data-approval-status={status}
      sx={{
        color: token.fg,
        backgroundColor: token.surface,
        // The full foreground colour, so the outline inherits the same
        // contrast floor the label is held to.
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

export default ApprovalStatusChip;
