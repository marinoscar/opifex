import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Container,
  Divider,
  MenuItem,
  Skeleton,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

import { DataTable } from '../components/datatable';
import type { DataTableFilterModel } from '../components/datatable';
import { QuotaGaugePanel } from '../components/quota/QuotaGaugePanel';
import {
  EPISODES_TABLE_ID,
  quotaEpisodeColumns,
} from '../components/quota/quotaEpisodeColumns';
import {
  WINDOWS_TABLE_ID,
  exhaustedWindowColumns,
  exhaustedWindowId,
} from '../components/quota/exhaustedWindowColumns';
import {
  DEFAULT_HISTORY_RANGE,
  HISTORY_RANGES,
  sinceFor,
} from '../components/quota/quotaFormat';
import {
  useQuotaEvents,
  useQuotaSummary,
  useQuotaWindows,
} from '../hooks/useQuota';
import { RATE_LIMIT_REASONS } from '../types/quota';
import type {
  ExhaustedWindow,
  RateLimitEpisode,
  RateLimitReason,
} from '../types/quota';

/**
 * `/quota` — where the subscription stands now, and when it has stopped work
 * before (#231 for the gauge, #476 for the memory).
 *
 * ## Why the history is on this page and not on its own
 *
 * #476: *"A section on the existing quota screen showing the same list under
 * the live gauge, so 'what is happening now' and 'what has been happening' sit
 * together."* An operator arriving here has one question — "is quota why
 * nothing is moving?" — and the two halves answer it from opposite ends. Split
 * across two destinations, the answer would require knowing in advance which
 * half to look at, which is the thing they cannot know.
 *
 * ## Why quota is not a section of `/cost`
 *
 * Cost is money and a window is a window; they are measured to different
 * standards, and `CostSummaryDto.quota` is permanently null so the cost screen
 * can SAY quota is unavailable rather than look like it was forgotten. The API
 * serves them from two controllers for that reason, and folding the two into
 * one screen would put back exactly the confusion the split exists to prevent.
 *
 * ## Two history tables, because there are two facts
 *
 * `quota_windows` records the vendor's window; `run_events` records what
 * happened to a run inside it. A window can hit its ceiling with nothing
 * dispatched against it — which blocks no run, writes no event, and is
 * therefore invisible to the episode list while still being a true answer to
 * "when did we hit rate limits". Neither table subsumes the other, the API
 * serves them from two routes for that reason, and merging them here would
 * mean choosing which of the two facts to drop.
 *
 * ## The range is shared, the column filters are not
 *
 * One range selector drives both tables, because "we lost Tuesday afternoon"
 * is one span and having to set it twice is how the two halves end up
 * disagreeing about which afternoon. Everything else is a column filter on the
 * table that owns it — `reason` exists only on episodes, and a window has none.
 *
 * Every filter is answered by the SERVER. Filtering a page of 25 in the
 * browser filters a PAGE, not the result set: it looks identical right up to
 * the moment the block that started the afternoon is on page four.
 */
export default function QuotaPage() {
  const [range, setRange] = useState(DEFAULT_HISTORY_RANGE);

  // Memoized on the range alone, and that is load-bearing rather than tidy:
  // `sinceFor` reads the clock, so an unmemoized call would produce a new ISO
  // string on every render, and both hooks take `since` in their `fetcherKey`
  // (#246) — which would turn every render into a refetch, on a screen that
  // also polls.
  const since = useMemo(() => sinceFor(range), [range]);

  const gauge = useQuotaSummary();

  return (
    <Container maxWidth="xl">
      <Box sx={{ py: 2 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Quota
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Where the agent subscription’s windows stand right now, and every time
          a limit has stopped work — with what Opifex did about it.
        </Typography>

        <Typography variant="h6" component="h2" gutterBottom>
          Now
        </Typography>
        {gauge.error && !gauge.data && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {gauge.error}
          </Alert>
        )}
        {gauge.error && gauge.data && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            These readings are stale — the last poll failed: {gauge.error}
          </Alert>
        )}
        {!gauge.data && !gauge.error && <Skeleton height={180} />}
        {gauge.data && <QuotaGaugePanel summary={gauge.data} />}

        <Divider sx={{ my: 4 }} />

        <Stack
          direction="row"
          spacing={2}
          sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1, mb: 1 }}
        >
          <Typography variant="h6" component="h2">
            History
          </Typography>
          <TextField
            select
            size="small"
            label="Range"
            value={range}
            onChange={(event) => setRange(event.target.value)}
            sx={{ minWidth: 170 }}
          >
            {HISTORY_RANGES.map((option) => (
              <MenuItem key={option.id} value={option.id}>
                {option.label}
              </MenuItem>
            ))}
          </TextField>
        </Stack>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          Nothing here is a new record: it is the blocked run events and the
          vendor windows the control plane was already writing, read back.
        </Typography>

        <EpisodesSection since={since} />

        <Box sx={{ mt: 5 }}>
          <WindowsSection since={since} />
        </Box>
      </Box>
    </Container>
  );
}

// ---------------------------------------------------------------------------
// Blocked runs
// ---------------------------------------------------------------------------

