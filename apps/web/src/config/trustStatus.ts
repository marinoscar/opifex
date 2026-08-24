/**
 * The trust vocabulary — label, meaning, icon and colour token for every grant
 * status, every end reason and every promotion rung (#101, epic #22).
 *
 * Follows `config/approvalStatus.ts` exactly, and for the same reasons:
 * **config owns the domain vocabulary, the theme owns the colour.** A
 * descriptor names a `StatusTokenKey`; it never carries a hex, so light and
 * dark cannot drift apart here.
 *
 * ## No new hues, again on purpose
 *
 * `theme/tokens.ts` allocates exactly six status hues and asserts a luminance
 * separation between the confusable pairs. Four grant statuses and three rungs
 * claiming seven more colours would blow that budget and, worse, would teach
 * the operator a third colour language on a screen they reach at 2am. So each
 * one REUSES a run-status token, mapped by MEANING:
 *
 *  - `active`    → `running`     — cyan: it is live and authorizing work now.
 *  - `expired`   → `blocked`     — the quietest token in the set. VISION §8's
 *                                  "silence revokes" is the DESIGN working,
 *                                  not an incident; it must not compete for
 *                                  the eye with a grant that misbehaved.
 *  - `revoked`   → `failed`      — a human deliberately stopped it, the same
 *                                  act `denied` records on an approval.
 *  - `suspended` → `quarantined` — the off-axis hue, because this is the state
 *                                  no machine will clear. Nothing re-creates a
 *                                  suspended grant; only a human tapping
 *                                  "always approve this class" can. Identical
 *                                  in kind to what `parked` claims.
 *
 * And for the rungs (VISION §7's ladder, one rung short — `quarantine` lives
 * on the class registry rather than here):
 *
 *  - `observe`  → `blocked`   — no human has judged this even once. An absence
 *                               of evidence is not a warning.
 *  - `measure`  → `running`   — evidence is accruing. Active, neutral.
 *  - `promoted` → `succeeded` — eligible for a grant. Note "eligible": the
 *                               ladder never mints one.
 *
 * ## The two headroom warnings share ONE token, and it is `stalled`
 *
 * `nearExpiry` and `nearBudget` are the amber the whole grants table exists to
 * make visible at a glance (#101's second criterion). Amber is the loudest
 * warm colour in the set and is documented as "this one wants a kill" — which
 * is precisely the reading: a grant about to lapse or about to exhaust its
 * ceiling wants a human to decide whether it should continue. It is never the
 * sole channel; the cell carries the words too.
 *
 * Colour is never the sole channel anywhere here: every chip renders icon +
 * label + colour, the same code rule `StatusChip` and `ApprovalStatusChip`
 * enforce.
 */

import type { SvgIconComponent } from '@mui/icons-material';
import BoltIcon from '@mui/icons-material/Bolt';
import TimerOffIcon from '@mui/icons-material/TimerOff';
import BlockIcon from '@mui/icons-material/Block';
import PauseCircleOutlinedIcon from '@mui/icons-material/PauseCircleOutlined';
import VisibilityIcon from '@mui/icons-material/Visibility';
import QueryStatsIcon from '@mui/icons-material/QueryStats';
import VerifiedIcon from '@mui/icons-material/Verified';
import type { StatusTokenKey } from '../theme/tokens';
import type {
  PromotionRung,
  TrustGrantEndReason,
  TrustGrantStatus,
} from '../types/trust';

export interface TrustGrantStatusDescriptor {
  status: TrustGrantStatus;
  /** Sentence-case, shown verbatim in the chip. */
  label: string;
  /** One line: what the state means and what, if anything, to do about it. */
  description: string;
  Icon: SvgIconComponent;
  token: StatusTokenKey;
  /** Is this grant still authorizing work? Exactly one status is. */
  authorizing: boolean;
}

/**
 * Every grant status, keyed. `Record<TrustGrantStatus, …>` makes a missing key
 * a compile error the day the API's enum grows a fifth member.
 */
