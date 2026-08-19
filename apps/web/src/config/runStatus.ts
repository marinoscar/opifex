/**
 * The run-status registry — label, icon and color token for every `RunStatus`.
 *
 * Epic #19. This file follows the `destinations.ts` precedent exactly:
 * **config owns the domain vocabulary, the theme owns the color.** A status
 * descriptor names a token key (`theme/tokens.ts` resolves it per mode); it
 * never carries a hex, so the light and dark values cannot drift apart here
 * and the whole file stays mode-agnostic.
 *
 * ## Why an icon is mandatory, not decorative
 *
 * The colorblind-safety rule for this app is a CODE rule, not a hue choice:
 *
 * > Every status renders through `StatusChip` and always carries icon + text
 * > label + color. Color is never the sole channel.
 *
 * `Icon` is therefore a required field, and it is declared as a COMPONENT
 * rather than a rendered element — same reason as `destinations.ts`:
 * `StatusChip` draws it at `small` in a dense table row and at `medium` in a
 * panel header, so the size cannot be baked in here.
 *
 * `description` is not filler. It is shown in the chip's tooltip and read out
 * via `aria-label`, and it is where VISION §9's "three failure modes, three
 * responses" actually reaches the operator: the difference between `stalled`
 * (kill it) and `blocked` (leave it alone, it resumes) is the difference
 * between saving four hours and wasting them.
 */

import type { SvgIconComponent } from '@mui/icons-material';
import PlayCircleOutlinedIcon from '@mui/icons-material/PlayCircleOutlined';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import PauseCircleOutlinedIcon from '@mui/icons-material/PauseCircleOutlined';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import ErrorOutlinedIcon from '@mui/icons-material/ErrorOutlined';
import GppMaybeIcon from '@mui/icons-material/GppMaybe';
import type { StatusTokenKey } from '../theme/tokens';
import type { RunStatus } from '../types/cockpit';
import { RUN_STATUSES } from '../types/cockpit';

export interface RunStatusDescriptor {
  status: RunStatus;
  /** Sentence-case, shown verbatim in the chip. Never abbreviated. */
  label: string;
  /** One line: what the state means and what the operator should do. */
  description: string;
  Icon: SvgIconComponent;
  /**
   * Key into `statusTokens` in `theme/tokens.ts`. Separate from `status` so a
   * future status can reuse an existing color rather than claim a new hue.
   */
  token: StatusTokenKey;
  /**
   * Does this state resolve itself without a human?
   *
   * Drives whether the cockpit's attention panel escalates it. `blocked`
   * auto-resumes (VISION §9) and `running` is simply healthy, so neither is an
   * escalation; the other four all end with a human doing something.
   */
  needsAttention: boolean;
}

/**
 * Every status, keyed. `Record<RunStatus, …>` makes a MISSING key a compile
 * error the day a seventh status is added to the union — which is the point of
 * keying it rather than exporting a bare array.
 */
export const RUN_STATUS_DESCRIPTORS: Record<RunStatus, RunStatusDescriptor> = {
  running: {
    status: 'running',
    label: 'Running',
    description: 'Events are flowing. Nothing to do.',
    Icon: PlayCircleOutlinedIcon,
    token: 'running',
    needsAttention: false,
  },
  succeeded: {
    status: 'succeeded',
    label: 'Succeeded',
    description: 'Completed with a pull request open for review.',
    Icon: CheckCircleOutlinedIcon,
    token: 'succeeded',
    needsAttention: false,
  },
  blocked: {
    status: 'blocked',
    label: 'Blocked',
    description: 'Parked on a rate limit with a reset time. Resumes on its own.',
    Icon: PauseCircleOutlinedIcon,
    token: 'blocked',
    needsAttention: false,
  },
  stalled: {
    status: 'stalled',
    label: 'Stalled',
    description: 'Silent or looping. Kill it and re-run from the base commit.',
    Icon: HourglassEmptyIcon,
    token: 'stalled',
    needsAttention: true,
  },
  failed: {
    status: 'failed',
    label: 'Failed',
    description: 'Terminal failure. Review the run summary before re-running.',
    Icon: ErrorOutlinedIcon,
    token: 'failed',
    needsAttention: true,
  },
  quarantined: {
    status: 'quarantined',
    label: 'Quarantined',
    description: 'Held for a human. It cannot clear its own quarantine.',
    Icon: GppMaybeIcon,
    token: 'quarantined',
    needsAttention: true,
  },
};

/**
 * The descriptors in display order (the order of `RUN_STATUSES`: healthy
 * first, then the failure modes in escalation order).
 */
export const RUN_STATUS_LIST: readonly RunStatusDescriptor[] = RUN_STATUSES.map(
  (status) => RUN_STATUS_DESCRIPTORS[status],
);

/**
 * Lookup with a total signature — `RunStatus` is a closed union, so there is
 * no "unknown status" branch to write and no fallback descriptor to invent. If
 * the API ever sends a status this app does not know, that is a contract
 * violation to surface at the parse boundary, not a shrug in the chip.
 */
export function getRunStatusDescriptor(status: RunStatus): RunStatusDescriptor {
  return RUN_STATUS_DESCRIPTORS[status];
}
