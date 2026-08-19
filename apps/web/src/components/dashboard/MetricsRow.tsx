/**
 * The six success metrics as one responsive row.
 *
 * Epic #19, VISION §10. Six tiles, and the breakpoint ladder is chosen so the
 * row never leaves a lone orphan tile on its own line:
 *
 *   xs  -> 1 across (6 rows)      a phone reads them as a list
 *   sm  -> 2 across (3 rows)
 *   md  -> 3 across (2 rows)
 *   xl  -> 6 across (1 row)       the "cockpit glance" the page is designed for
 *
 * There is no `lg` step to 4 or 5, on purpose: 6 divided by 4 leaves two
 * stragglers and by 5 leaves one, and a hanging tile reads as a missing tile
 * on a dashboard whose whole job is reporting absence honestly. This is also
 * why `DashboardPage` uses `maxWidth="xl"` rather than `lg` — `lg` (1200px)
 * cannot fit six legible tiles across, so the last step would never be reached.
 *
 * The row takes its data as PROPS rather than calling `useCockpitMetrics`
 * itself: the page already holds that hook to drive the header's live/stale
 * indicator, and a second subscription would mean two independent polls, two
 * `lastUpdatedAt` values, and a header that can disagree with the tiles it
 * sits above.
 */

import { Grid } from '@mui/material';
import type { ResourceState } from '../../hooks/usePolledResource';
import type { MetricsSummary } from '../../types/cockpit';
import { METRIC_LIST } from './metrics';
import { MetricTile } from './MetricTile';

export interface MetricsRowProps {
  /** `null` whenever there is no reading — unwired, loading, or failed. */
  summary: MetricsSummary | null;
  state: ResourceState;
  /** Roadmap phase, passed to each tile's unwired caption. */
  phase: string;
}

export function MetricsRow({ summary, state, phase }: MetricsRowProps) {
  return (
    <Grid
      container
      spacing={2}
      component="section"
      // Named for screen readers because the six tiles are otherwise an
      // unlabelled run of sections; VISION §10's own phrase is used so the
      // landmark matches the document.
      aria-label="Success metrics"
    >
      {METRIC_LIST.map((metric) => {
        const sample = summary?.metrics[metric.id] ?? null;

        return (
          <Grid key={metric.id} size={{ xs: 12, sm: 6, md: 4, xl: 2 }}>
            <MetricTile
              metric={metric}
              value={sample?.value ?? null}
              trend={sample?.trend ?? null}
              state={state}
              phase={phase}
            />
          </Grid>
        );
      })}
    </Grid>
  );
}

export default MetricsRow;
