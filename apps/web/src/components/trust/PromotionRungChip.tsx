/**
 * The one and only way a `PromotionRung` is rendered (VISION §7).
 *
 * Same rule as every other status chip in the app: ICON + TEXT LABEL + COLOUR,
 * always all three, with the colour resolved from `theme/tokens.ts` via
 * `config/trustStatus.ts`.
 *
 * The tooltip on `promoted` says what the rung does NOT mean — that anything
 * is running unattended. The ladder cannot mint grants; a promoted class with
 * no grant runs nothing, and green next to the word "Promoted" is exactly the
 * combination that would be read the other way.
 */

import { Chip, Tooltip } from '@mui/material';
import type { ChipProps } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { getPromotionRungDescriptor } from '../../config/trustStatus';
import { statusTokens } from '../../theme/tokens';
import type { PromotionRung } from '../../types/trust';

export interface PromotionRungChipProps {
  rung: PromotionRung;
  size?: ChipProps['size'];
  showTooltip?: boolean;
}

export function PromotionRungChip({
  rung,
  size = 'small',
  showTooltip = true,
}: PromotionRungChipProps) {
  const theme = useTheme();
  const descriptor = getPromotionRungDescriptor(rung);
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
      data-promotion-rung={rung}
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

export default PromotionRungChip;
