/**
 * The quota vocabulary — label, meaning, icon and colour token for every block
 * reason, every episode disposition and every pressure reading (#476).
 *
 * Follows `config/runStatus.ts`, `config/approvalStatus.ts` and
 * `config/trustStatus.ts` exactly, and for the same reasons: **config owns the
 * domain vocabulary, the theme owns the colour.** A descriptor names a
 * `StatusTokenKey`; it never carries a hex, so light and dark cannot drift
 * apart here and the whole file stays mode-agnostic.
 *
 * ## No new hues, again on purpose
 *
 * `theme/tokens.ts` allocates exactly six status hues and asserts a luminance
 * separation between the confusable pairs. Two reasons plus six dispositions
 * claiming eight more colours would blow that budget and teach the operator a
 * fourth colour language on a screen they reach at 2am. So each REUSES a
 * run-status token, mapped by MEANING:
 *
 *  - `rate-limit`      → `blocked`     — the quietest token in the set. The
 *                                        vendor refused an overage while the
 *                                        window is still live; it typically
 *                                        clears in minutes without anybody
 *                                        doing anything, which is the same
 *                                        claim `blocked` makes about a run.
 *  - `quota-exhausted` → `stalled`     — amber, the loudest warm colour: the
 *                                        window itself is spent and nothing on
 *                                        this runner moves until it rolls.
 *                                        This is the lost-afternoon case #476
 *                                        was filed about.
 *
 *  - `parked`        → `blocked`     — parked with a reset time, resumes on
 *                                      its own. Literally what the `blocked`
 *                                      run status means (VISION §9).
 *  - `awaiting-park` → `stalled`     — seen, nothing scheduled yet, clock
 *                                      running.
 *  - `escalated`     → `quarantined` — the off-axis hue, because a human was
 *                                      told: no machine resolved this one.
 *  - `resumed`       → `running`     — it ran again.
 *  - `concluded`     → `succeeded`   — the story ENDED. Not "ended well": the
 *                                      run's own status chip in the same row
 *                                      says whether it succeeded or failed,
 *                                      and the description says so too.
 *  - `unknown`       → no token      — see below.
 *
 * ## `unknown` deliberately has NO status colour
 *
 * It is the one value in this file that is not a verdict, and painting it with
 * a status hue would make an admission look like one. `token: null` means the
 * chip renders in the theme's own secondary text colour, which is neither
 * alarming nor reassuring — which is exactly the claim being made. It is not
 * an error, not an empty cell, and not a failure to load: the API looked at
 * the run's status, its schedule, its later activity and its escalations, and
 * none of them said. `dispositionBasis` carries that sentence, and the UI
 * shows it rather than dropping it.
 *
 * Colour is never the sole channel anywhere here: every chip renders icon +
 * label + colour, the same code rule `StatusChip`, `ApprovalStatusChip` and
 * `TrustGrantStatusChip` enforce.
 */

import type { SvgIconComponent } from '@mui/icons-material';
import SpeedIcon from '@mui/icons-material/Speed';
import BatteryAlertIcon from '@mui/icons-material/BatteryAlert';
import PauseCircleOutlinedIcon from '@mui/icons-material/PauseCircleOutlined';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import CampaignIcon from '@mui/icons-material/Campaign';
import PlayCircleOutlinedIcon from '@mui/icons-material/PlayCircleOutlined';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import HelpOutlineIcon from '@mui/icons-material/HelpOutlineOutlined';
import type { StatusTokenKey } from '../theme/tokens';
import type {
  EpisodeDisposition,
  QuotaPressure,
  RateLimitReason,
} from '../types/quota';
import { EPISODE_DISPOSITIONS, RATE_LIMIT_REASONS } from '../types/quota';

export interface RateLimitReasonDescriptor {
  reason: RateLimitReason;
  /** Sentence-case, shown verbatim in the chip. Never abbreviated. */
  label: string;
  /** One line: what the vendor actually refused, and how long it usually lasts. */
  description: string;
  Icon: SvgIconComponent;
  token: StatusTokenKey;
}

/**
 * Both reasons, keyed. `Record<RateLimitReason, …>` makes a missing key a
 * compile error the day the API's enum grows a third member — which is the
 * point of keying it rather than exporting a bare array.
 */
export const RATE_LIMIT_REASON_DESCRIPTORS: Record<
  RateLimitReason,
  RateLimitReasonDescriptor
> = {
  'rate-limit': {
    reason: 'rate-limit',
    label: 'Overage refused',
    description:
      'The vendor refused a request while the window was still live. This kind usually clears in minutes.',
    Icon: SpeedIcon,
    token: 'blocked',
  },
  'quota-exhausted': {
    reason: 'quota-exhausted',
    label: 'Window spent',
    description:
      'The window itself was exhausted. Nothing runs on this runner until it rolls over at the reset time.',
    Icon: BatteryAlertIcon,
    token: 'stalled',
  },
};

/** The descriptors in the API's declaration order. */
export const RATE_LIMIT_REASON_LIST: readonly RateLimitReasonDescriptor[] =
  RATE_LIMIT_REASONS.map((reason) => RATE_LIMIT_REASON_DESCRIPTORS[reason]);

