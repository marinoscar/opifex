/**
 * `/steering` — say what the factory should work on, see the diff, confirm it
 * (#426, epic #419).
 *
 * ## This is not a chat that does things
 *
 * It is a chat that shows what it is about to do. An instruction produces a
 * PROPOSAL — a concrete list of `factory:ready` / `factory:hold` operations
 * with the blast radius stated over it — and a second, deliberate press writes
 * anything at all. There is no branch anywhere in this page, this hook or the
 * API client where a proposal applies itself: not for a confident parse, not
 * for a one-issue diff, not for an instruction with no removals in it. VISION
 * §3.6 requires that no model output take effect without passing through
 * deterministic policy, and here the policy is a person reading the list.
 *
 * ## It writes labels and keeps no scope of its own
 *
 * The confirmed diff lands as GitHub labels, exactly as hold and release do
 * from the queue screen, and Opifex stores nothing about the instruction
 * beyond the audit row the API files. That is why the proposal is held in this
 * component tree and handed back on apply — there is no row to refer to, on
 * purpose, because a stored scope and the labels would be two expressions of
 * the same intent for the reconciler to arbitrate between.
 *
 * ## The transcript keeps what failed
 *
 * Turns are appended, never replaced. A stale proposal, a refused apply and a
 * run where four issues drifted stay on screen under the instruction that
 * produced them, because the alternative is a surface where the only visible
 * state is the last thing that worked.
 */

import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Container,
  LinearProgress,
  Paper,
  Stack,
  Typography,
} from '@mui/material';

import { ApplyReport } from '../components/steering/ApplyReport';
import { InstructionComposer } from '../components/steering/InstructionComposer';
import { ProposalReview } from '../components/steering/ProposalReview';
import { applyRefusal, proposeRefusal } from '../config/steeringChat';
import { useSteering, type SteeringTurn } from '../hooks/useSteering';
import type { SteeringOperation } from '../types/steering';

export default function SteeringPage() {
  const { turns, pending, isProposing, isApplying, propose, apply, discard } =
    useSteering();

  return (
    <Container maxWidth="md" sx={{ py: 3 }}>
      <Typography variant="h4" gutterBottom>
        Steering
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 2 }}>
        Say what the factory should work on. Every instruction comes back as a
        list of label changes with the number of issues it touches — including
        the ones it would un-ready that you did not name — and nothing is
        written to GitHub until you confirm that list.
      </Typography>

      <Stack spacing={2}>
        {turns.length === 0 && (
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="body2" color="text.secondary">
              Nothing has been proposed yet. Steering writes only factory:ready
              and factory:hold, one issue at a time, and the reconciler acts on
              those labels on its next tick — this screen cannot dispatch,
              cancel or approve anything.
            </Typography>
          </Paper>
        )}

        {turns.map((turn) => (
          <TurnView
            key={turn.id}
            turn={turn}
            isPending={
              turn.kind === 'proposal' &&
              pending?.proposalId === turn.proposal.proposalId
            }
            isApplying={isApplying}
            onApply={(operations) => {
              if (turn.kind === 'proposal') apply(turn.proposal, operations);
            }}
            onDiscard={discard}
            onRetryInstruction={(instruction) => propose(instruction)}
          />
        ))}

        {isProposing && (
          <Box>
            <Typography variant="caption" color="text.secondary">
              Reading the backlog to work out what this would change. Nothing is
              written while this runs.
            </Typography>
            <LinearProgress sx={{ mt: 0.5 }} />
          </Box>
        )}
      </Stack>

      <InstructionComposer disabled={isProposing} onPropose={propose} />
    </Container>
  );
}

function TurnView({
  turn,
  isPending,
  isApplying,
  onApply,
  onDiscard,
  onRetryInstruction,
}: {
  turn: SteeringTurn;
  isPending: boolean;
  isApplying: boolean;
  onApply: (operations: SteeringOperation[]) => void;
  onDiscard: () => void;
  onRetryInstruction: (instruction: string) => void;
}) {
  if (turn.kind === 'instruction') {
    return (
      <Paper variant="outlined" sx={{ p: 2, bgcolor: 'action.hover' }}>
        <Typography variant="overline" color="text.secondary">
          You asked
        </Typography>
        <Typography variant="body1">{turn.instruction}</Typography>
      </Paper>
    );
  }

  if (turn.kind === 'proposal') {
    return (
      <ProposalReview
        proposal={turn.proposal}
        interactive={isPending}
        isApplying={isApplying}
        onApply={onApply}
        onDiscard={onDiscard}
      />
    );
  }

  if (turn.kind === 'result') {
    return <ApplyReport result={turn.result} />;
  }

  if (turn.kind === 'discarded') {
    return (
      <Typography variant="body2" color="text.secondary">
        Discarded. No label was written, and the issues are exactly as they
        were.
      </Typography>
    );
  }

  const refusal =
    turn.phase === 'apply'
      ? applyRefusal(turn.failure.status, turn.failure.detail)
      : proposeRefusal(turn.failure.status, turn.failure.detail);

  return (
    // A stale proposal is not an error: it is a picture of a backlog that has
    // had thirty minutes to move, and the answer to it is to ask again.
    <Alert severity={refusal.stale ? 'warning' : 'error'}>
      <AlertTitle>{refusal.title}</AlertTitle>
      <Typography variant="body2">{refusal.remedy}</Typography>
      {refusal.stale && (
        <Button
          size="small"
          variant="outlined"
          sx={{ mt: 1 }}
          onClick={() => onRetryInstruction(turn.instruction)}
          aria-label="Propose this instruction again"
        >
          Propose again
        </Button>
      )}
    </Alert>
  );
}
