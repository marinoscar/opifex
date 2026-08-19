/**
 * `/` — the operator dashboard.
 *
 * Epic #19, issue #75. Replaces `HomePage`, which showed a welcome banner, the
 * signed-in user's profile card, and a grid of links to four pages the
 * navigation already lists. None of that is what VISION §10 says this
 * application is for:
 *
 * > Six metrics. The web application exists primarily to show them.
 *
 * So the profile card MOVED to `/settings` — where identity actually belongs,
 * and where it was genuinely missing — and the quick-action links were deleted
 * outright now that the sectioned rail and the phone's More sheet reach all
 * eight destinations properly. What is left is a cockpit: how the system is
 * doing, what needs a human, what is queued, and what just happened.
 *
 * ## Nothing here has data, and the page says so four different times
 *
 * `apps/api` has no runs, queue or metrics module. Every panel renders its own
 * honest not-yet-wired state naming the roadmap phase that will supply it (see
 * `config/cockpitApi.ts` and the contract in
 * `components/common/NotWiredState.tsx`). No panel shows a zero, a placeholder
 * number, a fake sparkline or a shimmer skeleton.
 *
 * ## On a phone, escalation comes FIRST
 *
 * `AttentionPanel` is ordered above `MetricsRow` below `sm` and after it from
 * `sm` up. It is the same single mount reordered with CSS `order`, not a
 * second copy behind a breakpoint — two mounts would mean two subscriptions,
 * two polls, and a screen that can show the same panel twice mid-resize.
 *
 * The metrics hook lives HERE rather than inside `MetricsRow` because the
 * header's live/stale indicator and the tiles must agree about the same fetch;
 * two hooks would be two polls with two `lastUpdatedAt` values and a header
 * able to contradict the row beneath it. The other three panels own their own
 * hooks — they are independent resources, and one failing must not blank the
 * others.
 */

import { Box, Container, Grid } from '@mui/material';
import { DashboardHeader } from '../components/dashboard/DashboardHeader';
import type { DashboardStatus } from '../components/dashboard/DashboardHeader';
import { MetricsRow } from '../components/dashboard/MetricsRow';
import { AttentionPanel } from '../components/dashboard/AttentionPanel';
import { QueuePanel } from '../components/dashboard/QueuePanel';
import { ActivityFeed } from '../components/dashboard/ActivityFeed';
import { useCockpitMetrics } from '../hooks/useCockpitMetrics';
import type { ResourceState } from '../hooks/usePolledResource';

/**
 * Collapse a poll result into what the header should claim.
 *
 * Exported because this is the page's only real logic and it is worth testing
 * without mounting four polling panels. The `stale` case — data present AND an
 * error — is the one that matters: `usePolledResource` deliberately keeps the
 * last good data through a failed poll, so without this branch the header
 * would keep saying "Live" over numbers that stopped updating.
 */
export function deriveDashboardStatus(
  state: ResourceState,
  error: string | null,
): DashboardStatus {
  if (state === 'unwired') return 'unwired';
  if (state === 'error') return 'error';
  if (error !== null) return 'stale';
  return 'live';
}

export default function DashboardPage() {
  const metrics = useCockpitMetrics();

  return (
    // `xl`, not `lg`. Six metric tiles across need the width, and `lg`
    // (1200px) cannot fit six legible ones — the `xl: 2` step in `MetricsRow`
    // would never be reachable inside an `lg` container.
    <Container maxWidth="xl">
      <Box sx={{ py: 2 }}>
        <DashboardHeader
          status={deriveDashboardStatus(metrics.state, metrics.error)}
          lastUpdatedAt={metrics.lastUpdatedAt}
          isRefreshing={metrics.isRefreshing}
          onRefresh={() => void metrics.refresh()}
          phase={metrics.phase}
        />

        <Grid container spacing={3}>
          {/* DOM order is metrics-then-attention so the page reads top-down for
              a screen reader and for keyboard focus at every width; `order`
              only moves the PAINTED position on the narrowest class, where the
              phone's first screenful must be escalation. Do not "fix" this by
              swapping the mounts — the visual reorder is the exception, and it
              is scoped to the one breakpoint that needs it. */}
          <Grid size={12} sx={{ order: { xs: 2, sm: 1 } }}>
            <MetricsRow
              summary={metrics.data}
              state={metrics.state}
              phase={metrics.phase}
            />
          </Grid>

          <Grid size={12} sx={{ order: { xs: 1, sm: 2 } }}>
            <AttentionPanel />
          </Grid>

          {/* 7/5 rather than 6/6: the queue rows carry a work-order id and a
              title, the activity rows carry a one-line summary. Equal halves
              would wrap the ids. */}
          <Grid size={{ xs: 12, md: 7 }} sx={{ order: 3 }}>
            <QueuePanel />
          </Grid>
          <Grid size={{ xs: 12, md: 5 }} sx={{ order: 4 }}>
            <ActivityFeed />
          </Grid>
        </Grid>
      </Box>
    </Container>
  );
}
