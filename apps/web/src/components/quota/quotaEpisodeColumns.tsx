/**
 * `/quota`: the rate-limit episode table's column contract (#476).
 *
 * A sibling module rather than columns inlined in the page, following
 * `runColumns.tsx` and `userListColumns.tsx`: the column list is the table's
 * PUBLIC shape — what a test, a CSV export and both renderers read — while the
 * page is the state that feeds it.
 *
 * ## What `GET /api/quota/events` actually honours
 *
 * `sortable` and `filterable` are declared ONLY where the endpoint can serve
 * them, because a control the page cannot answer looks live and does nothing.
 * Read off `apps/api/src/quota/dto/quota-history.dto.ts`:
 *
 *   | query param | accepts                             | column here          |
 *   | ----------- | ----------------------------------- | -------------------- |
 *   | `reason`    | `rate-limit` \| `quota-exhausted`   | `reason`, `is`       |
 *   | `runnerKey` | an exact key                        | `runnerKey`, `equals`|
 *   | `since`     | ISO instant                         | the page's range     |
 *   | `until`     | ISO instant                         | the page's range     |
 *   | `page` / `pageSize` (max 100)     |                | the pager            |
 *
 * **Nothing is sortable.** The endpoint declares no `sort` parameter at all —
 * the order is fixed at newest-first — so every header here is inert by
 * design. Offering a sortable "Lasted" column would be offering a lie.
 *
 * ## Four columns carry a qualification, and none of them may lose it
 *
 *  - **Lasted** is an UPPER BOUND, never a measurement: nothing writes
 *    `RunAttempt` rows, so the exact resume instant is stored nowhere and the
 *    API bounds the episode by the run's next block or by `Run.lastEventAt`.
 *    The header says "at most" and the tooltip says why.
 *  - **Run now** is the run's status TODAY, which for an old episode is not
 *    its state then. It is here because "did that run ever finish" is the next
 *    question after "what did Opifex do", and it is labelled so nobody reads
 *    it as the status at the time of the block.
 *  - **Window** is null whenever no stored `quota_windows` row carries the
 *    block's exact reset instant. That is an expected answer — the poller and
 *    the runner's block report are independent observations — and it is
 *    rendered as a sentence rather than as a blank.
 *  - **Why** is the API's own `dispositionBasis`, rendered verbatim.
 */

