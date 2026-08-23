import { useEffect, useMemo } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Container,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';

import { useQueueSteering } from '../hooks/useQueueSteering';
import { useRunQueue } from '../hooks/useRunQueue';
import { usePermissions } from '../hooks/usePermissions';
import { formatRelativeTime } from '../utils/time';
import type { QueueEntry, QueueEntryState } from '../types/cockpit';

/** The whole queue, not the dashboard panel's first five. */
const QUEUE_PAGE_LIMIT = 100;

/** The permission `QueueController` really enforces on hold and release. */
const STEER_PERMISSION = 'workorders:write';

const STATE_COLORS: Record<
  QueueEntryState,
  'default' | 'warning' | 'info' | 'success'
> = {
  waiting: 'default',
  ready: 'success',
  dispatching: 'info',
  held: 'warning',
};

/**
 * `/queue` — what is waiting, in the order the next tick will drain it (#85).
 *
 * VISION §3.3 puts queue position and execution state firmly in Postgres, so
 * this view has no GitHub equivalent — it is one of the clearest reasons the
 * cockpit exists at all.
 *
 * ## The controls write labels, and the delay is shown rather than hidden
 *
 * Hold writes `factory:hold`, release writes `factory:ready`. This is a UI over
 * the input labels, **not a second state machine**: writing Opifex's own queue
 * state instead would create exactly the split-brain the label design prevents,
 * and the next tick would undo it.
 *
 * The consequence is a real delay, and it is rendered as one. A steered row
 * shows "hold requested — next tick" and keeps showing it until the polled
 * queue itself changes. Nothing is optimistically re-coloured and then flicked
 * back, and because no queue state is modelled locally, the view reconciles
 * correctly when somebody edits the label in GitHub instead.
 *
 * ## Quarantine is absent on purpose
 *
 * There is no clear-quarantine control, and there is no endpoint for one. #49
 * requires a human apply `factory:clear-quarantine` on GitHub where their
 * identity is native; a button here would launder the actor.
 */
export default function QueuePage() {
  const { data, state, error, refresh } = useRunQueue(QUEUE_PAGE_LIMIT);
  const { hasPermission } = usePermissions();
  const steering = useQueueSteering(refresh);

  const canSteer = hasPermission(STEER_PERMISSION);
  // Memoised so the settle effect below does not re-run on every render: a
  // fresh `[]` each time would make its dependency change even when nothing
  // did, which is what the exhaustive-deps rule is warning about.
  const entries = useMemo(() => data ?? [], [data]);

  // A work order whose state has changed since the label was written has had
  // its tick: drop it out of pending so the row stops claiming to be waiting
  // for one. The SERVER is what settles it, never this component.
  useEffect(() => {
    for (const entry of entries) {
      const intent = steering.pending[entry.workOrder.id];
      if (!intent) continue;
      const landed = intent === 'hold' ? 'held' : 'ready';
      if (entry.state === landed) steering.settle(entry.workOrder.id);
    }
  }, [entries, steering]);

  return (
    <Container maxWidth="xl">
      <Box sx={{ py: 2 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Queue
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Work orders waiting to dispatch, in the order the next tick drains
          them.
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        {steering.error && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {steering.error}
          </Alert>
        )}

        {!canSteer && (
          <Alert severity="info" sx={{ mb: 2 }}>
            You can see the queue but not steer it. Hold and release need{' '}
            <code>{STEER_PERMISSION}</code>, which is the permission the API
            enforces.
          </Alert>
        )}

        {entries.length === 0 && state !== 'loading' ? (
          <Typography variant="body2" color="text.secondary">
            Nothing is queued. A work order appears here once an issue carries{' '}
            <code>factory:ready</code> and the reconciler has projected it.
          </Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell align="right">#</TableCell>
                <TableCell>Work order</TableCell>
                <TableCell>State</TableCell>
                <TableCell>Waiting on</TableCell>
                <TableCell>Queued</TableCell>
                <TableCell align="right">Steer</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {entries.map((entry) => (
                <QueueRow
                  key={entry.id}
                  entry={entry}
                  canSteer={canSteer}
                  pending={steering.pending[entry.workOrder.id]}
                  onSteer={steering.steer}
                />
              ))}
            </TableBody>
          </Table>
        )}

        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mt: 3 }}
        >
          Hold and release write <code>factory:hold</code> and{' '}
          <code>factory:ready</code> to the issue on GitHub. They take effect on
          the next reconciler tick — this screen is another place to steer from,
          not a second source of truth. Clearing a quarantine is deliberately
          not possible here: it must be applied by a human on GitHub, where the
          actor is verifiable.
        </Typography>
      </Box>
    </Container>
  );
}

function QueueRow({
  entry,
  canSteer,
  pending,
  onSteer,
}: {
  entry: QueueEntry;
  canSteer: boolean;
  pending?: 'hold' | 'release';
  onSteer: (workOrderId: string, intent: 'hold' | 'release') => Promise<void>;
}) {
  const numeric = { fontVariantNumeric: 'tabular-nums' } as const;

  return (
    <TableRow>
      <TableCell align="right" sx={numeric}>
        {entry.position}
      </TableCell>
      <TableCell>
        <Stack spacing={0} sx={{ minWidth: 0 }}>
          <Typography variant="body2" sx={numeric}>
            {entry.workOrder.id}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {entry.workOrder.repository} #{entry.workOrder.issueNumber} ·{' '}
            {entry.workOrder.title}
          </Typography>
        </Stack>
      </TableCell>
      <TableCell>
        <Chip
          size="small"
          label={entry.state}
          color={STATE_COLORS[entry.state]}
        />
      </TableCell>
      <TableCell>
        <Typography variant="body2" color="text.secondary">
          {entry.waitingOn ?? '—'}
        </Typography>
      </TableCell>
      <TableCell sx={numeric}>
        {formatRelativeTime(entry.enqueuedAt) ?? '—'}
      </TableCell>
      <TableCell align="right">
        {pending ? (
          // The honest state. Not "held" — a hold has been REQUESTED, and the
          // reconciler has not run yet.
          <Tooltip title="The label is written. The reconciler acts on it next tick.">
            <Chip
              size="small"
              variant="outlined"
              label={`${pending} requested — next tick`}
            />
          </Tooltip>
        ) : (
          canSteer && (
            <Stack
              direction="row"
              spacing={1}
              sx={{ justifyContent: 'flex-end' }}
            >
              <Button
                size="small"
                onClick={() => onSteer(entry.workOrder.id, 'hold')}
                disabled={entry.state === 'held'}
              >
                Hold
              </Button>
              <Button
                size="small"
                onClick={() => onSteer(entry.workOrder.id, 'release')}
                disabled={entry.state === 'ready'}
              >
                Release
              </Button>
              <Button
                size="small"
                component={RouterLink}
                to={`/runs?workOrder=${encodeURIComponent(entry.workOrder.id)}`}
              >
                Runs
              </Button>
            </Stack>
          )
        )}
      </TableCell>
    </TableRow>
  );
}
