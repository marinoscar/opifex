import { useCallback, useState } from 'react';
import {
  Alert,
  Box,
  Card,
  CardContent,
  Chip,
  Container,
  Divider,
  LinearProgress,
  MenuItem,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';

import {
  ceilingUsedPercent,
  floorCaveat,
  money,
  preciseMoney,
} from '../components/cost/costFormat';
import { COCKPIT_POLL_INTERVAL_MS } from '../config/cockpitApi';
import { usePolledResource } from '../hooks/usePolledResource';
import { getCostSummary } from '../services/api';
import type { CostSummary } from '../types/cockpit';

const NUMERIC = { fontVariantNumeric: 'tabular-nums' } as const;
const WINDOWS = [7, 30, 90];

/**
 * `/cost` — what the factory has spent, and against what ceiling (#213).
 *
 * ## Reported and estimated are never one number
 *
 * A runner that cannot report cost is budgeted by proxy from its authorized
 * ceiling. #86: presenting that estimate as a measurement "would make metric 5
 * untrustworthy exactly where it matters." So the two are rendered as separate
 * figures with different weight, and the API never sums them either.
 *
 * ## A total that is really a floor says so
 *
 * When runs reported nothing, the total below them is a floor. When some of
 * those runs had no ceiling either, it is a floor with no bound at all — and
 * the caveat names which case applies rather than drawing a confident bar.
 *
 * ## Quota is absent, and says why
 *
 * The API carries `quota: null` deliberately so this screen can state that it
 * is unavailable rather than look like quota was forgotten. VISION §11's shared
 * quota is the agent subscription, and nothing records consumption against a
 * window capacity — see #86, which stays open for it.
 *
 * ## No charting library
 *
 * #86 names adding `@mui/x-charts` as an ADR-worthy decision. A daily series of
 * at most 90 rows reads fine as a table, so the trigger has not fired.
 */
export default function CostPage() {
  const [days, setDays] = useState(30);

  const fetcher = useCallback(
    (signal: AbortSignal) => getCostSummary(days, signal),
    [days],
  );
  const { data, error } = usePolledResource<CostSummary>({
    fetcher,
    intervalMs: COCKPIT_POLL_INTERVAL_MS,
    enabled: true,
  });

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 2 }}>
        <Stack
          direction="row"
          spacing={2}
          sx={{ alignItems: 'center', mb: 1, flexWrap: 'wrap' }}
        >
          <Typography variant="h4" component="h1">
            Cost
          </Typography>
          <TextField
            select
            size="small"
            label="Window"
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
            sx={{ minWidth: 140 }}
          >
            {WINDOWS.map((option) => (
              <MenuItem key={option} value={option}>
                Last {option} days
              </MenuItem>
            ))}
          </TextField>
        </Stack>

        {error && !data && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        {!data && !error && <Skeleton height={200} />}
        {data && <CostBody summary={data} />}
      </Box>
    </Container>
  );
}

function CostBody({ summary }: { summary: CostSummary }) {
  const caveat = floorCaveat({
    runsWithoutCost: summary.runsWithoutCost,
    unboundedRuns: summary.ceiling.spend.unboundedRuns,
  });
  const used = ceilingUsedPercent(
    summary.ceiling.limitUsd,
    summary.ceiling.spend.totalUsd,
  );

  return (
    <>
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="overline" color="text.secondary">
            Reported spend
          </Typography>
          <Typography variant="h3" sx={NUMERIC}>
            {money(summary.totalUsd)}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {summary.runs} run(s) in this window, {summary.runsWithoutCost} of
            which reported no cost.
          </Typography>
          {caveat && (
            <Alert severity="info" sx={{ mt: 2 }}>
              {caveat}
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Against the ceiling
          </Typography>

          {summary.ceiling.malformed && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              The configured ceiling is unreadable:{' '}
              <code>{summary.ceiling.malformed}</code>. Somebody believed they
              had set one.
            </Alert>
          )}

          {summary.ceiling.limitUsd === null ? (
            <Alert severity="warning">
              No spend ceiling is configured. That REFUSES dispatch rather than
              permitting it — the queue will look like a capacity problem.
            </Alert>
          ) : (
            <>
              <Stack direction="row" spacing={4} sx={{ flexWrap: 'wrap' }}>
                <Figure
                  label="Ceiling"
                  value={money(summary.ceiling.limitUsd)}
                  hint={`over ${summary.ceiling.windowDays} days`}
                />
                {/* The two kinds of claim, never added together on screen. */}
                <Figure
                  label="Reported"
                  value={preciseMoney(summary.ceiling.spend.reportedUsd)}
                  hint="measured"
                />
                <Figure
                  label="Estimated"
                  value={preciseMoney(summary.ceiling.spend.estimatedUsd)}
                  hint="from authorized ceilings, not measured"
                />
                <Figure
                  label="Headroom"
                  value={money(summary.ceiling.headroomUsd)}
                />
              </Stack>

              {used !== null && (
                <Box sx={{ mt: 2 }}>
                  <LinearProgress
                    variant="determinate"
                    value={used}
                    color={used > 80 ? 'warning' : 'primary'}
                  />
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ ...NUMERIC, display: 'block', mt: 0.5 }}
                  >
                    {used.toFixed(1)}% of the ceiling
                    {summary.ceiling.spend.unboundedRuns > 0
                      ? ' — at least, since some runs are unbounded'
                      : ''}
                  </Typography>
                </Box>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Quota
          </Typography>
          <Alert severity="info">
            Not measured. VISION §11&apos;s shared quota is the agent
            subscription, and nothing records consumption against a window
            capacity — only a reset time when a run is already blocked. This
            section says so rather than showing a number derived from the GitHub
            rate limit, which measures something else.
          </Alert>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            By repository
          </Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Repository</TableCell>
                <TableCell align="right">Reported</TableCell>
                <TableCell align="right">Runs</TableCell>
                <TableCell align="right">No cost reported</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {summary.byRepository.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4}>
                    <Typography variant="body2" color="text.secondary">
                      No runs in this window.
                    </Typography>
                  </TableCell>
                </TableRow>
              ) : (
                summary.byRepository.map((row) => (
                  <TableRow key={row.repository}>
                    <TableCell>{row.repository}</TableCell>
                    <TableCell align="right" sx={NUMERIC}>
                      {money(row.totalUsd)}
                    </TableCell>
                    <TableCell align="right" sx={NUMERIC}>
                      {row.runs}
                    </TableCell>
                    <TableCell align="right" sx={NUMERIC}>
                      {row.runsWithoutCost > 0 ? (
                        <Chip size="small" label={row.runsWithoutCost} />
                      ) : (
                        '—'
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>

          {summary.byDay.length > 0 && (
            <>
              <Divider sx={{ my: 2 }} />
              <Typography variant="h6" gutterBottom>
                By day
              </Typography>
              <Table size="small">
                <TableBody>
                  {summary.byDay.map((day) => (
                    <TableRow key={day.date}>
                      <TableCell sx={NUMERIC}>{day.date}</TableCell>
                      <TableCell align="right" sx={NUMERIC}>
                        {money(day.totalUsd)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function Figure({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Box>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block' }}
      >
        {label}
      </Typography>
      <Typography variant="h6" sx={NUMERIC}>
        {value}
      </Typography>
      {hint && (
        <Typography variant="caption" color="text.disabled">
          {hint}
        </Typography>
      )}
    </Box>
  );
}
