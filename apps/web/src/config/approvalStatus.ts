/**
 * The approval-status registry — label, meaning, icon and colour token for
 * every `ApprovalStatus` (#98, epic #22).
 *
 * Follows `config/runStatus.ts` exactly, and for the same reasons: **config
 * owns the domain vocabulary, the theme owns the colour.** A descriptor names
 * a `StatusTokenKey`; it never carries a hex, so light and dark cannot drift
 * apart here.
 *
 * ## No new hues, on purpose
 *
 * `theme/tokens.ts` allocates exactly six status hues and asserts a luminance
 * separation between the confusable pairs. Seven approval statuses claiming
 * seven more colours would break that budget and, worse, would teach the
 * operator a second colour language on a screen they reach at 2am. So each
 * approval status REUSES a run-status token — which the tokens file explicitly
 * anticipates: "a future status may deliberately reuse an existing token
 * rather than claim a seventh hue".
 *
 * The mapping is by MEANING, not by convenience:
 *
 *  - `pending`       → `stalled`     — amber: a person is being waited on, and
 *                                      the clock is running.
 *  - `parked`        → `quarantined` — the off-axis hue, because this is the
 *                                      state that can NEVER resolve itself. It
 *                                      is the same claim `quarantined` makes
 *                                      about a run: no machine will clear it.
 *  - `approved`      → `succeeded`
 *  - `denied`        → `failed`
 *  - `auto_approved` → `running`     — it proceeded, but nobody agreed to it.
 *  - `auto_denied`   → `blocked`     — the quietest token in the set: a refusal
 *                                      by silence is not a judgement, and it
 *                                      can be raised again.
 *  - `superseded`    → `blocked`     — likewise nothing to act on.
 *
 * Colour is never the sole channel: `ApprovalStatusChip` always renders icon +
 * label + colour, the same code rule `StatusChip` enforces.
 */

import type { SvgIconComponent } from '@mui/icons-material';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import PanToolIcon from '@mui/icons-material/PanTool';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import BlockIcon from '@mui/icons-material/Block';
import BoltIcon from '@mui/icons-material/Bolt';
import TimerOffIcon from '@mui/icons-material/TimerOff';
import HistoryIcon from '@mui/icons-material/History';
import type { StatusTokenKey } from '../theme/tokens';
import type { ApprovalStatus } from '../types/approvals';

export interface ApprovalStatusDescriptor {
  status: ApprovalStatus;
  /** Sentence-case, shown verbatim in the chip. */
  label: string;
  /** One line: what the state means and what, if anything, to do about it. */
  description: string;
  Icon: SvgIconComponent;
  token: StatusTokenKey;
  /** Is a person still being waited on? The two open statuses, and only them. */
  open: boolean;
}

/**
 * Every status, keyed. `Record<ApprovalStatus, …>` makes a missing key a
 * compile error the day the API's enum grows an eighth member.
 */
export const APPROVAL_STATUS_DESCRIPTORS: Record<
  ApprovalStatus,
  ApprovalStatusDescriptor
> = {
  pending: {
    status: 'pending',
    label: 'Waiting on you',
    description:
      'Nobody has answered this yet, and its timeout policy is still running.',
    Icon: HourglassEmptyIcon,
    token: 'stalled',
    open: true,
  },
  parked: {
    status: 'parked',
    label: 'Parked — no timer',
    description:
      'Nothing happens until a person answers. This can never be approved by silence.',
    Icon: PanToolIcon,
    token: 'quarantined',
    open: true,
  },
  approved: {
    status: 'approved',
    label: 'Approved',
    description: 'A person approved it. That is evidence for this class.',
    Icon: CheckCircleOutlinedIcon,
    token: 'succeeded',
    open: false,
  },
  denied: {
    status: 'denied',
    label: 'Denied',
    description: 'A person refused it. That is evidence for this class.',
    Icon: BlockIcon,
    token: 'failed',
    open: false,
  },
  auto_approved: {
    status: 'auto_approved',
    label: 'Auto-approved',
    description:
      'It proceeded on its recorded timeout policy. Silence is not agreement, so this is not evidence.',
    Icon: BoltIcon,
    token: 'running',
    open: false,
  },
  auto_denied: {
    status: 'auto_denied',
    label: 'Auto-denied',
    description:
      'Refused by silence. Nothing happened and nothing was spent; it can be raised again.',
    Icon: TimerOffIcon,
    token: 'blocked',
    open: false,
  },
  superseded: {
    status: 'superseded',
    label: 'Superseded',
    description:
      'The condition it was raised about changed before anyone had to answer. Nobody refused it.',
    Icon: HistoryIcon,
    token: 'blocked',
    open: false,
  },
};

export function getApprovalStatusDescriptor(
  status: ApprovalStatus,
): ApprovalStatusDescriptor {
  return APPROVAL_STATUS_DESCRIPTORS[status];
}

/** Is this approval still a question somebody has to answer? */
export function isOpenApproval(status: ApprovalStatus): boolean {
  return APPROVAL_STATUS_DESCRIPTORS[status].open;
}
