/**
 * The one and only way a `RunStatus` is rendered.
 *
 * Epic #19, VISION §9.
 *
 * ## The rule this component exists to enforce
 *
 * > Every status carries ICON + TEXT LABEL + COLOR, always all three. Color is
 * > never the sole channel.
 *
 * That is what makes the status palette defensible for a colorblind operator
 * without picking timid hues, and it is why there is no `showLabel` prop, no
 * `iconOnly` variant, and no dot-only rendering. A caller that wants "just the
 * dot" wants a different component and should have to justify it in review —
 * on a cockpit whose entire job is escalation, a status the operator has to
 * infer from a hue is a status they can get wrong at 2am.
 *
 * Colors come from `theme/tokens.ts` via the mode, and the label/icon from
 * `config/runStatus.ts`. Nothing about a status is spelled out here.
 *
 * ## Why not `<Chip color="error">`
 *
 * MUI's semantic channels are four (`error`/`warning`/`info`/`success`) and
 * the status vocabulary is six. Mapping `stalled`, `failed` and `quarantined`
 * onto the two available "bad" channels would collapse exactly the distinction
 * VISION §9 says must not be collapsed — three failure modes, three different
 * responses.
 */

import { Chip, Tooltip } from '@mui/material';
import type { ChipProps } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { getRunStatusDescriptor } from '../../config/runStatus';
import { statusTokens } from '../../theme/tokens';
import type { RunStatus } from '../../types/cockpit';

export interface StatusChipProps {
  status: RunStatus;
  /** `small` in table rows (the default), `medium` in panel headers. */
  size?: ChipProps['size'];
  /**
   * Show the one-line meaning on hover/focus. On by default: the difference
   * between `stalled` (kill it) and `blocked` (leave it, it resumes) is the
   * whole point of having two words for it.
   */
  showTooltip?: boolean;
  className?: string;
}

export function StatusChip({
  status,
  size = 'small',
  showTooltip = true,
  className,
}: StatusChipProps) {
  const theme = useTheme();
  const descriptor = getRunStatusDescriptor(status);
  const token =
    statusTokens[theme.palette.mode === 'dark' ? 'dark' : 'light'][
      descriptor.token
    ];
  const Icon = descriptor.Icon;

  const chip = (
    <Chip
      size={size}
      className={className}
      // A real element, not `icon={<Icon/>}` built from a rendered node in the
      // registry — the registry stores the COMPONENT so each surface can pick
      // its own size (`destinations.ts` does the same for the same reason).
      icon={<Icon fontSize={size === 'small' ? 'small' : 'medium'} />}
      label={descriptor.label}
      variant="outlined"
      // `data-status` gives tests and future CSS a stable hook that does not
      // depend on the label wording or on the color.
      data-status={status}
      sx={{
        color: token.fg,
        backgroundColor: token.surface,
        // The outline is the FULL foreground color, not a faded version of it.
        // That is deliberate: it inherits the same >= 4.5:1 floor the label is
        // held to, so the chip's boundary can never be the weak link that
        // fails WCAG 1.4.11 while the text passes.
        borderColor: token.fg,
      }}
    />
  );

  if (!showTooltip) return chip;

  return (
    <Tooltip title={descriptor.description} enterTouchDelay={0}>
      {/*
        The span is required: a disabled or non-forwarding child cannot hold
        the tooltip's ref, and it also gives touch users something to long-press
        that is not the chip's own ripple target.
      */}
      <span style={{ display: 'inline-flex' }}>{chip}</span>
    </Tooltip>
  );
}

export default StatusChip;
