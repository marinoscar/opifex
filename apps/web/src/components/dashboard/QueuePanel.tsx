/**
 * What is waiting to dispatch.
 *
 * Epic #19. Queue depth is the LEADING indicator of the pressure VISION §11
 * describes — automated runs and interactive use drawing on one quota — where
 * the attention panel above it shows the lagging one. Work orders stacking up
 * behind capacity is visible here minutes before anything goes silent.
 *
 * Its empty state is deliberately NEUTRAL rather than congratulatory. An empty
 * attention panel is good news; an empty queue is just an idle factory, and a
 * green check mark next to "nothing scheduled" would be the UI cheering for
 * the absence of work.
 */

import { Box, Button, Stack, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import InboxOutlinedIcon from '@mui/icons-material/InboxOutlined';
import { NotWiredState } from '../common/NotWiredState';
import { EmptyState } from '../common/EmptyState';
import { PanelCard } from './PanelCard';
import { useRunQueue } from '../../hooks/useRunQueue';
import { formatRelativeTime } from '../../utils/time';
import type { QueueEntry } from '../../types/cockpit';

/**
 * How a queue state reads to the operator.
 *
 * `held` is separated from `waiting` in the type (see `types/cockpit.ts`)
 * because the two clear differently — waiting clears itself, held waits on a
 * human — and the labels have to preserve that or the distinction dies at the
 * last step.
 */
const QUEUE_STATE_LABELS: Record<QueueEntry['state'], string> = {
  waiting: 'Waiting',
  ready: 'Ready',
  dispatching: 'Dispatching',
  held: 'Held for approval',
};

export function QueuePanel() {
  const { data, state, error, phase } = useRunQueue();
  const now = new Date();

  return (
    <PanelCard
      title="Queue"
      subtitle="Work orders waiting to dispatch, in dispatch order."
      action={
        <Button component={RouterLink} to="/queue" size="small">
          Full queue
        </Button>
      }
      state={state}
      error={error}
      unwiredContent={
        <NotWiredState
          variant="compact"
          title="The queue appears here once dispatch exists"
          detail="This will show every authorized work order waiting for capacity, what it is waiting on, and how long it has been in line. Nothing is dispatched yet — the reconciler is read-only until execution lands."
          phase={phase}
        />
      }
      emptyContent={
        <EmptyState
          Icon={InboxOutlinedIcon}
          title="The queue is empty."
          detail="No work orders are waiting for capacity."
        />
      }
    >
      <Box component="ul" sx={{ m: 0, p: 0 }}>
        {data?.map((entry) => (
          <Box
            key={entry.id}
            component="li"
            sx={{
              listStyle: 'none',
              py: 1.25,
              borderBottom: '1px solid',
              borderColor: 'divider',
              '&:last-of-type': { borderBottom: 'none' },
            }}
          >
            <Stack
              direction="row"
              spacing={1}
              sx={{ alignItems: 'baseline', flexWrap: 'wrap' }}
            >
              {/* Tabular numerals so the position column does not jitter as
                  the queue re-orders under a poll. */}
              <Typography
                variant="body2"
                className="opifex-num"
                color="text.secondary"
              >
                {entry.position}.
              </Typography>
              <Typography variant="body2" sx={{ flexGrow: 1 }}>
                {entry.workOrder.title}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {QUEUE_STATE_LABELS[entry.state]}
              </Typography>
            </Stack>

            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
              <Typography
                variant="caption"
                className="opifex-mono"
                color="text.secondary"
                sx={{ wordBreak: 'break-all' }}
              >
                {entry.workOrder.id}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                queued {formatRelativeTime(entry.enqueuedAt, now) ?? 'recently'}
              </Typography>
            </Stack>

            {entry.waitingOn && (
              <Typography variant="caption" color="text.secondary">
                Waiting on {entry.waitingOn}
              </Typography>
            )}
          </Box>
        ))}
      </Box>
    </PanelCard>
  );
}

export default QueuePanel;
