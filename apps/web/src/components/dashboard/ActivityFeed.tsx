/**
 * The normalized event stream, newest first.
 *
 * Epic #19, VISION §9's "normalized event floor": six event types, every
 * runner mapped into them. This is the first cockpit panel that can ever be
 * wired, because events start arriving in Phase 2 — the read-only reconciler —
 * long before anything is dispatched, which is why its unwired caption names
 * an earlier phase than the panels above it.
 *
 * ## `source` is rendered, always, and that is not decoration
 *
 * VISION §9 is explicit:
 *
 * > Events carry a `source` field distinguishing runner-reported from
 * > git-derived from control-plane-synthesized — a synthesized event must
 * > never masquerade as a report.
 *
 * Two independent liveness sources only buy anything if the operator can tell
 * which one spoke: "the runner says it finished" and "a commit landed on the
 * branch" are different evidence, and a control-plane-synthesized event is not
 * evidence at all — it is the system's own bookkeeping. Rendering all three
 * identically would quietly discard the property the whole design is built on.
 */

import { Box, Stack, Typography } from '@mui/material';
import HistoryIcon from '@mui/icons-material/History';
import { NotWiredState } from '../common/NotWiredState';
import { EmptyState } from '../common/EmptyState';
import { PanelCard } from './PanelCard';
import { useActivityFeed } from '../../hooks/useActivityFeed';
import { formatRelativeTime } from '../../utils/time';
import { EVENT_SOURCE_LABELS, EVENT_TYPE_LABELS } from '../../config/runEvents';
import type { RunEvent } from '../../types/cockpit';

export function ActivityFeed() {
  const { data, state, error, phase } = useActivityFeed();
  const now = new Date();

  return (
    <PanelCard
      title="Activity"
      subtitle="The normalized event stream, newest first."
      state={state}
      error={error}
      unwiredContent={
        <NotWiredState
          variant="compact"
          title="Events appear here once the reconciler runs"
          detail="Every run event — started, heartbeat, progress, blocked, completed, failed — will land here with the source that reported it. No reconciler is observing repositories yet, so there is no event history to show."
          phase={phase}
        />
      }
      emptyContent={
        <EmptyState
          Icon={HistoryIcon}
          title="No events yet."
          detail="Nothing has been reported in the current window."
        />
      }
    >
      <Box component="ul" sx={{ m: 0, p: 0 }}>
        {data?.map((event: RunEvent) => (
          <Box
            key={event.id}
            component="li"
            sx={{
              listStyle: 'none',
              py: 1,
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
              <Typography variant="body2" color="text.primary">
                {EVENT_TYPE_LABELS[event.type]}
              </Typography>
              <Typography
                variant="caption"
                className="opifex-mono"
                color="text.secondary"
                sx={{ wordBreak: 'break-all' }}
              >
                {event.workOrderId}
              </Typography>
              <Box sx={{ flexGrow: 1 }} />
              <Typography variant="caption" color="text.secondary">
                {formatRelativeTime(event.occurredAt, now) ?? ''}
              </Typography>
            </Stack>

            <Typography variant="body2" color="text.secondary">
              {event.summary}
            </Typography>

            <Typography variant="caption" color="text.disabled">
              {EVENT_SOURCE_LABELS[event.source]}
            </Typography>
          </Box>
        ))}
      </Box>
    </PanelCard>
  );
}

export default ActivityFeed;
