/**
 * `/quota`: the exhausted-window table's column contract (#476).
 *
 * The sibling of `quotaEpisodeColumns.tsx`, over the other half of the
 * history. The two tables are NOT two views of one list: `quota_windows`
 * records the vendor's window, `run_events` records what happened to a run
 * inside it, and neither subsumes the other. A window can reach its ceiling
 * with nothing dispatched against it, and a run can block against a window the
 * poller only ever sighted once.
 *
 * ## `blockedRuns: 0` is the row this table exists for
 *
 * A window that hit the wall with nothing dispatched leaves no `run_events`
 * row at all, so it is structurally invisible to the episode list — and it is
 * still a true answer to "when did we hit rate limits". #476's added
 * acceptance criterion is that such a window stays distinguishable from one
 * that blocked runs, so the count is rendered as a SENTENCE ("Nothing
 * dispatched") rather than as a bare `0` in a numeric column, where it would
 * read as a missing join.
 *
 * ## What `GET /api/quota/windows` actually honours
 *
 * `runnerKey`, `since`, `until`, `page`, `pageSize`. No `reason` — a window
 * has none — and no `sort`: the order is fixed at newest reset first. So the
 * only filterable column here is the runner, and no header sorts.
 *
 * `since`/`until` on this endpoint test OVERLAP against the window's
 * observation span rather than equality against one instant, which is why a
 * window first sighted before the selected range can legitimately appear in
 * it.
 */

import { Stack, Tooltip, Typography } from '@mui/material';
import type { DataTableColumn } from '../datatable';
import { QuotaPressureChip } from './QuotaPressureChip';
import { describeBlockedRuns, formatInstant } from './quotaFormat';
import { formatRelativeTime } from '../../utils/time';
import type { ExhaustedWindow } from '../../types/quota';

/** Persistence key for `user_settings.dataTables`. A storage key, not a label. */
export const WINDOWS_TABLE_ID = 'quota-exhausted-windows';

const NUMERIC = { fontVariantNumeric: 'tabular-nums' } as const;

/**
 * A window's identity, for `rowId`.
 *
 * `(runnerKey, kind, resetsAt)` is the row's own unique key in the database —
 * the same tuple `QuotaWindow` is upserted on — so this is the real identity
 * rather than a stringified index, which would reshuffle selection and
 * expansion state on every poll.
 */
export function exhaustedWindowId(window: ExhaustedWindow): string {
  return `${window.runnerKey}::${window.kind}::${window.resetsAt}`;
}

export function exhaustedWindowColumns(): DataTableColumn<ExhaustedWindow>[] {
  return [
    {
      id: 'resetsAt',
      label: 'Reset',
      priority: 'primary',
      minWidth: 200,
      value: (window) => window.resetsAt,
      render: (window) => (
        <Stack spacing={0} sx={{ minWidth: 0 }}>
          <Typography variant="body2" sx={NUMERIC} noWrap>
            {formatInstant(window.resetsAt)}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap>
            {formatRelativeTime(window.resetsAt) ?? 'unknown'}
          </Typography>
        </Stack>
      ),
    },
    {
      id: 'runnerKey',
      label: 'Runner',
      priority: 'primary',
      filterable: ['equals'],
      filterType: 'text',
      minWidth: 150,
      value: (window) => window.runnerKey,
    },
    {
      /** The vendor's own label, verbatim: `five_hour`, `weekly`, `unknown`. */
      id: 'kind',
      label: 'Window',
      priority: 'primary',
      width: 130,
      value: (window) => window.kind,
    },
    {
      /**
       * Why this row is here at all.
       *
       * Only windows whose `peakPressure` reached `exhausted` are returned, so
       * this column is constant today — and it is still shown, because the
       * table's selectivity is a claim the screen should state rather than one
       * the reader has to be told out of band.
       */
      id: 'peakPressure',
      label: 'Peak',
      priority: 'primary',
      width: 150,
      value: (window) => window.peakPressure,
      render: (window) => <QuotaPressureChip pressure={window.peakPressure} />,
    },
    {
      /**
       * The LATEST reading, which is a different claim from the peak.
       *
       * `pressure` forgets the wall the moment the vendor says `allowed`
       * again — the distinction `QuotaWindow` keeps two columns for. "It hit
       * the wall at noon and is fine now" and "it is still at the wall" are
       * different things to be told, and the row tells both.
       */
      id: 'pressure',
      label: 'Now',
      priority: 'secondary',
      width: 150,
      value: (window) => window.pressure,
      render: (window) => <QuotaPressureChip pressure={window.pressure} />,
    },
    {
      id: 'blockedRuns',
      label: 'Cost to work',
      priority: 'primary',
      minWidth: 190,
      // The scalar stays the NUMBER so an export and any comparison get
      // something orderable; the sentence is the rendering, not the datum.
      value: (window) => window.blockedRuns,
      render: (window) => (
        <Tooltip
          title={
            window.blockedRuns === 0
              ? 'This window reached its ceiling with nothing dispatched against it. No run was blocked, so it appears in no episode — and the ceiling was still genuinely reached.'
              : 'Runs counted by the exact reset instant this window carries. More blocks than runs means a run was refused, resumed and refused again.'
          }
        >
          <Typography
            variant="body2"
            color={window.blockedRuns === 0 ? 'text.secondary' : 'text.primary'}
          >
            {describeBlockedRuns(window)}
          </Typography>
        </Tooltip>
      ),
    },
    {
      id: 'firstObservedAt',
      label: 'First seen',
      priority: 'detail',
      minWidth: 180,
      value: (window) => window.firstObservedAt,
      render: (window) => (
        <Typography variant="body2" sx={NUMERIC}>
          {formatInstant(window.firstObservedAt)}
        </Typography>
      ),
    },
    {
      id: 'lastObservedAt',
      label: 'Last seen',
      priority: 'detail',
      minWidth: 180,
      value: (window) => window.lastObservedAt,
      render: (window) => (
        <Typography variant="body2" sx={NUMERIC}>
          {formatInstant(window.lastObservedAt)}
        </Typography>
      ),
    },
    {
      /**
       * How many vendor lines carried this window. **Not a consumption
       * measure** — the API's schema says so on the column, and a header
       * reading "Observations" invites exactly that misreading, so the tooltip
       * says what it is: how much of the window this row can be trusted to
       * cover.
       */
      id: 'observations',
      label: 'Sightings',
      priority: 'detail',
      align: 'right',
      width: 110,
      value: (window) => window.observations,
      render: (window) => (
        <Tooltip title="How many vendor readings carried this window. It says how well observed the window is, not how much was consumed.">
          <Typography variant="body2" sx={NUMERIC}>
            {window.observations}
          </Typography>
        </Tooltip>
      ),
    },
  ];
}