export const TRUST_GRANT_STATUS_DESCRIPTORS: Record<
  TrustGrantStatus,
  TrustGrantStatusDescriptor
> = {
  active: {
    status: 'active',
    label: 'Active',
    description:
      'This class may run unattended in this repository right now, within the four attributes below.',
    Icon: BoltIcon,
    token: 'running',
    authorizing: true,
  },
  expired: {
    status: 'expired',
    label: 'Expired',
    description:
      'It reached its expiry and stopped on its own. Nobody had to do anything — that is the design, not an incident.',
    Icon: TimerOffIcon,
    token: 'blocked',
    authorizing: false,
  },
  revoked: {
    status: 'revoked',
    label: 'Revoked',
    description:
      'A person stopped it. Revocation is permanent: restoring trust means issuing a new grant.',
    Icon: BlockIcon,
    token: 'failed',
    authorizing: false,
  },
  suspended: {
    status: 'suspended',
    label: 'Suspended',
    description:
      'The system stopped it on evidence. Nothing re-creates a suspended grant; only a person can grant trust again.',
    Icon: PauseCircleOutlinedIcon,
    token: 'quarantined',
    authorizing: false,
  },
};

export function getTrustGrantStatusDescriptor(
  status: TrustGrantStatus,
): TrustGrantStatusDescriptor {
  return TRUST_GRANT_STATUS_DESCRIPTORS[status];
}

/** Is this grant still authorizing unattended work? */
export function isAuthorizingGrant(status: TrustGrantStatus): boolean {
  return TRUST_GRANT_STATUS_DESCRIPTORS[status].authorizing;
}

/**
 * How each end reason reads in a sentence.
 *
 * These are LABELS, not explanations: the explanation is `endDetail`, the
 * sentence the service wrote naming the actual numbers, and every surface that
 * shows a reason shows that alongside it.
 */
export const TRUST_GRANT_END_REASON_LABELS: Record<
  TrustGrantEndReason,
  string
> = {
  manual_revocation: 'Revoked by a person',
  expired: 'Reached its expiry',
  budget_exhausted: 'Spent its budget ceiling',
  failure_rate_exceeded: 'Failure rate crossed its ceiling',
  cost_per_action_exceeded: 'One action cost more than its per-action ceiling',
  class_demoted: 'The class was demoted off the ladder',
  superseded_by_renewal: 'Replaced by a renewal',
};

export function endReasonLabel(reason: TrustGrantEndReason | null): string {
  // Never invented. A row that ended with no recorded reason says so, because
  // "we do not know why autonomy stopped" is itself worth reading.
  return reason === null
    ? 'No recorded reason'
    : TRUST_GRANT_END_REASON_LABELS[reason];
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

export interface PromotionRungDescriptor {
  rung: PromotionRung;
  label: string;
  description: string;
  Icon: SvgIconComponent;
  token: StatusTokenKey;
}

export const PROMOTION_RUNG_DESCRIPTORS: Record<
  PromotionRung,
  PromotionRungDescriptor
> = {
  observe: {
    rung: 'observe',
    label: 'Observe',
    description:
      'No person has judged this class even once. There is nothing to measure yet.',
    Icon: VisibilityIcon,
    token: 'blocked',
  },
  measure: {
    rung: 'measure',
    label: 'Measure',
    description:
      'Evidence is accruing. Every human approval or refusal of this class counts towards the bar.',
    Icon: QueryStatsIcon,
    token: 'running',
  },
  promoted: {
    rung: 'promoted',
    label: 'Promoted',
    description:
      'Eligible for a trust grant. It does NOT mean anything is running unattended — a promoted class with no grant runs nothing.',
    Icon: VerifiedIcon,
    token: 'succeeded',
  },
};

export function getPromotionRungDescriptor(
  rung: PromotionRung,
): PromotionRungDescriptor {
  return PROMOTION_RUNG_DESCRIPTORS[rung];
}
