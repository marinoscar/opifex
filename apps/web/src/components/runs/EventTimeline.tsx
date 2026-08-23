import {
  Box,
  Chip,
  Pagination,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';

import {
  EVENT_SOURCE_COLORS,
  EVENT_SOURCE_DESCRIPTIONS,
  EVENT_SOURCE_LABELS,
  EVENT_TYPE_LABELS,
} from '../../config/runEvents';
import { formatRelativeTime } from '../../utils/time';
import type { RunEvent } from '../../types/cockpit';

/**
 * A run's normalized event timeline (#83).
 *
 * ## Source is a chip, not a footnote
 *
 * VISION §9: *"a synthesized event must never masquerade as a report."* If all
 * three sources render identically, the UI reintroduces exactly the confusion
 * the discriminator exists to prevent — an operator debugging a false stall
 * needs to know whether the runner SAID it was blocked or Opifex INFERRED it,
 * and those two lead to opposite actions.
 *
 * Each source gets its own colour AND its own label, never colour alone: a
 * distinction carried only in hue is one an operator with a colour-vision
 * deficiency does not have.
 *
 * ## Paginated, because this is the high-volume table
 *
 * A single run emits a progress event per tool call plus heartbeats. #83 asks
 * that the timeline "stays responsive on a long run", which means the page
 * never holds more than one page of it.
 */
export interface EventTimelineProps {
  events: RunEvent[];
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  emptyMessage: string;
}

export function EventTimeline({
  events,
  page,
  pageCount,
  onPageChange,
  emptyMessage,
}: EventTimelineProps) {
  if (events.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
        {emptyMessage}
      </Typography>
    );
  }

  return (
    <Stack spacing={1.5}>
      {events.map((event) => (
        <Box
          key={event.id}
          sx={{
            display: 'flex',
            gap: 1.5,
            alignItems: 'baseline',
            flexWrap: 'wrap',
            borderLeft: 2,
            borderColor: 'divider',
            pl: 1.5,
          }}
        >
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ fontVariantNumeric: 'tabular-nums', minWidth: 76 }}
          >
            <Tooltip title={new Date(event.occurredAt).toISOString()}>
              <span>{formatRelativeTime(event.occurredAt) ?? '—'}</span>
            </Tooltip>
          </Typography>

          <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 84 }}>
            {EVENT_TYPE_LABELS[event.type]}
          </Typography>

          <Typography variant="body2" sx={{ flex: 1, minWidth: 200 }}>
            {event.summary}
          </Typography>

          <Tooltip title={EVENT_SOURCE_DESCRIPTIONS[event.source]}>
            <Chip
              size="small"
              variant="outlined"
              color={EVENT_SOURCE_COLORS[event.source]}
              label={EVENT_SOURCE_LABELS[event.source]}
            />
          </Tooltip>
        </Box>
      ))}

      {pageCount > 1 && (
        <Box sx={{ display: 'flex', justifyContent: 'center', pt: 1 }}>
          <Pagination
            count={pageCount}
            page={page}
            onChange={(_, next) => onPageChange(next)}
            size="small"
          />
        </Box>
      )}
    </Stack>
  );
}
