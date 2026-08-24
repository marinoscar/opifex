/**
 * The promotion ladder, per action class (#101, epic #22, VISION §7).
 *
 * Four things per class, and #101 names all four: the current rung, the
 * approval rate, the sample size, and **what would be needed to promote**.
 *
 * ## `requirement` is rendered VERBATIM, and that is the point of the panel
 *
 * The API returns the policy layer's own sentence. This component prints it
 * and does nothing else with it — no parsing, no recomputation from
 * `thresholds`, no "2 more needed" derived alongside it, no suffix. #101's
 * argument is that making the requirement visible is what turns the ladder
 * from an opaque mechanism into something an operator can reason about; a
 * second implementation of the thresholds in this file would defeat exactly
 * that, because the day a threshold is tuned the screen would state a
 * requirement that no longer applies while looking just as authoritative.
 *
 * `thresholds` IS used — but only to describe the policy in the panel header,
 * never to decide what any class needs.
 *
 * ## `enabled: false` is stated first, loudly, and it is the common case
 *
 * The ladder defaults off. A screen full of rungs that does not say so reads
 * as a set of live conclusions when in fact nothing has moved and nothing
 * will — and `wouldChange: 'promote'` sitting on a class indefinitely while
 * the ladder is switched off is the single most important thing this endpoint
 * can tell an operator. Both halves are shown together.
 *
 * ## `rate: null` is "no evidence yet", never 0%
 *
 * A 0% approval rate claims humans refuse this class every single time they
 * see it. An `observe` class is DEFINED by having no sample, so this is the
 * ordinary state rather than an edge case.
 */

import { useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { PromotionRungChip } from './PromotionRungChip';
import { DemoteClassDialog } from './DemoteClassDialog';
import { formatApprovalRate, formatPercent } from './trustFormat';
import { statusTokens } from '../../theme/tokens';
import { formatRelativeTime } from '../../utils/time';
import type {
  ClassEvidence,
  PromotionLadder,
  PromotionState,
  PromotionThresholds,
} from '../../types/trust';

/** The permission `PromotionController.demote` really enforces. */
export const DEMOTE_PERMISSION = 'trust:revoke';

export interface PromotionLadderPanelProps {
  ladder: PromotionLadder;
  canDemote: boolean;
  demotingClass: string | null;
  onDemote: (actionClass: string, note?: string) => void;
}

export function PromotionLadderPanel({
  ladder,
  canDemote,
  demotingClass,
  onDemote,
}: PromotionLadderPanelProps) {
  return (
    <Box>
      <LadderSwitchBanner ladder={ladder} />
      <ThresholdSummary thresholds={ladder.thresholds} />

      {ladder.states.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
          No action class has a recorded rung yet. A class appears here once the
          ladder has looked at it.
        </Typography>
      ) : (
        <Stack spacing={2}>
          {ladder.states.map((state) => (
            <PromotionStateCard
              key={state.actionClass}
              state={state}
              ladderEnabled={ladder.enabled}
              canDemote={canDemote}
              isDemoting={demotingClass === state.actionClass}
              onDemote={onDemote}
            />
          ))}
        </Stack>
      )}
    </Box>
  );
}

/**
 * Whether the ladder is switched on at all.
 *
 * `warning` rather than `info` when it is off, and it renders ABOVE every
 * rung. It is not an error — the default is off deliberately, the same rule
 * every outward-acting switch in this API follows — but it changes the meaning
 * of everything below it, and an operator who scrolls past it has been misled
 * by the screen rather than by the data.
 */
