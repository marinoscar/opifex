import { useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Collapse,
  Container,
  Divider,
  Grid,
  Skeleton,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

import { ApprovalStatusChip } from '../components/approvals/ApprovalStatusChip';
import { TimeRemaining } from '../components/approvals/TimeRemaining';
import { describeIfIgnored } from '../components/approvals/ifIgnored';
import {
  describeEffect,
  formatEstimatedCost,
} from '../components/approvals/approvalFormat';
import {
  conflictHeadline,
  conflictNextStep,
} from '../components/approvals/decisionOutcome';
import { isOpenApproval } from '../config/approvalStatus';
import { useApproval } from '../hooks/useApprovals';
import { useApprovalDecision } from '../hooks/useApprovalDecision';
import type { ApprovalDecisionOutcome } from '../hooks/useApprovalDecision';
import { usePermissions } from '../hooks/usePermissions';
import { formatRelativeTime } from '../utils/time';
import type { ApprovalDetail } from '../types/approvals';

/** The two permissions `ApprovalsController` composes on a decision. */
const DECIDE_PERMISSION = 'approvals:decide';
const GRANT_PERMISSION = 'trust:grant';

/** The API's own ceiling on a decision note (`decideApprovalSchema`). */
const NOTE_MAX_LENGTH = 2000;

/**
 * `/approvals/:id` — the one-tap surface, and a phone-first one (#98, §8).
 *
 * The approval notification deep-links straight here, which is what decides
 * the layout. VISION §8's bar is explicit:
 *
 * > one tap from a phone, with enough context to decide — what, why, blast
 * > radius, and what happens if ignored.
 *
 * So those four are the first thing on the screen, above the fold on a phone,
 * before any chrome — and the three actions are directly beneath them. Every
 * other fact this page shows (the declared effects, the estimated cost, the
 * class definition, the target) is BELOW that block. Not because it is
 * unimportant, but because an approval that requires scrolling to answer is an
 * approval that gets answered later, and §8's whole argument is that
 * approvals which are expensive get blanket-granted "while annoyed rather than
 * while thinking".
 *
 * ## The link that brought you here carries no authority
 *
 * The notification is a URL and nothing more; the decision endpoint requires
 * the ordinary session with `approvals:decide`. That is one tap on a phone
 * already signed in and two when the session has lapsed, and the second tap is
 * the price of an approval being attributable to a person — see the docblock
 * on `ApprovalsController`.
 *
 * ## Nothing here decides anything the API has not
 *
 * The buttons hide or disable on `approvals:decide` and `trust:grant`, but
 * that is presentation: the API composes both permissions itself and refuses
 * the whole request when the second is missing. The UI's job is to not offer
 * what cannot happen — and, when the API refuses anyway (a session whose
 * permissions have gone stale is the ordinary case), to say plainly that
 * NOTHING WAS RECORDED.
 */
export default function ApprovalDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const approval = useApproval(id);
  const { hasPermission } = usePermissions();
  const decision = useApprovalDecision(id, approval.refresh);

  const canDecide = hasPermission(DECIDE_PERMISSION);
  const canGrant = hasPermission(GRANT_PERMISSION);

  return (
    <Container maxWidth="md" sx={{ px: { xs: 1.5, sm: 3 } }}>
      <Box sx={{ py: 2 }}>
        {approval.error && !approval.data && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {approval.error}
          </Alert>
        )}

        {!approval.data && !approval.error && <Skeleton height={200} />}

        {approval.data && (
          <>
            <ApprovalHeader approval={approval.data} />
            <DecideContext approval={approval.data} />

            <DecisionOutcomeBanner outcome={decision.outcome} />

            {isOpenApproval(approval.data.status) ? (
              <DecisionActions
                approval={approval.data}
                canDecide={canDecide}
                canGrant={canGrant}
                isDeciding={decision.isDeciding}
                onDecide={decision.decide}
              />
            ) : (
              <AlreadyResolved approval={approval.data} />
            )}

            <SupportingFacts approval={approval.data} />
          </>
        )}
      </Box>
    </Container>
  );
}

// ---------------------------------------------------------------------------
// Above the fold
// ---------------------------------------------------------------------------

function ApprovalHeader({ approval }: { approval: ApprovalDetail }) {
  const title = approval.actionClassEntry?.title ?? approval.actionClass;

  return (
    <>
      <Stack
        direction="row"
        spacing={1.5}
        sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1, mb: 0.5 }}
      >
        <Typography variant="h5" component="h1">
          {title}
        </Typography>
        <ApprovalStatusChip status={approval.status} size="medium" />
      </Stack>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block', mb: 2 }}
      >
        {approval.actionClass} · {approval.repositoryId} · raised{' '}
        {formatRelativeTime(approval.createdAt) ?? 'at an unknown time'}
      </Typography>
    </>
  );
}