import { Box, Link, Stack, Tooltip, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import type { DataTableColumn } from '../datatable';
import { StatusChip } from '../dashboard/StatusChip';
import { EpisodeDispositionChip } from './EpisodeDispositionChip';
import { QuotaPressureChip } from './QuotaPressureChip';
import { RateLimitReasonChip } from './RateLimitReasonChip';
import { formatEpisodeDuration, formatInstant } from './quotaFormat';
import { RATE_LIMIT_REASON_LIST } from '../../config/quotaHistory';
import { formatRelativeTime } from '../../utils/time';
import type { RateLimitEpisode } from '../../types/quota';

/**
 * Persistence key for `user_settings.dataTables`. A constant, never derived
 * from the route or the heading: it is a storage key and must survive a
 * rename.
 */
export const EPISODES_TABLE_ID = 'quota-episodes';

/** Tabular numerals, so a polling column of ages and spans does not jitter. */
const NUMERIC = { fontVariantNumeric: 'tabular-nums' } as const;

export function quotaEpisodeColumns(): DataTableColumn<RateLimitEpisode>[] {
  return [
    {
      id: 'occurredAt',
      label: 'When',
      priority: 'primary',
      align: 'right',
      width: 120,
      // The raw instant is the scalar: an export and any comparison want
      // something orderable, and "3h ago" sorts alphabetically into nonsense.
      value: (episode) => episode.occurredAt,
      render: (episode) => (
        <Tooltip title={formatInstant(episode.occurredAt)}>
          <Typography variant="body2" sx={NUMERIC}>
            {formatRelativeTime(episode.occurredAt) ?? '—'}
          </Typography>
        </Tooltip>
      ),
    },
    {
      /**
       * Filterable, honoured server-side, and offering the two reasons
       * SEPARATELY.
       *
       * #476 is explicit that `rate-limit` and `quota-exhausted` must not be
       * flattened: an overage refused while the window is still live usually
       * clears in minutes, a spent window waits for its reset. Collapsing them
       * into one "rate limited" filter would undo that distinction exactly
       * where an operator acts on it.
       */
      id: 'reason',
      label: 'Reason',
      priority: 'primary',
      filterable: ['is'],
      filterType: 'enum',
      enumValues: RATE_LIMIT_REASON_LIST.map((descriptor) => ({
        value: descriptor.reason,
        label: descriptor.label,
      })),
      width: 190,
      value: (episode) => episode.reason,
      render: (episode) => <RateLimitReasonChip reason={episode.reason} />,
    },
    {
      id: 'workOrderIdentity',
      label: 'Work order',
      priority: 'primary',
      minWidth: 220,
      flex: 1,
      value: (episode) => episode.workOrderIdentity,
      render: (episode) => (
        <Stack spacing={0} sx={{ minWidth: 0 }}>
          {/* The way into the run this happened to — #476's "each row links to
              its run". The work-order identity is the natural handle: it is
              what a commit trailer, an authorization record and a branch name
              all carry, so it is what an operator recognises. */}
          <Link
            component={RouterLink}
            to={`/runs/${episode.runId}`}
            variant="body2"
            noWrap
            sx={NUMERIC}
          >
            {episode.workOrderIdentity}
          </Link>
          <Typography variant="caption" color="text.secondary" noWrap>
            {episode.repository} #{episode.issueNumber}
          </Typography>
        </Stack>
      ),
    },
    {
      /**
       * The point of the endpoint, and of this screen.
       *
       * The chip's tooltip carries `dispositionBasis`; the `Why` column below
       * carries it as text as well, so it survives an export and reaches a
       * phone, where hovering is not a gesture.
       */
      id: 'disposition',
      label: 'What Opifex did',
      priority: 'primary',
      width: 190,
      value: (episode) => episode.disposition,
      render: (episode) => (
        <EpisodeDispositionChip
          disposition={episode.disposition}
          basis={episode.dispositionBasis}
        />
      ),
    },
    {
      /**
       * The observation the verdict came from, verbatim.
       *
       * Its own column rather than only a tooltip: the API writes one of these
       * for every row precisely so no verdict has to be taken on trust, and a
       * fact that only exists on hover does not exist in a CSV, on a phone, or
       * for anyone reading with a keyboard.
       */
      id: 'dispositionBasis',
      label: 'Why',
      priority: 'secondary',
      minWidth: 260,
      flex: 1,
      truncate: true,
      value: (episode) => episode.dispositionBasis,
    },
    {
      id: 'runnerKey',
      label: 'Runner',
      priority: 'secondary',
      filterable: ['equals'],
      filterType: 'text',
      minWidth: 150,
      value: (episode) => episode.runnerKey,
    },
    {
      id: 'durationMs',
      label: 'Lasted (at most)',
      priority: 'secondary',
      align: 'right',
      width: 140,
      value: (episode) => episode.durationMs,
      render: (episode) => (
        <Tooltip
          title={
            episode.nextActivityAt
              ? `An upper bound: the next activity observed on this run was at ${formatInstant(episode.nextActivityAt)}. Nothing stores the exact resume instant.`
              : 'No later activity has been observed on this run, so the episode has no observed end yet.'
          }
        >
          <Typography variant="body2" sx={NUMERIC}>
            {formatEpisodeDuration(episode.durationMs)}
          </Typography>
        </Tooltip>
      ),
    },
    {
      /**
       * The run's status NOW — not its status when it was blocked.
       *
       * Rendered through the app's one `StatusChip` rather than as text, so a
       * run status means the same thing here as it does on `/runs`.
       */
      id: 'runStatus',
      label: 'Run now',
      priority: 'secondary',
      width: 140,
      value: (episode) => episode.runStatus,
      render: (episode) => <StatusChip status={episode.runStatus} />,
    },
    {
      id: 'blockedUntil',
      label: 'Vendor reset',
      priority: 'detail',
      minWidth: 180,
      value: (episode) => episode.blockedUntil,
      render: (episode) =>
        episode.blockedUntil ? (
          <Typography variant="body2" sx={NUMERIC}>
            {formatInstant(episode.blockedUntil)}
          </Typography>
        ) : (
          // Not an em dash: an undated block is a specific and consequential
          // case — it is the one the watchdog escalates after its patience
          // window, because nothing can say when it lifts.
          <Typography variant="body2" color="text.secondary">
            Not dated by the runner
          </Typography>
        ),
    },
    {
      id: 'resumesAt',
      label: 'Resume scheduled',
      priority: 'detail',
      minWidth: 180,
      value: (episode) => episode.resumesAt,
      render: (episode) =>
        episode.resumesAt ? (
          <Typography variant="body2" sx={NUMERIC}>
            {formatInstant(episode.resumesAt)}
          </Typography>
        ) : (
          <Tooltip title="Only an episode a run is still sitting in has a scheduled resume. Reading today’s schedule back onto a past block would credit a park to a block that was over days ago.">
            <Typography variant="body2" color="text.secondary">
              Not for a past block
            </Typography>
          </Tooltip>
        ),
    },
    {
      id: 'window',
      label: 'Vendor window',
      priority: 'detail',
      minWidth: 220,
      value: (episode) => episode.window?.kind ?? null,
      render: (episode) =>
        episode.window ? (
          <Stack
            direction="row"
            spacing={1}
            sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}
          >
            <Typography variant="body2">{episode.window.kind}</Typography>
            <QuotaPressureChip
              pressure={episode.window.peakPressure}
              prefix="Peak"
            />
          </Stack>
        ) : (
          <Tooltip title="A window is matched on the runner and the exact reset instant. No stored window carries this one — the quota poller and the runner’s block report are independent observations, so this is expected rather than a lookup failure. A nearest-window guess would present a guess as a fact.">
            <Typography variant="body2" color="text.secondary">
              None stored for this reset
            </Typography>
          </Tooltip>
        ),
    },
    {
      id: 'escalation',
      label: 'Escalation',
      priority: 'detail',
      minWidth: 240,
      truncate: true,
      value: (episode) =>
        episode.escalation
          ? `${episode.escalation.kind} (${episode.escalation.status}): ${episode.escalation.summary}`
          : null,
      render: (episode) =>
        episode.escalation ? (
          <Stack spacing={0} sx={{ minWidth: 0 }}>
            <Typography variant="body2" noWrap>
              {episode.escalation.summary}
            </Typography>
            <Typography variant="caption" color="text.secondary" noWrap>
              {episode.escalation.kind} · {episode.escalation.status} ·{' '}
              {formatInstant(episode.escalation.raisedAt)}
            </Typography>
          </Stack>
        ) : (
          <Box component="span" sx={{ color: 'text.disabled' }}>
            Nobody was told
          </Box>
        ),
    },
  ];
}