function EpisodesSection({ since }: { since: string | undefined }) {
  // Zero-based, like every DataTable pager in this app; the API is one-based,
  // so the conversion happens once, at the fetch boundary below.
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [filters, setFilters] = useState<DataTableFilterModel>([]);

  const reason = reasonFilter(filters);
  const runnerKey = runnerFilter(filters);

  const episodes = useQuotaEvents({
    page: page + 1,
    pageSize,
    since,
    reason,
    runnerKey,
  });

  const columns = useMemo(() => quotaEpisodeColumns(), []);
  const rows = episodes.data?.items ?? [];

  return (
    <Box>
      <Typography variant="subtitle1" component="h3" gutterBottom>
        Runs a limit stopped
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        One row per blocked run event that named a subscription-level reason,
        newest first. <strong>What Opifex did</strong> is the point of the
        table, and every verdict carries the observation it came from — hover
        it, or read the <em>Why</em> column.
      </Typography>

      <DataTable<RateLimitEpisode>
        tableId={EPISODES_TABLE_ID}
        ariaLabel="Rate-limit episodes"
        columns={columns}
        rows={rows}
        rowId={(episode) => episode.eventId}
        loading={episodes.isRefreshing && episodes.state !== 'ready'}
        error={episodes.error}
        emptyState={
          <Box sx={{ p: 3, textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary">
              No run was blocked by a rate limit in this range. That is a real
              answer rather than an empty table: blocks that named an approval
              gate or an unavailable upstream are facts about one run, not about
              the subscription, and are deliberately not listed here. A window
              can still have hit its ceiling with nothing dispatched against it
              — see below.
            </Typography>
          </Box>
        }
        pagination={{
          page,
          pageSize,
          total: episodes.data?.total ?? 0,
          // 100 is the endpoint's own ceiling (`QUOTA_EVENTS_MAX_PAGE_SIZE`).
          // Offering 200 would offer a page the API refuses.
          pageSizeOptions: [10, 25, 50, 100],
          onPaginationChange: (next) => {
            setPage(next.page);
            setPageSize(next.pageSize);
          },
        }}
        filters={filters}
        onFiltersChange={(next) => {
          setFilters(next);
          // Back to the first page: page four of the old filter is not page
          // four of the new one, and staying put would silently show a
          // different slice than the operator asked for.
          setPage(0);
        }}
      />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function WindowsSection({ since }: { since: string | undefined }) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [filters, setFilters] = useState<DataTableFilterModel>([]);

  const windows = useQuotaWindows({
    page: page + 1,
    pageSize,
    since,
    runnerKey: runnerFilter(filters),
  });

  const columns = useMemo(() => exhaustedWindowColumns(), []);
  const rows = windows.data?.items ?? [];

  return (
    <Box>
      <Typography variant="subtitle1" component="h3" gutterBottom>
        Windows that hit the wall
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Every vendor window whose worst reading reached <em>exhausted</em>,
        newest reset first — including the ones that blocked nothing, which no
        list of blocked runs can contain. A window here is matched to runs by
        its exact reset instant.
      </Typography>

      <DataTable<ExhaustedWindow>
        tableId={WINDOWS_TABLE_ID}
        ariaLabel="Exhausted quota windows"
        columns={columns}
        rows={rows}
        rowId={exhaustedWindowId}
        loading={windows.isRefreshing && windows.state !== 'ready'}
        error={windows.error}
        emptyState={
          <Box sx={{ p: 3, textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary">
              No window reached its ceiling in this range. Windows are only
              listed once their worst observed reading was <em>exhausted</em> —
              a window that stayed within its limit is not history, it is just a
              window.
            </Typography>
          </Box>
        }
        pagination={{
          page,
          pageSize,
          total: windows.data?.total ?? 0,
          pageSizeOptions: [10, 25, 50, 100],
          onPaginationChange: (next) => {
            setPage(next.page);
            setPageSize(next.pageSize);
          },
        }}
        filters={filters}
        onFiltersChange={(next) => {
          setFilters(next);
          setPage(0);
        }}
      />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Filter extraction
// ---------------------------------------------------------------------------

/**
 * The reason filter, pulled out of the table's model.
 *
 * Validated against the union rather than cast blindly: the model is
 * persisted per user (`user_settings.dataTables`), so a value stored before an
 * enum changed can outlive it, and sending it would earn a 400 from the
 * endpoint's zod schema rather than a filtered list.
 */
export function reasonFilter(
  filters: DataTableFilterModel,
): RateLimitReason | undefined {
  const entry = filters.find(
    (filter) => filter.columnId === 'reason' && filter.operator === 'is',
  );
  return RATE_LIMIT_REASONS.includes(entry?.value as RateLimitReason)
    ? (entry?.value as RateLimitReason)
    : undefined;
}

/**
 * The runner filter. `equals` only — both endpoints match the key exactly, so
 * offering `contains` would be offering a search the API cannot run.
 */
export function runnerFilter(
  filters: DataTableFilterModel,
): string | undefined {
  const entry = filters.find(
    (filter) => filter.columnId === 'runnerKey' && filter.operator === 'equals',
  );
  return typeof entry?.value === 'string' && entry.value.length > 0
    ? entry.value
    : undefined;
}