export interface EpisodeDispositionDescriptor {
  disposition: EpisodeDisposition;
  /** Sentence-case, shown verbatim in the chip. */
  label: string;
  /** One line: what this verdict asserts, and what it does not. */
  description: string;
  Icon: SvgIconComponent;
  /**
   * The status token this reuses, or **null for `unknown`**.
   *
   * Null is not "no colour decided yet": it is the decision. See this file's
   * header — an admission must not be dressed as a verdict.
   */
  token: StatusTokenKey | null;
  /**
   * Is the run still sitting in this block?
   *
   * The two live verdicts, and only them. Drives whether the row's `resumesAt`
   * is meaningful — the API populates that field for these two alone, because
   * `Run.resumesAt` describes the CURRENT block and reading it back onto a
   * week-old episode would credit a park to a block long over.
   */
  open: boolean;
}

/**
 * Every disposition, keyed. A missing key is a compile error the day the API
 * adds a seventh verdict.
 */
export const EPISODE_DISPOSITION_DESCRIPTORS: Record<
  EpisodeDisposition,
  EpisodeDispositionDescriptor
> = {
  parked: {
    disposition: 'parked',
    label: 'Parked',
    description:
      'Still blocked, with a resume scheduled for the reset time plus jitter. The system is handling it.',
    Icon: PauseCircleOutlinedIcon,
    token: 'blocked',
    open: true,
  },
  'awaiting-park': {
    disposition: 'awaiting-park',
    label: 'Awaiting park',
    description:
      'Blocked with nothing scheduled yet — either the watchdog has not ticked since, or the block carried no reset time and is still inside its patience window.',
    Icon: HourglassEmptyIcon,
    token: 'stalled',
    open: true,
  },
  escalated: {
    disposition: 'escalated',
    label: 'Escalated',
    description:
      'A human was told inside this episode. Opifex stopped handling it alone.',
    Icon: CampaignIcon,
    token: 'quarantined',
    open: false,
  },
  resumed: {
    disposition: 'resumed',
    label: 'Resumed',
    description:
      'The run reported activity after the block. The episode ended without a human.',
    Icon: PlayCircleOutlinedIcon,
    token: 'running',
    open: false,
  },
  concluded: {
    disposition: 'concluded',
    label: 'Concluded',
    description:
      'The run reached a terminal state after the block. That the story ended is not a claim it ended well — the run’s own status says which.',
    Icon: CheckCircleOutlinedIcon,
    token: 'succeeded',
    open: false,
  },
  unknown: {
    disposition: 'unknown',
    label: 'Not recorded',
    description:
      'Nothing stored says what happened next. This is an honest answer, not a failure to load — the run’s status, its schedule, its later activity and its escalations were all looked at, and none of them said.',
    Icon: HelpOutlineIcon,
    token: null,
    open: false,
  },
};

/** The descriptors in the API's declaration order. */
export const EPISODE_DISPOSITION_LIST: readonly EpisodeDispositionDescriptor[] =
  EPISODE_DISPOSITIONS.map(
    (disposition) => EPISODE_DISPOSITION_DESCRIPTORS[disposition],
  );

export interface QuotaPressureDescriptor {
  pressure: QuotaPressure;
  label: string;
  description: string;
  /** Null for `unknown`, for the same reason `unknown` disposition is null. */
  token: StatusTokenKey | null;
}

/**
 * The vendor's own ordinal, keyed.
 *
 * `unknown` again carries no status colour: a runner that has reported no
 * rate-limit signal has an UNKNOWN position, not a healthy one, and painting
 * it green or red would both be lies in different directions.
 */
export const QUOTA_PRESSURE_DESCRIPTORS: Record<
  QuotaPressure,
  QuotaPressureDescriptor
> = {
  unknown: {
    pressure: 'unknown',
    label: 'Unknown',
    description:
      'The vendor said nothing this window could be read from. Not healthy — unread.',
    token: null,
  },
  allowed: {
    pressure: 'allowed',
    label: 'Allowed',
    description: 'The vendor was serving requests when this was last read.',
    token: 'succeeded',
  },
  warning: {
    pressure: 'warning',
    label: 'Warning',
    description:
      'The vendor said it is approaching the limit while still serving. The only signal that arrives before a run is parked.',
    token: 'stalled',
  },
  exhausted: {
    pressure: 'exhausted',
    label: 'Exhausted',
    description:
      'The window hit its ceiling. Nothing runs against it until it rolls.',
    token: 'failed',
  },
};

/**
 * Lookups with total signatures — all three are closed unions, so there is no
 * "unrecognised value" branch to write and no fallback descriptor to invent.
 * If the API ever sends a value this app does not know, that is a contract
 * violation to surface at the parse boundary, not a shrug in a chip.
 */
export function getRateLimitReasonDescriptor(
  reason: RateLimitReason,
): RateLimitReasonDescriptor {
  return RATE_LIMIT_REASON_DESCRIPTORS[reason];
}

export function getEpisodeDispositionDescriptor(
  disposition: EpisodeDisposition,
): EpisodeDispositionDescriptor {
  return EPISODE_DISPOSITION_DESCRIPTORS[disposition];
}

export function getQuotaPressureDescriptor(
  pressure: QuotaPressure,
): QuotaPressureDescriptor {
  return QUOTA_PRESSURE_DESCRIPTORS[pressure];
}
