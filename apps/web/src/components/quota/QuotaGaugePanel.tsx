/**
 * The live gauge: where the fleet's quota stands right now (#231).
 *
 * This is the "what is happening now" half of `/quota`; the history beneath it
 * is the "what has been happening" half (#476), and they sit on one screen
 * because they are two halves of one question.
 *
 * ## Three things this panel refuses to say
 *
 *  1. **A burn percentage.** `burnFraction` is always null on the wire, and
 *     that is a decision rather than an omission: no vendor publishes a window
 *     capacity, and the consumption Opifex can see is incomplete anyway
 *     because VISION §11's subscription is shared with the operator's own
 *     interactive use. A progress bar here would be a denominator nobody has.
 *  2. **That an unread runner is healthy.** `position: null` is UNKNOWN, not
 *     fine — it is what you get when every live window reads `unknown`, or
 *     when the only non-exhausted readings are older than the meter's health
 *     horizon. A stale `allowed` is no news about a shared subscription.
 *  3. **One window per runner.** A runner routinely holds a `five_hour` and a
 *     `weekly` at once, and reporting only the newest hid an exhausted short
 *     window behind a healthy long one (#301). Every live window is drawn,
 *     soonest reset first, with `position` naming the one that binds.
 *
 * `basis` sentences — the position's and each window's — are rendered
 * VERBATIM. They are the API's own account of what its numbers are and are
 * not, and paraphrasing them here would be a second implementation of a claim
 * the API already owns.
 */

import {
  Alert,
  Box,
  Card,
  CardContent,
  Divider,
  Stack,
  Typography,
} from '@mui/material';
import { QuotaPressureChip } from './QuotaPressureChip';
import { describeConsumption, formatInstant } from './quotaFormat';
import { formatRelativeTime } from '../../utils/time';
import type {
  QuotaRunnerReading,
  QuotaSummary,
  QuotaWindowReading,
} from '../../types/quota';

const NUMERIC = { fontVariantNumeric: 'tabular-nums' } as const;

export interface QuotaGaugePanelProps {
  summary: QuotaSummary;
}

export function QuotaGaugePanel({ summary }: QuotaGaugePanelProps) {
  if (summary.runners.length === 0) {
    return (
      <Alert severity="info" data-testid="quota-gauge-empty">
        No runner has reported a rate-limit signal, so no window is being
        tracked. That is an absence of news rather than good news: a runner that
        declares no rate-limit signal has an unknown quota position, and it is
        left out of this list rather than shown with zeroes.
      </Alert>
    );
  }

  return (
    <Stack spacing={2} data-testid="quota-gauge">
      {summary.runners.map((runner) => (
        <RunnerCard key={runner.runnerKey} runner={runner} />
      ))}
      <Typography variant="caption" color="text.secondary">
        No burn percentage is shown anywhere on this screen. VISION §10’s sixth
        metric is consumption over window capacity; no vendor publishes a
        capacity, and the consumption above is Opifex’s own — the same
        subscription carries the operator’s interactive use, which burns the
        window and leaves no record here.
      </Typography>
    </Stack>
  );
}

function RunnerCard({ runner }: { runner: QuotaRunnerReading }) {
  const position = runner.position;

  return (
    <Card variant="outlined" data-testid={`quota-runner-${runner.runnerKey}`}>
      <CardContent>
        <Stack
          direction="row"
          spacing={2}
          sx={{ alignItems: 'baseline', flexWrap: 'wrap', rowGap: 1 }}
        >
          <Typography variant="h6" component="h3">
            {runner.runnerKey}
          </Typography>
          {position === null ? (
            // Deliberately the same treatment `unknown` gets everywhere on this
            // screen: no status hue, and words that say what is unknown.
            <Typography variant="body2" color="text.secondary">
              Position unknown — not known to be able to work
            </Typography>
          ) : position.exhausted ? (
            <Typography variant="body2" color="error.main">
              Cannot work
              {position.resumesAt
                ? ` until ${formatInstant(position.resumesAt)}`
                : ' — and nothing could date the block'}
            </Typography>
          ) : (
            <Typography variant="body2" color="success.main">
              Able to work
            </Typography>
          )}
        </Stack>

        {position && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', mt: 0.5 }}
          >
            {/* The API's own words for how it reached that verdict — the same
                function dispatch routes on, so this screen and the fleet
                answer "can this runner work now" identically. */}
            {position.basis}
          </Typography>
        )}

        <Divider sx={{ my: 2 }} />

        {runner.windows.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No window of this runner’s is still live.
          </Typography>
        ) : (
          <Stack spacing={2} divider={<Divider flexItem />}>
            {runner.windows.map((window) => (
              <WindowRow
                key={`${window.windowKind}::${window.resetsAt}`}
                window={window}
              />
            ))}
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}

function WindowRow({ window }: { window: QuotaWindowReading }) {
  return (
    <Box>
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}
      >
        <Typography variant="subtitle2" sx={{ minWidth: 90 }}>
          {window.windowKind}
        </Typography>
        <QuotaPressureChip pressure={window.pressure} />
        {/* The worst reading ever seen in this window, kept beside the latest
            one: `pressure` forgets the wall the moment the vendor says
            `allowed` again, and only `peakPressure` still says it was hit. */}
        <QuotaPressureChip pressure={window.peakPressure} prefix="Peak" />
        <Box sx={{ flexGrow: 1 }} />
        <Typography variant="body2" sx={NUMERIC}>
          Resets {formatInstant(window.resetsAt)}
          {formatRelativeTime(window.resetsAt)
            ? ` (${formatRelativeTime(window.resetsAt)})`
            : ''}
        </Typography>
      </Stack>

      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ mt: 0.5, ...NUMERIC }}
      >
        Opifex through this window:{' '}
        {describeConsumption(window.opifexConsumption)}
        {window.partialWindow ? ' · a floor, not the whole window' : ''}
      </Typography>

      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block', mt: 0.5 }}
      >
        {/* Rendered verbatim: this is the API's paragraph naming what the
            figures above are and are not, and a summary of it here would be a
            second, quietly diverging version of the same caveat. */}
        {window.basis}
      </Typography>
    </Box>
  );
}

export default QuotaGaugePanel;
