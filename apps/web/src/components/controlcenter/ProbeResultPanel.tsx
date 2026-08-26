/**
 * One Test button and the observation it produced (#349, epic #332).
 *
 * ## Three outcomes that must not look alike
 *
 *  - **`ok: true`** — the probe ran and the thing works.
 *  - **`ok: false`** — the probe ran and the thing does NOT work. A finding,
 *    drawn as one: the endpoint answers 2xx for a rejected credential because
 *    "the probe failed" and "the probe found a failure" are the two things it
 *    exists to tell apart.
 *  - **`skipped: true`, or an unreachable endpoint** — nothing was tested.
 *    Drawn as neither a pass nor a failure, because a rate-limited probe and a
 *    403 on the probe route say nothing whatever about the credential.
 *
 * ## Stale is louder than the result underneath it
 *
 * When the configuration a result described has moved, the panel leads with
 * that and reports the old answer as history. It is not deleted — a token
 * that worked ten minutes ago is evidence, and replacing evidence with a blank
 * is not an improvement — but it is never again presented as the current
 * state of the deployment. That distinction is the point of the feature.
 *
 * ## Money is stated before the click, not after
 *
 * The two probes that make a real billed call say so next to their button, and
 * that same block becomes the allowance the API reported as soon as there is a
 * result to read one off — in ONE place rather than twice, so the number an
 * operator acts on has a single home. Before the first result the screen says
 * it does not know how much is left, because it does not: the limit is server
 * policy and nothing publishes it in advance.
 */

import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  Stack,
  Typography,
} from '@mui/material';
import ScienceIcon from '@mui/icons-material/Science';
import PaidIcon from '@mui/icons-material/Paid';

import {
  rateLimitSentence,
  type ProbeDescriptor,
  type ProbeFreshness,
  type ProbeObservation,
} from '../../config/credentialProbes';

export interface ProbeResultPanelProps {
  descriptor: ProbeDescriptor;
  /** What it last answered. Absent means it has never been run. */
  observation: ProbeObservation | undefined;
  /** Whether that answer still describes the configuration on screen. */
  freshness: ProbeFreshness | null;
  isRunning: boolean;
  /** Running a probe needs `system_settings:write`, which the API enforces. */
  canRun: boolean;
  onRun: () => void;
}

export function ProbeResultPanel({
  descriptor,
  observation,
  freshness,
  isRunning,
  canRun,
  onRun,
}: ProbeResultPanelProps) {
  const stale = freshness?.state === 'stale';

  return (
    <Box sx={{ mt: 2 }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        sx={{ alignItems: { sm: 'center' } }}
      >
        <Button
          size="small"
          variant="outlined"
          color={descriptor.spends ? 'warning' : 'primary'}
          startIcon={descriptor.spends ? <PaidIcon /> : <ScienceIcon />}
          onClick={onRun}
          disabled={!canRun || isRunning}
        >
          {isRunning ? 'Testing…' : descriptor.label}
        </Button>
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
          {descriptor.question}
        </Typography>
      </Stack>

      {descriptor.spends && (
        <Alert severity="warning" variant="outlined" sx={{ mt: 1 }}>
          <Typography variant="body2">{descriptor.costNote}</Typography>
          <Typography variant="caption" component="p">
            {observation?.outcome.state === 'answered' &&
            observation.outcome.result.rateLimit
              ? rateLimitSentence(observation.outcome.result.rateLimit)
              : 'The API rate-limits this probe. It reports the exact ' +
                'allowance left with every result; until one runs, this ' +
                'screen does not know how much of it is spent.'}
          </Typography>
        </Alert>
      )}

      {!canRun && (
        <Typography
          variant="caption"
          component="p"
          color="text.secondary"
          sx={{ mt: 1 }}
        >
          Running a probe needs <code>system_settings:write</code>, which this
          account does not hold.
        </Typography>
      )}

      {observation && (
        <Alert
          severity={stale ? 'warning' : severityOf(observation)}
          variant="outlined"
          sx={{ mt: 1 }}
        >
          <AlertTitle>
            {stale ? 'Stale observation' : headlineOf(observation)}
            {stale && (
              <Chip size="small" color="warning" label="stale" sx={{ ml: 1 }} />
            )}
          </AlertTitle>

          {stale && freshness?.state === 'stale' && (
            <Typography variant="body2" sx={{ mb: 1 }}>
              {freshness.reason}
            </Typography>
          )}
          {stale && (
            <Typography variant="body2">
              When it ran, the answer was: {headlineOf(observation)}.
            </Typography>
          )}

          <Typography variant="body2">{detailOf(observation)}</Typography>

          {observation.outcome.state === 'answered' && (
            <Typography
              variant="caption"
              component="p"
              color="text.secondary"
              sx={{ mt: 0.5 }}
            >
              Checked at{' '}
              {new Date(observation.outcome.result.checkedAt).toLocaleString()}
            </Typography>
          )}
        </Alert>
      )}
    </Box>
  );
}

/** Green only for a probe that ran and said yes. */
function severityOf(observation: ProbeObservation) {
  if (observation.outcome.state === 'unreachable') return 'info' as const;
  const { ok, skipped } = observation.outcome.result;
  if (skipped) return 'info' as const;
  return ok ? ('success' as const) : ('error' as const);
}

function headlineOf(observation: ProbeObservation): string {
  if (observation.outcome.state === 'unreachable') return 'Not tested';
  const { ok, skipped } = observation.outcome.result;
  if (skipped) return 'Did not run';
  return ok ? 'It works' : 'It does not work';
}

function detailOf(observation: ProbeObservation): string {
  return observation.outcome.state === 'unreachable'
    ? observation.outcome.detail
    : observation.outcome.result.detail;
}

export default ProbeResultPanel;
