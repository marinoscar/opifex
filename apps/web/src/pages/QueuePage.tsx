import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
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

import {
  BulkSteerToolbar,
  type BulkSteerRun,
} from '../components/queue/BulkSteerToolbar';
import { unappliedIds, type SteerIntent } from '../config/queueSteering';
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
 * ## Several at once, from where the decision is made (#421)
 *
 * Steering one row at a time made "only work on these three" mean editing a
 * label on seventeen issues by hand, so the rows carry a selection and the
 * toolbar applies either intent to it. This adds **no new state and no new
 * control surface**: it is N sequential calls to the same two endpoints, and
 * the intent still lands as a GitHub label that the next tick acts on.
 *
 * Three properties of that selection are load-bearing:
 *
 *  - **It is bounded to what is on this screen.** `selectableIds` is built
 *    from the rendered rows and the selection is pruned to it on every fresh
 *    answer, so select-all can only ever cover the page. One click must not be
 *    able to label an unseen five hundred.
 *  - **A partial run is reported per work order**, and what did not land stays
 *    selected — including the writes GitHub never received because
 *    `github.writesEnabled` is off, which are not successes.
 *  - **A pending row cannot be re-selected.** Its label is already written and
 *    it is waiting for a tick; sending it again would spend a GitHub write to
 *    change nothing.
 *
 * ## Quarantine is absent on purpose
 *
 * There is no clear-quarantine control, and there is no endpoint for one. #49
 * requires a human apply `factory:clear-quarantine` on GitHub where their
 * identity is native; a button here would launder the actor. A bulk release
 * does not clear one either, and the toolbar says so.
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

  /** The ticked work orders. Never acted on without the bound below. */
  const [selected, setSelected] = useState<string[]>([]);
  /** What the last bulk run did. Survives the refresh that follows it. */
  const [run, setRun] = useState<BulkSteerRun | null>(null);

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

  // The rows that can be steered right now: on screen, and not already waiting
  // for a tick. This set is the ONLY thing select-all and the bulk buttons can
  // reach — the queue beyond `QUEUE_PAGE_LIMIT` is not on this screen and so
  // is not selectable, deliberately.
  const selectableIds = useMemo(() => {
    if (!canSteer) return new Set<string>();
    return new Set(
      entries
        .filter((entry) => steering.pending[entry.workOrder.id] === undefined)
        .map((entry) => entry.workOrder.id),
    );
  }, [canSteer, entries, steering.pending]);

  // Re-seed on a fresh answer, during render rather than in an effect — the
  // way `AddRepositoryDialog` does it — so no control paints a stale value for
  // a frame. Pruned rather than cleared: a work order that has left the queue
  // drops out, and everything still on screen keeps its tick, which is what
  // lets the failures of a partial run survive the refresh that follows it.
  const [seededFrom, setSeededFrom] = useState(data);
  if (data !== seededFrom) {
    setSeededFrom(data);
    setSelected((current) => current.filter((id) => selectableIds.has(id)));
  }

  // Derived as well as pruned. The prune runs on a new answer; this bound
  // holds on every render, so nothing outside the visible, steerable rows can
  // be sent even for the frame between the two.
  const chosen = selected.filter((id) => selectableIds.has(id));
  const allSelected =
    selectableIds.size > 0 && chosen.length === selectableIds.size;

  /** Select-all, over the rows on THIS page, and no others. */
  const toggleAll = () => {
    setSelected(allSelected ? [] : [...selectableIds]);
  };

  const toggleOne = (workOrderId: string) => {
    setSelected((current) =>
      current.includes(workOrderId)
        ? current.filter((id) => id !== workOrderId)
        : [...current, workOrderId],
    );
  };

  const steerChosen = async (intent: SteerIntent) => {
    if (chosen.length === 0) return;
    // Dropped before the run starts rather than left underneath it: a report
    // from the previous attempt sitting above a running one would be read as
    // this one's answer.
    setRun(null);

    // Never rejects — a refusal is one entry in the answer. See `steerMany`.
    const outcomes = await steering.steerMany(chosen, intent);
    setRun({ intent, outcomes });

    // What was written leaves the selection; what was refused, and what was
    // suppressed because writes are off, both stay in it. A retry then
    // re-sends only the labels that have not landed, and the operator does not
    // have to find those rows again.
    setSelected(unappliedIds(outcomes));
  };

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

        {canSteer && entries.length > 0 && (
          <BulkSteerToolbar
            selectedCount={chosen.length}
            selectableCount={selectableIds.size}
            progress={steering.progress}
            run={run}
            onSteer={(intent) => void steerChosen(intent)}
          />
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
                {canSteer && (
                  <TableCell padding="checkbox">
                    <Tooltip title="Selects the work orders on this page only. The queue can be longer than what is shown.">
                      <Checkbox
                        size="small"
                        checked={allSelected}
                        indeterminate={chosen.length > 0 && !allSelected}
                        disabled={selectableIds.size === 0}
                        onChange={toggleAll}
                        slotProps={{
                          input: {
                            'aria-label': 'Select the work orders on this page',
                          },
                        }}
                      />
                    </Tooltip>
                  </TableCell>
                )}
                <TableCell align="right">#</TableCell>
                <TableCell>Work order</TableCell>
                <TableCell>State</TableCell>
                {/* Not "Waiting on" (#170). The cells under it hold complete
                    sentences from the dispatch policy, so a header that reads
                    as the first half of one — "Waiting on" / "Waiting for a
                    free slot on claude-code-local…" — collides with them.
                    This header asks a question the sentence answers instead of
                    starting a sentence the API finishes. Held rows are covered
                    too: held is waiting on a human. */}
                <TableCell>Why it is waiting</TableCell>
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
                  selected={chosen.includes(entry.workOrder.id)}
                  selectable={selectableIds.has(entry.workOrder.id)}
                  onToggle={toggleOne}
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
          <code>factory:ready</code> to the issue on GitHub, one request per
          work order whether one row is steered or twenty. They take effect on
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
  selected,
  selectable,
  onToggle,
  pending,
  onSteer,
}: {
  entry: QueueEntry;
  canSteer: boolean;
  selected: boolean;
  selectable: boolean;
  onToggle: (workOrderId: string) => void;
  pending?: 'hold' | 'release';
  onSteer: (workOrderId: string, intent: 'hold' | 'release') => Promise<void>;
}) {
  const numeric = { fontVariantNumeric: 'tabular-nums' } as const;

  return (
    <TableRow selected={selected}>
      {canSteer && (
        <TableCell padding="checkbox">
          <Checkbox
            size="small"
            checked={selected}
            // A row whose label is already written is waiting for a tick, not
            // for another label. Re-sending it would spend a GitHub write to
            // change nothing.
            disabled={!selectable}
            onChange={() => onToggle(entry.workOrder.id)}
            slotProps={{
              input: { 'aria-label': `Select ${entry.workOrder.id}` },
            }}
          />
        </TableCell>
      )}
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
        {/* Verbatim, never reworded. #64 wants an operator comparing this
            screen against the dispatch log to read the same sentence twice,
            not two paraphrases of one decision. */}
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