function LadderSwitchBanner({ ladder }: { ladder: PromotionLadder }) {
  const pendingChanges = ladder.states.filter(
    (state) => state.wouldChange !== null,
  );

  if (!ladder.enabled) {
    return (
      <Alert severity="warning" sx={{ mb: 2 }} data-testid="ladder-disabled">
        <AlertTitle>The promotion ladder is switched off.</AlertTitle>
        No class will be promoted or demoted, and no notification will be sent,
        however its evidence reads. The rungs below are the LAST recorded
        positions, not live conclusions.
        {pendingChanges.length > 0 && (
          <Box component="span" sx={{ display: 'block', mt: 1 }}>
            {pendingChanges.length}{' '}
            {pendingChanges.length === 1 ? 'class has' : 'classes have'}{' '}
            evidence that would move{' '}
            {pendingChanges.length === 1 ? 'it' : 'them'} if it were on. Nothing
            will act on that while the ladder is off.
          </Box>
        )}
        <Box component="span" sx={{ display: 'block', mt: 1 }}>
          Existing trust grants are unaffected and keep authorizing work. They
          enforce their own expiry, budget ceiling and auto-revoke thresholds
          regardless.
        </Box>
      </Alert>
    );
  }

  return (
    <Alert severity="info" sx={{ mb: 2 }} data-testid="ladder-enabled">
      <AlertTitle>The promotion ladder is on.</AlertTitle>
      Rungs move on evidence, on the hourly evaluation. A promoted class is
      ELIGIBLE for a trust grant — the ladder never mints one, so a promoted
      class with no grant runs nothing.
    </Alert>
  );
}

/**
 * The policy the `requirement` sentences refer to, in one line.
 *
 * Present so a reader can see the shape of the rule without this component
 * ever applying it to a class. The numbers come from the response, not from a
 * constant in this app.
 */
function ThresholdSummary({ thresholds }: { thresholds: PromotionThresholds }) {
  return (
    <Typography
      variant="caption"
      color="text.secondary"
      sx={{ display: 'block', mb: 2 }}
    >
      Policy: promote at {formatPercent(thresholds.promotionRate)} approval over
      at least {thresholds.minSample} human decisions; demote below{' '}
      {formatPercent(thresholds.demotionRate)} over at least{' '}
      {thresholds.demotionMinSample} in the last{' '}
      {thresholds.regressionWindowDays} days.
    </Typography>
  );
}

function PromotionStateCard({
  state,
  ladderEnabled,
  canDemote,
  isDemoting,
  onDemote,
}: {
  state: PromotionState;
  ladderEnabled: boolean;
  canDemote: boolean;
  isDemoting: boolean;
  onDemote: (actionClass: string, note?: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const title = state.actionClassTitle ?? state.actionClass;
  const evidence = state.currentEvidence;

  return (
    <Card data-testid="promotion-state" data-action-class={state.actionClass}>
      <CardContent>
        <Stack
          direction="row"
          spacing={1.5}
          sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1, mb: 0.5 }}
        >
          <Typography variant="h6" component="h3">
            {title}
          </Typography>
          <PromotionRungChip rung={state.rung} />
          {/* Promoting something for the fourth time is a different act from
              promoting it once. The counter is shown only when it is non-zero,
              because "demoted 0 times" is noise on every class that has never
              had a problem. */}
          {state.demotionCount > 0 && (
            <Tooltip
              title="A class that oscillates is evidence about the thresholds rather than about the class."
              enterTouchDelay={0}
            >
              <Chip
                size="small"
                variant="outlined"
                label={`Demoted ${state.demotionCount}${state.demotionCount === 1 ? ' time' : ' times'}`}
                data-testid="demotion-count"
              />
            </Tooltip>
          )}
          {!state.eligible && (
            <Tooltip
              title="The registry marks this class ineligible for autonomy. That is permanent, not a state to be waited out."
              enterTouchDelay={0}
            >
              <Chip
                size="small"
                variant="outlined"
                label="Never promotable"
                data-testid="ineligible"
              />
            </Tooltip>
          )}
        </Stack>

        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mb: 2 }}
        >
          {state.actionClass} · rung set{' '}
          {formatRelativeTime(state.changedAt) ?? 'at an unknown time'}
          {state.changeDetail ? ` · ${state.changeDetail}` : ''}
        </Typography>

        <EvidenceLine evidence={evidence} />

        <Divider sx={{ my: 2 }} />

        {/* THE SENTENCE, VERBATIM. Nothing is appended to it and nothing is
            derived from it — see this file's header. */}
        <Typography
          variant="overline"
          color="text.secondary"
          sx={{ display: 'block', lineHeight: 1.6 }}
        >
          What it would take
        </Typography>
        <Typography variant="body1" data-testid="promotion-requirement">
          {state.requirement}
        </Typography>

        <WouldChangeLine state={state} ladderEnabled={ladderEnabled} />

        {state.rung === 'promoted' && (
          <>
            <Divider sx={{ my: 2 }} />
            <DemoteAction
              canDemote={canDemote}
              isDemoting={isDemoting}
              onOpen={() => setConfirming(true)}
            />
          </>
        )}
      </CardContent>

      <DemoteClassDialog
        open={confirming}
        className={title}
        isDemoting={isDemoting}
        onCancel={() => setConfirming(false)}
        onConfirm={(note) => {
          setConfirming(false);
          onDemote(state.actionClass, note);
        }}
      />
    </Card>
  );
}

