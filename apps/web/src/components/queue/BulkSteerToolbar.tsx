/**
 * The bulk steer controls, and the report of what the last run did (#421).
 *
 * Split out of `QueuePage` because it is where all of this feature's wording
 * is, and wording that has its own component can be asserted without rendering
 * the whole queue around it.
 *
 * ## Three things this must never do
 *
 * 1. **Present a partial application as complete.** Every headline
 *    `bulkPresentation` produces for a mixed run is a fraction out of the
 *    total attempted, and the per-work-order list underneath is always there.
 * 2. **Show a suppressed write as a success.** With `github.writesEnabled`
 *    off the endpoints answer 200 and write nothing; that is its own outcome
 *    with its own sentence, and those rows stay selected.
 * 3. **Imply a release restores a queue position, or clears a quarantine.**
 *    Neither is true, and both are said next to the button rather than only
 *    after the fact.
 */

import {
  Alert,
  AlertTitle,
  Box,
  Button,
  LinearProgress,
  Paper,
  Stack,
  Typography,
} from '@mui/material';

import {
  HOLD_CAVEAT,
  RELEASE_CAVEATS,
  bulkPresentation,
  outcomeLine,
  refusalRemedies,
  type SteerIntent,
  type SteerOutcome,
} from '../../config/queueSteering';
import type { SteerProgress } from '../../hooks/useQueueSteering';

export interface BulkSteerRun {
  intent: SteerIntent;
  outcomes: SteerOutcome[];
}

export function BulkSteerToolbar({
  selectedCount,
  selectableCount,
  progress,
  run,
  onSteer,
}: {
  selectedCount: number;
  /** How many rows are on the screen and steerable — the bound on select-all. */
  selectableCount: number;
  progress: SteerProgress | null;
  /** What the last run did, or null before there has been one. */
  run: BulkSteerRun | null;
  onSteer: (intent: SteerIntent) => void;
}) {
  const running = progress !== null;
  const disabled = running || selectedCount === 0;

  // Built as one string rather than interpolated into the JSX so it renders as
  // a single text node: the count is the sentence an operator checks before
  // pressing a button that writes to GitHub, and it should be readable — and
  // assertable — as one sentence.
  const summary =
    selectedCount === 0
      ? 'Nothing selected. Tick the work orders to steer — select-all covers ' +
        `the ${selectableCount} on this page and no others.`
      : `${selectedCount} of the ${selectableCount} on this page selected.`;

  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        sx={{ alignItems: { sm: 'center' } }}
      >
        <Typography variant="body2" sx={{ flexGrow: 1 }}>
          {summary}
        </Typography>
        <Stack direction="row" spacing={1}>
          <Button
            variant="outlined"
            size="small"
            disabled={disabled}
            aria-label="Mark the selected work orders ready"
            onClick={() => onSteer('release')}
          >
            Mark ready
          </Button>
          <Button
            variant="outlined"
            size="small"
            disabled={disabled}
            aria-label="Hold the selected work orders"
            onClick={() => onSteer('hold')}
          >
            Hold
          </Button>
        </Stack>
      </Stack>

      {/* The requests are sequential and a selection of thirty is a real wait.
          An unmoving spinner and a progressing count are the same duration and
          not the same experience — and the count is the only honest way to say
          which work order the wait is currently on. */}
      {progress !== null && (
        <Box sx={{ mt: 2 }}>
          <Typography variant="caption" color="text.secondary">
            Writing labels one at a time: {progress.done} of {progress.total}{' '}
            answered, now on {progress.current}.
          </Typography>
          <LinearProgress
            variant="determinate"
            value={(progress.done / progress.total) * 100}
            sx={{ mt: 0.5 }}
          />
        </Box>
      )}

      <Stack spacing={0.5} sx={{ mt: 2 }}>
        {RELEASE_CAVEATS.map((caveat) => (
          <Typography key={caveat} variant="caption" color="text.secondary">
            {caveat}
          </Typography>
        ))}
        <Typography variant="caption" color="text.secondary">
          {HOLD_CAVEAT}
        </Typography>
      </Stack>

      {run !== null && <BulkSteerReport run={run} />}
    </Paper>
  );
}

/**
 * What the last run did, per work order.
 *
 * The list is unconditional. A headline can only ever be a summary, and the
 * one case where a summary is most tempting — "11 of 15 written" — is exactly
 * the case where the operator needs to know WHICH four.
 */
function BulkSteerReport({ run }: { run: BulkSteerRun }) {
  const presentation = bulkPresentation(run.outcomes, run.intent);
  if (presentation === null) return null;

  const remedies = refusalRemedies(run.outcomes);

  return (
    <Alert severity={presentation.severity} sx={{ mt: 2 }}>
      <AlertTitle>{presentation.title}</AlertTitle>
      <Typography variant="body2">{presentation.body}</Typography>

      <Stack spacing={1} sx={{ mt: 1.5 }}>
        {run.outcomes.map((outcome) => (
          <Box key={outcome.workOrderId}>
            <Typography
              variant="body2"
              sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}
            >
              {outcome.identity}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {outcomeLine(outcome, run.intent)}
            </Typography>
          </Box>
        ))}
      </Stack>

      {remedies.map((remedy) => (
        <Typography
          key={remedy}
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mt: 1.5 }}
        >
          {remedy}
        </Typography>
      ))}
    </Alert>
  );
}
