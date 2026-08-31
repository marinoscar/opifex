/**
 * The one and only way a `QuotaPressure` is rendered (#231, #476).
 *
 * The vendor's own ordinal, never a percentage and never a derived judgement.
 * Icon + label + colour like every other status chip in the app; `unknown`
 * carries no status colour at all, because a runner that reported no signal
 * has an UNKNOWN position rather than a healthy one and painting it either
 * green or red would be a lie in one direction or the other.
 */

import { Chip, Tooltip } from '@mui/material';
import type { ChipProps } from '@mui/material';
import HelpOutlineIcon from '@mui/icons-material/HelpOutlineOutlined';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import BatteryAlertIcon from '@mui/icons-material/BatteryAlert';
import type { SvgIconComponent } from '@mui/icons-material';
import { getQuotaPressureDescriptor } from '../../config/quotaHistory';
import type { QuotaPressure } from '../../types/quota';
import { useQuotaChipSx } from './quotaChipStyles';

/**
 * The icons, keyed. Kept HERE rather than in `config/quotaHistory.ts` beside
 * the labels, unlike the reason and disposition registries — a pressure has no
 * other renderer, and the config module's job is the vocabulary shared across
 * surfaces. A `Record<QuotaPressure, …>` still makes a missing key a compile
 * error the day the vendor ordinal grows a fifth value.
 */
const PRESSURE_ICONS: Record<QuotaPressure, SvgIconComponent> = {
  unknown: HelpOutlineIcon,
  allowed: CheckCircleOutlinedIcon,
  warning: WarningAmberIcon,
  exhausted: BatteryAlertIcon,
};

export interface QuotaPressureChipProps {
  pressure: QuotaPressure;
  /**
   * Prefix for the label, e.g. `Peak`.
   *
   * `pressure` and `peakPressure` appear side by side all over this screen and
   * are genuinely different claims — the latest reading versus the worst one
   * ever seen — so the chip that says "the wall was hit at some point" must
   * not be readable as "the wall is being hit now".
   */
  prefix?: string;
  size?: ChipProps['size'];
  showTooltip?: boolean;
}

export function QuotaPressureChip({
  pressure,
  prefix,
  size = 'small',
  showTooltip = true,
}: QuotaPressureChipProps) {
  const descriptor = getQuotaPressureDescriptor(pressure);
  const sx = useQuotaChipSx(descriptor.token);
  const Icon = PRESSURE_ICONS[pressure];

  const chip = (
    <Chip
      size={size}
      icon={<Icon fontSize={size === 'small' ? 'small' : 'medium'} />}
      label={prefix ? `${prefix}: ${descriptor.label}` : descriptor.label}
      variant="outlined"
      data-pressure={pressure}
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

export default QuotaPressureChip;