/**
 * The rate, the sample, and where the sample came from.
 *
 * The split matters and the rate alone hides it: a class promoted entirely on
 * supervisor review-queue judgements has never actually been asked for in
 * production, which is a different quality of evidence from twenty live
 * approvals.
 */
function EvidenceLine({ evidence }: { evidence: ClassEvidence }) {
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={{ xs: 1, sm: 3 }}
      sx={{ flexWrap: 'wrap', rowGap: 1 }}
    >
      <Figure
        label="Approval rate"
        value={formatApprovalRate(evidence.rate)}
        muted={evidence.rate === null}
        testId="approval-rate"
      />
      <Figure
        label="Sample"
        value={`${evidence.sample} decision${evidence.sample === 1 ? '' : 's'}`}
        muted={evidence.sample === 0}
        testId="sample-size"
      />
      <Figure
        label="Approved / rejected"
        value={`${evidence.approved} / ${evidence.rejected}`}
      />
      <Figure
        label={`Recent (${evidence.recentSample})`}
        value={formatApprovalRate(evidence.recentRate)}
        muted={evidence.recentRate === null}
      />
      <Figure
        label="From review / approvals"
        value={`${evidence.fromProposals} / ${evidence.fromApprovals}`}
      />
    </Stack>
  );
}

function Figure({
  label,
  value,
  muted = false,
  testId,
}: {
  label: string;
  value: string;
  muted?: boolean;
  testId?: string;
}) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block' }}
      >
        {label}
      </Typography>
      <Typography
        variant="body2"
        color={muted ? 'text.secondary' : 'text.primary'}
        sx={{ fontVariantNumeric: 'tabular-nums' }}
        data-testid={testId}
      >
        {value}
      </Typography>
    </Box>
  );
}

/**
 * The forecast, and whether anything will act on it.
 *
 * Never shown as a bare "will be promoted": `wouldChange` is what the next
 * evaluation WOULD do, and when the ladder is off no evaluation is coming. The
 * two facts are printed in the same sentence so they cannot be read apart.
 */
function WouldChangeLine({
  state,
  ladderEnabled,
}: {
  state: PromotionState;
  ladderEnabled: boolean;
}) {
  const theme = useTheme();
  const token =
    statusTokens[theme.palette.mode === 'dark' ? 'dark' : 'light'].stalled;

  if (state.wouldChange === null) return null;

  const verb = state.wouldChange === 'promote' ? 'promote' : 'demote';

  return (
    <Typography
      variant="body2"
      sx={{ mt: 1, color: ladderEnabled ? token.fg : 'text.secondary' }}
      data-testid="would-change"
    >
      {ladderEnabled
        ? `The next evaluation would ${verb} this class.`
        : `On this evidence the ladder would ${verb} this class — but it is switched off, so nothing will.`}
    </Typography>
  );
}

function DemoteAction({
  canDemote,
  isDemoting,
  onOpen,
}: {
  canDemote: boolean;
  isDemoting: boolean;
  onOpen: () => void;
}) {
  if (!canDemote) {
    // DISABLED rather than hidden, with the reason. Narrowing autonomy is the
    // safe direction, and an operator who can see a class misbehaving deserves
    // to know which permission stands between them and stopping it — rather
    // than a screen with no button and no explanation.
    return (
      <Box>
        <Button variant="outlined" color="error" disabled>
          Demote this class
        </Button>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mt: 1 }}
        >
          Demoting needs the <code>{DEMOTE_PERMISSION}</code> permission, which
          is what the API enforces.
        </Typography>
      </Box>
    );
  }

  return (
    <Box>
      <Button
        variant="outlined"
        color="error"
        disabled={isDemoting}
        onClick={onOpen}
      >
        Demote this class
      </Button>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block', mt: 1 }}
      >
        Suspends every active trust grant for this class. The suspension is
        durable; the rung may be restored by the next evaluation.
      </Typography>
    </Box>
  );
}

export default PromotionLadderPanel;
