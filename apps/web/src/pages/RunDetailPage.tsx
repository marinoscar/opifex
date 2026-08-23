import { useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Card,
  CardContent,
  Container,
  Divider,
  Grid,
  Link,
  Skeleton,
  Stack,
  Typography,
} from '@mui/material';

import { StatusChip } from '../components/dashboard/StatusChip';
import { EventTimeline } from '../components/runs/EventTimeline';
import { formatCost } from '../components/runs/runColumns';
import {
  RUN_EVENTS_PAGE_SIZE,
  useRun,
  useRunEvents,
} from '../hooks/useRunDetail';
import { formatRelativeTime } from '../utils/time';
import type { RunSummary } from '../types/cockpit';

/**
 * `/runs/:id` — a run's whole story on one page (#83, epic #20).
 *
 * VISION §5 states the ambition: *"in two years, 'why does this module work
 * this way?' is a graph traversal rather than an archaeology session."* What
 * the run did, what it cost, and **why it stopped** should be readable here
 * without opening three other tabs.
 *
 * ## The stop reason leads
 *
 * #83 asks that it be "prominent, not buried in the last event". It is the
 * first thing under the heading, in an Alert, before any of the numbers —
 * because it is the field that decides what the operator does next, and a run
 * that needs a human should not require reading a timeline to discover it.
 *
 * ## A doorway, not a replacement
 *
 * The links out to the pull request and the issue are the point: this page
 * summarizes, and the detail lives where it already lives. The run id is
 * rendered in full for the same reason — it is what resolves the trace in the
 * telemetry store.
 */
export default function RunDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const [eventsPage, setEventsPage] = useState(1);

  const run = useRun(id);
  const events = useRunEvents(id, eventsPage);

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 2 }}>
        {run.error && !run.data && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {run.error}
          </Alert>
        )}

        {!run.data && !run.error && <Skeleton height={120} />}

        {run.data && <RunHeader run={run.data} />}

        <Card sx={{ mt: 3 }}>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Timeline
            </Typography>
            <Divider sx={{ mb: 2 }} />

            {events.error && !events.data && (
              <Alert severity="error">{events.error}</Alert>
            )}

            <EventTimeline
              events={events.data?.items ?? []}
              page={eventsPage}
              pageCount={Math.max(
                1,
                Math.ceil((events.data?.total ?? 0) / RUN_EVENTS_PAGE_SIZE),
              )}
              onPageChange={setEventsPage}
              emptyMessage="No events for this run yet. The timeline shows what the runner reported, what git derived, and what the control plane concluded — in that vocabulary, so the three never look alike."
            />
          </CardContent>
        </Card>
      </Box>
    </Container>
  );
}

function RunHeader({ run }: { run: RunSummary }) {
  return (
    <>
      <Stack
        direction="row"
        spacing={2}
        sx={{ alignItems: 'center', flexWrap: 'wrap', mb: 1 }}
      >
        <Typography variant="h4" component="h1">
          Run
        </Typography>
        <StatusChip status={run.status} size="medium" />
      </Stack>

      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ fontVariantNumeric: 'tabular-nums', mb: 2 }}
      >
        {run.workOrder.id} · {run.workOrder.repository} #
        {run.workOrder.issueNumber} · attempt {run.workOrder.attempt}
      </Typography>

      {/* Why it stopped, before the numbers. The field that decides what the
          operator does next does not belong below a cost figure. */}
      {run.attentionReason && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {run.attentionReason}
        </Alert>
      )}

      <Grid container spacing={2}>
        <Fact label="Cost" value={formatCost(run.costUsd)} />
        <Fact
          label="Started"
          value={formatRelativeTime(run.startedAt) ?? '—'}
          title={new Date(run.startedAt).toISOString()}
        />
        <Fact
          label="Last event"
          value={
            run.lastEventAt
              ? (formatRelativeTime(run.lastEventAt) ?? '—')
              : 'never'
          }
          title={run.lastEventAt ?? 'This run has never reported an event'}
        />
        <Fact label="Runner" value={run.runner} />
        {run.resumesAt && (
          <Fact
            label="Resumes"
            value={formatRelativeTime(run.resumesAt) ?? '—'}
            title={run.resumesAt}
          />
        )}
      </Grid>

      <Stack direction="row" spacing={2} sx={{ mt: 2, flexWrap: 'wrap' }}>
        {run.pullRequestUrl && (
          <Link
            href={run.pullRequestUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Pull request
          </Link>
        )}
        {run.workOrder.issueUrl && (
          <Link
            href={run.workOrder.issueUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Issue #{run.workOrder.issueNumber}
          </Link>
        )}
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ fontVariantNumeric: 'tabular-nums' }}
        >
          Run {run.id}
        </Typography>
      </Stack>
    </>
  );
}

function Fact({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <Grid size={{ xs: 6, sm: 4, md: 3 }}>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block' }}
      >
        {label}
      </Typography>
      <Typography
        variant="body1"
        sx={{ fontVariantNumeric: 'tabular-nums' }}
        title={title}
      >
        {value}
      </Typography>
    </Grid>
  );
}
