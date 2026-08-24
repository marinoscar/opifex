/**
 * The check-coverage vocabulary — label, meaning, icon and colour token for
 * every `CheckStatus` (#104, epic #23).
 *
 * Follows `config/runStatus.ts`, `config/approvalStatus.ts` and
 * `config/trustStatus.ts` exactly, and for the same reasons: **config owns the
 * domain vocabulary, the theme owns the colour.** A descriptor names a
 * `StatusTokenKey`; it never carries a hex, so light and dark cannot drift
 * apart here.
 *
 * ## What is deliberately NOT in this file
 *
 * There is no table of the four checks. `WatchdogCheckId` is a closed union
 * and the API sends a `signal` and a `reason` for every entry, on every
 * status — those strings come from the same module that decides the statuses
 * (`apps/api/src/watchdog/check-coverage.ts`), so a client-side restatement of
 * what "loop detection" watches, or of why it is unavailable on a given
 * runner, could only ever drift away from the detector that actually runs. The
 * cockpit renders those strings verbatim and derives a check's display NAME
 * mechanically from its id (`watchdogFormat.ts`). This file grades the three
 * statuses and nothing else.
 *
 * ## No new hues, again on purpose
 *
 * `theme/tokens.ts` allocates exactly six status hues and asserts a luminance
 * separation between the confusable pairs. Three more colours would blow that
 * budget and teach the operator a fourth colour language on a screen they
 * reach at 2am. Each status REUSES a run-status token, mapped by MEANING:
 *
 *  - `active`      → `succeeded`  — green: the check protects the run as
 *                                   designed, and there is genuinely nothing
 *                                   to do about it.
 *  - `degraded`    → `stalled`    — amber, the loudest warm colour in the set:
 *                                   the check runs, but slower or coarser, and
 *                                   the operator is carrying that latency
 *                                   whether or not they know it.
 *  - `unavailable` → `blocked`    — the QUIETEST token in the set. See below;
 *                                   this is the load-bearing choice in the
 *                                   file.
 *
 * ## Why `unavailable` is grey, and why that is not timidity
 *
 * #104 exists to prevent exactly one failure:
 *
 * > A check that is **unavailable** must report itself as unavailable, not
 * > silently pass. A tool-loop detector that quietly does nothing on a
 * > non-streaming runner looks identical, in the cockpit, to one that ran and
 * > found no loop.
 *
 * Two renderings would each re-create that failure in their own way:
 *
 *  - **Green, or a tick, or anything that reads as "fine"** is the original
 *    lie with a nicer font. It is the one outcome this whole issue is about.
 *  - **Red, as an error**, is the opposite mistake and is nearly as bad.
 *    Nothing went WRONG. No check failed; a capability is simply absent, and
 *    it is not fixable except by changing runners. A red badge sends an
 *    operator hunting for a break that does not exist, and — worse — a red
 *    badge that can never be cleared is a red badge people learn to ignore,
 *    at which point the unavailable case is invisible again.
 *
 * So `blocked`'s slate is the right register: visibly DIFFERENT from both the
 * healthy checks and a failure, legible at a glance in a row of otherwise
 * green chips, and neutral about blame. `theme/tokens.ts` describes that token
 * as deliberately the quietest in the set — quiet is correct here, because the
 * message is "nothing is watching this", not "something broke".
 *
 * Colour is never the sole channel: `CheckStatusChip` renders icon + label +
 * colour, and the panel prints the API's `reason` under every row regardless of
 * status. An operator on a greyscale display, or with any colour vision
 * deficiency, reads the word "Unavailable" and the sentence explaining it.
 */

import type { SvgIconComponent } from '@mui/icons-material';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import type { StatusTokenKey } from '../theme/tokens';
import type { CheckStatus } from '../types/cockpit';
import { CHECK_STATUSES } from '../types/cockpit';

export interface CheckStatusDescriptor {
  status: CheckStatus;
  /** Sentence-case, shown verbatim in the chip. Never abbreviated. */
  label: string;
  /** One line: what the status means for the run being looked at. */
  description: string;
  Icon: SvgIconComponent;
  token: StatusTokenKey;
  /**
   * Is the failure mode this check guards actually guarded?
   *
   * True for `active` and `degraded` — degraded detection is late detection,
   * not absent detection. False only for `unavailable`, which is what the
   * panel's summary counts. A `weakest !== 'active'` predicate would have
   * lumped the two non-green states together, and the operator's decision is
   * different for each: degraded is a latency to accept, unavailable is a risk
   * to carry.
   */
  guarded: boolean;
}

/**
 * Every status, keyed. `Record<CheckStatus, …>` makes a missing key a compile
 * error the day the API's enum grows a fourth member — and the value most
 * likely to be added later is a WORSE one than `unavailable`, which is exactly
 * the thing that must not render as a blank.
 */
export const CHECK_STATUS_DESCRIPTORS: Record<
  CheckStatus,
  CheckStatusDescriptor
> = {
  active: {
    status: 'active',
    label: 'Active',
    description:
      'This check protects the run as designed. Nothing to do about it.',
    Icon: CheckCircleOutlinedIcon,
    token: 'succeeded',
    guarded: true,
  },
  degraded: {
    status: 'degraded',
    label: 'Degraded',
    description:
      'The check runs, but on a weaker signal or a coarser threshold. Detection will be slower or approximate — carry that knowingly.',
    Icon: WarningAmberOutlinedIcon,
    token: 'stalled',
    guarded: true,
  },
  unavailable: {
    status: 'unavailable',
    label: 'Unavailable',
    description:
      'The check cannot run at all on this runner. Nothing failed — a capability is absent — but the failure mode it guards is unguarded on this run, and no amount of green elsewhere changes that.',
    Icon: VisibilityOffOutlinedIcon,
    token: 'blocked',
    guarded: false,
  },
};

export function getCheckStatusDescriptor(
  status: CheckStatus,
): CheckStatusDescriptor {
  return CHECK_STATUS_DESCRIPTORS[status];
}

/**
 * The descriptors in severity order (`CHECK_STATUSES`: healthiest first).
 */
export const CHECK_STATUS_LIST: readonly CheckStatusDescriptor[] =
  CHECK_STATUSES.map((status) => CHECK_STATUS_DESCRIPTORS[status]);

/**
 * Is the failure mode this check guards actually being watched for?
 *
 * The predicate lives here rather than as a `!== 'unavailable'` written out in
 * every component — that is the shape of a rule a future fourth status quietly
 * escapes.
 */
export function isGuardedStatus(status: CheckStatus): boolean {
  return CHECK_STATUS_DESCRIPTORS[status].guarded;
}