/**
 * VISION §8's four fields, in §8's own order, in one card.
 *
 * One card rather than four, and no accordions: every one of these is required
 * to answer the question, so none of them may cost a tap to reveal.
 */
function DecideContext({ approval }: { approval: ApprovalDetail }) {
  const ignored = describeIfIgnored(approval.timeoutPolicy, approval.timeoutAt);

  return (
    <Card sx={{ mb: 2 }}>
      <CardContent sx={{ display: 'grid', gap: 2 }}>
        <Field label="What">
          <Typography variant="h6" component="p" sx={{ fontWeight: 500 }}>
            {approval.summary}
          </Typography>
        </Field>

        <Field label="Why">
          <Typography variant="body1">{approval.reasoning}</Typography>
        </Field>

        <Field label="Blast radius">
          <Typography variant="body1">{approval.blastRadius}</Typography>
        </Field>

        <Field label="What happens if ignored">
          <Typography
            variant="body1"
            sx={{ fontWeight: ignored.waitsForever ? 600 : 400 }}
          >
            {ignored.sentence}
          </Typography>
          {/*
            The countdown is rendered ONLY when there is a real instant to
            count down to. A parked approval gets no countdown element at all —
            not an em dash, not a disabled timer. An empty slot where a
            deadline goes still reads as a deadline, and an operator who
            believes a deadline exists will let it lapse expecting something to
            happen. Nothing will.
          */}
          {ignored.countdownAt && (
            <Box sx={{ mt: 1 }}>
              <TimeRemaining timeoutAt={ignored.countdownAt} variant="body1" />
            </Box>
          )}
        </Field>
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Box>
      <Typography
        variant="overline"
        color="text.secondary"
        sx={{ display: 'block', lineHeight: 1.6 }}
      >
        {label}
      </Typography>
      {children}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// The three actions
// ---------------------------------------------------------------------------

/**
 * Why "Always approve this class" cannot be offered, or null when it can.
 *
 * Three separate reasons, and they are kept separate because they call for
 * different things from the operator: one is fixed by finding an admin, one is
 * a registry drift worth reporting, and one is permanent by design.
 */
export function alwaysApproveBlockedReason(
  approval: ApprovalDetail,
  canGrant: boolean,
): string | null {
  if (!canGrant) {
    return `Creating a trust grant needs the "${GRANT_PERMISSION}" permission, which is an admin one. You can still approve or deny this single action.`;
  }
  if (!approval.actionClassEntry) {
    return 'The action-class registry does not recognise this class, so no grant can be created for it. Approving this single action still works.';
  }
  if (!approval.actionClassEntry.autonomyEligible) {
    return 'This class can never run unattended, so it can never receive a trust grant. Approving this single action still works.';
  }
  return null;
}

function DecisionActions({
  approval,
  canDecide,
  canGrant,
  isDeciding,
  onDecide,
}: {
  approval: ApprovalDetail;
  canDecide: boolean;
  canGrant: boolean;
  isDeciding: boolean;
  onDecide: (input: {
    decision: 'approve' | 'deny';
    note?: string;
    alwaysApproveThisClass?: boolean;
  }) => Promise<void>;
}) {
  const [note, setNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);

  const blockedReason = alwaysApproveBlockedReason(approval, canGrant);
  const trimmed = note.trim();
  const withNote = trimmed ? { note: trimmed } : {};

  if (!canDecide) {
    return (
      <Alert severity="info" sx={{ mb: 2 }}>
        You can read this approval but not answer it. Deciding needs{' '}
        <code>{DECIDE_PERMISSION}</code>, which is the permission the API
        enforces.
      </Alert>
    );
  }

  return (
    <Card sx={{ mb: 2 }}>
      <CardContent>
        <Button
          size="small"
          onClick={() => setNoteOpen((open) => !open)}
          sx={{ mb: noteOpen ? 1 : 0 }}
        >
          {noteOpen ? 'Hide note' : 'Add a note (optional)'}
        </Button>
        <Collapse in={noteOpen}>
          <TextField
            fullWidth
            multiline
            minRows={2}
            size="small"
            label="Note"
            value={note}
            onChange={(event) =>
              setNote(event.target.value.slice(0, NOTE_MAX_LENGTH))
            }
            slotProps={{ htmlInput: { maxLength: NOTE_MAX_LENGTH } }}
            helperText={`${note.length}/${NOTE_MAX_LENGTH}. A fast verdict with no prose is still a verdict.`}
            sx={{ mb: 2 }}
          />
        </Collapse>

        {/*
          Deny on the left, Approve on the right, both `size="large"` — the
          same idiom (and the same colours) as the device-activation screen,
          because it is the same act. One approve/deny shape across the app is
          worth more than a bespoke one here.
        */}
        <Stack direction="row" spacing={2} sx={{ mt: 1 }}>
          <Button
            fullWidth
            size="large"
            variant="outlined"
            color="error"
            disabled={isDeciding}
            onClick={() => onDecide({ decision: 'deny', ...withNote })}
          >
            Deny
          </Button>
          <Button
            fullWidth
            size="large"
            variant="contained"
            color="success"
            disabled={isDeciding}
            startIcon={
              isDeciding ? (
                <CircularProgress size={18} color="inherit" />
              ) : undefined
            }
            onClick={() => onDecide({ decision: 'approve', ...withNote })}
          >
            Approve
          </Button>
        </Stack>

        {/*
          VISION §8's third option. It is DISABLED rather than hidden when it
          cannot work, because the reason is worth reading: "this class can
          never receive a grant" is a fact about the action the operator is
          judging, and silently removing the button teaches them nothing.
        */}
        <Button
          fullWidth
          size="large"
          variant="outlined"
          sx={{ mt: 2 }}
          disabled={isDeciding || blockedReason !== null}
          onClick={() =>
            onDecide({
              decision: 'approve',
              alwaysApproveThisClass: true,
              ...withNote,
            })
          }
        >
          Always approve this class
        </Button>
        {blockedReason ? (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', mt: 1 }}
          >
            {blockedReason}
          </Typography>
        ) : (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', mt: 1 }}
          >
            Approves this action and creates a trust grant scoped to this class
            and repository, with an expiry, a budget ceiling and automatic
            revocation. It is never a permanent global grant.
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// What happened to the decision
// ---------------------------------------------------------------------------

function DecisionOutcomeBanner({
  outcome,
}: {
  outcome: ApprovalDecisionOutcome | null;
}) {
  if (!outcome) return null;

  if (outcome.kind === 'recorded') {
    const { result } = outcome;
    const verdict =
      result.approval.status === 'approved' ? 'Approved' : 'Denied';

    return (
      <Stack spacing={1} sx={{ mb: 2 }}>
        <Alert severity="success">
          <AlertTitle>{verdict}, and recorded as yours.</AlertTitle>
          {result.createdGrantId && (
            <>
              A trust grant was created ({result.createdGrantId}). It is scoped
              to this action class and repository, expires on its own, dies at a
              cumulative spend, and revokes itself if the class starts
              misbehaving.
            </>
          )}
        </Alert>

        {/*
          The flag was set and no grant resulted. SHOW IT — a flag that quietly
          does nothing is how somebody comes to believe they hold trust they do
          not, and stops watching a class nobody promoted.
        */}
        {result.grantSkippedReason && (
          <Alert severity="warning">
            <AlertTitle>
              Your decision applied. No trust grant was created.
            </AlertTitle>
            {result.grantSkippedReason}
          </Alert>
        )}

        {result.decidedAfterTimeout && (
          <Alert severity="info">
            The timeout window had already closed when you answered. Your
            decision was honoured anyway and is recorded as a human decision —
            the sweeper had not reached the row yet.
          </Alert>
        )}
      </Stack>
    );
  }

  if (outcome.kind === 'trust-grant-required') {
    return (
      <Alert severity="error" sx={{ mb: 2 }}>
        {/*
          The single most important sentence on this page. `details
          .decisionApplied` is `false`: the WHOLE request was refused, not just
          the grant, so the operator must not walk away believing they approved
          anything.
        */}
        <AlertTitle>
          Nothing was recorded. This approval is still open.
        </AlertTitle>
        {outcome.message}
      </Alert>
    );
  }

  if (outcome.kind === 'conflict') {
    const nextStep = conflictNextStep(outcome.reason);
    return (
      <Alert
        severity="warning"
        sx={{ mb: 2 }}
        data-conflict-reason={outcome.reason}
      >
        <AlertTitle>{conflictHeadline(outcome.reason)}</AlertTitle>
        {outcome.message}
        {nextStep && (
          <Typography variant="body2" sx={{ mt: 1 }}>
            {nextStep}
          </Typography>
        )}
      </Alert>
    );
  }

  if (outcome.kind === 'gone') {
    return (
      <Alert severity="error" sx={{ mb: 2 }}>
        <AlertTitle>This approval no longer exists.</AlertTitle>
        {outcome.message}
      </Alert>
    );
  }

  return (
    <Alert severity="error" sx={{ mb: 2 }}>
      <AlertTitle>Your decision was not recorded.</AlertTitle>
      {outcome.message}
    </Alert>
  );
}

function AlreadyResolved({ approval }: { approval: ApprovalDetail }) {
  const when = approval.decidedAt
    ? (formatRelativeTime(approval.decidedAt) ?? approval.decidedAt)
    : 'at an unrecorded time';

  const via =
    approval.decidedVia === 'human'
      ? 'a person'
      : approval.decidedVia === 'grant'
        ? 'a standing trust grant'
        : approval.decidedVia === 'timeout'
          ? 'its recorded timeout policy, with nobody looking'
          : 'nothing this page can name';

  return (
    <Alert severity="info" sx={{ mb: 2 }}>
      <AlertTitle>There is nothing left to decide here.</AlertTitle>
      This request was resolved {when} by {via}.
      {approval.decisionNote && ` Note: ${approval.decisionNote}`}
    </Alert>
  );
}

// ---------------------------------------------------------------------------
// Below the fold
// ---------------------------------------------------------------------------

function SupportingFacts({ approval }: { approval: ApprovalDetail }) {
  const entry = approval.actionClassEntry;

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          What it would do
        </Typography>
        <Divider sx={{ mb: 2 }} />

        {approval.effects.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            This request declared no effects. The gate freezes what an action
            would do at raise time, so an empty list means the proposer declared
            nothing — not that the action does nothing.
          </Typography>
        ) : (
          <Stack spacing={1}>
            {approval.effects.map((effect, index) => {
              const described = describeEffect(effect);
              return (
                <Stack
                  // Effects have no ids and are a frozen list; the index is
                  // stable for as long as the row exists.
                  key={`${described.kind}-${index}`}
                  direction="row"
                  spacing={1}
                  sx={{ alignItems: 'baseline', flexWrap: 'wrap', rowGap: 0.5 }}
                >
                  <Chip
                    size="small"
                    variant="outlined"
                    label={described.kind}
                  />
                  <Typography variant="body2" color="text.secondary">
                    {described.detail}
                  </Typography>
                </Stack>
              );
            })}
          </Stack>
        )}

        <Grid container spacing={2} sx={{ mt: 2 }}>
          <Fact
            label="Estimated cost"
            // Null is UNKNOWN, not zero: an action the gate could not price is
            // not a free action, and this is the figure a budget check needs.
            value={formatEstimatedCost(approval.estimatedCostUsd)}
          />
          <Fact
            label="Reversibility"
            value={
              entry?.reversibility ?? 'Unknown — class not in the registry'
            }
          />
          <Fact label="Timeout policy" value={approval.timeoutPolicy} />
          <Fact
            label="Spends money"
            value={entry ? (entry.spendsMoney ? 'Yes' : 'No') : 'Unknown'}
          />
          <Fact label="Repository" value={approval.repositoryId} />
          <Fact
            label="Target"
            value={
              approval.targetRef
                ? `${approval.targetKind ?? 'target'}: ${approval.targetRef}`
                : 'None recorded'
            }
          />
        </Grid>

        <Box sx={{ mt: 3 }}>
          <Typography variant="overline" color="text.secondary">
            What this class means
          </Typography>
          {entry ? (
            <>
              <Typography variant="body2" sx={{ mb: 1 }}>
                {entry.definition}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Approving one changes this outside the control plane:{' '}
                {entry.effect}
              </Typography>
            </>
          ) : (
            <Alert severity="warning" sx={{ mt: 1 }}>
              The registry does not recognise{' '}
              <code>{approval.actionClass}</code>. An unrecognised class is
              parked rather than acted on, so this most likely means the
              proposer and the registry have drifted — not that an irreversible
              action is waiting.
            </Alert>
          )}
        </Box>

        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mt: 3, fontVariantNumeric: 'tabular-nums' }}
        >
          Approval {approval.id}
          {approval.proposalId && ` · proposal ${approval.proposalId}`}
          {approval.escalationId && ` · escalation ${approval.escalationId}`}
        </Typography>
      </CardContent>
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <Grid size={{ xs: 6, sm: 4 }}>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block' }}
      >
        {label}
      </Typography>
      <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
        {value}
      </Typography>
    </Grid>
  );
}
