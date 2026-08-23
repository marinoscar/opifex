/**
 * One escalation, as a row in the attention panel.
 *
 * Epic #19, VISION §9 ("Escalation is an action, not telemetry"). The row's
 * job is to answer three questions in one glance, in this order:
 *
 *   what state is it in   -> `StatusChip` (icon + label + color, always)
 *   how long has it been  -> the age, from `lastEventAt`
 *   what do I do about it -> `attentionReason`, or the reset time if it will
 *                            resume by itself
 *
 * **The age is measured from `lastEventAt`, not `startedAt`**, and that is the
 * whole point of the row. A run that has been going for six hours with events
 * flowing is healthy; one silent for six minutes is the failure this system
 * exists to catch. Showing total runtime here would foreground the least
 * interesting number on the panel.
 *
 * ## Why this is not a DataTable row
 *
 * The panel shows at most five of these and needs visual HIERARCHY — status
 * first, then a quiet identifier, then a sentence — not the pagination,
 * filtering, sorting and export chrome `DataTable` brings. `DataTable` is
 * reused in full on `/runs`, where all of that is exactly what is wanted.
 */

import { Box, Link, Stack, Typography } from '@mui/material';
import type { RunSummary } from '../../types/cockpit';
import { StatusChip } from './StatusChip';
import { formatRelativeTime } from '../../utils/time';

export interface AttentionRowProps {
  run: RunSummary;
  /**
   * Injected so the rendered age is testable without faking the clock. The
   * panel passes one `now` to every row, which also stops a list from showing
   * ages computed microseconds apart.
   */
  now?: Date;
}

export function AttentionRow({ run, now }: AttentionRowProps) {
  // `lastEventAt` may legitimately be null: a run dispatched but never heard
  // from is exactly the "silent" failure mode, and it has no last event by
  // definition. `formatRelativeTime` returns null rather than inventing a
  // time, and the row says so in words.
  const age = formatRelativeTime(run.lastEventAt, now);
  const resumesIn = formatRelativeTime(run.resumesAt, now);

  return (
    <Box
      component="li"
      sx={{
        listStyle: 'none',
        py: 1.5,
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5,
        borderBottom: '1px solid',
        borderColor: 'divider',
        '&:last-of-type': { borderBottom: 'none' },
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        // Wraps rather than truncating: on a phone this panel is the first
        // thing on the page, and a truncated work-order id is useless for the
        // one thing an id is for. `alignItems` goes through `sx` because MUI 9
        // dropped it from `StackOwnProps`.
        sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}
      >
        <StatusChip status={run.status} />

        <Typography
          variant="body2"
          className="opifex-mono"
          color="text.secondary"
          sx={{ wordBreak: 'break-all' }}
        >
          {run.workOrder.id}
        </Typography>

        <Box sx={{ flexGrow: 1 }} />

        <Typography variant="caption" color="text.secondary">
          {age === null ? 'no events yet' : `last event ${age}`}
        </Typography>
      </Stack>

      <Typography variant="body2" color="text.primary">
        {run.pullRequestUrl ? (
          <Link
            href={run.pullRequestUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {run.workOrder.title}
          </Link>
        ) : (
          run.workOrder.title
        )}
      </Typography>

      {/* The two mutually exclusive halves of VISION §9's escalation rule. A
          reason means a human acts; a reset time means a human must NOT — and
          the row never shows both, because a run cannot simultaneously need
          intervention and be handling itself. */}
      {run.attentionReason && (
        <Typography variant="body2" color="text.secondary">
          {run.attentionReason}
        </Typography>
      )}
      {!run.attentionReason && resumesIn && (
        <Typography variant="body2" color="text.secondary">
          Resumes {resumesIn}
        </Typography>
      )}
    </Box>
  );
}

export default AttentionRow;
