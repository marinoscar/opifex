/**
 * A live countdown to an approval's timeout.
 *
 * Rendered ONLY when there is a real instant to count down to. There is no
 * "no timer" variant of this component on purpose: a parked approval has
 * `timeoutAt === null`, and the caller must render nothing at all rather than
 * an empty or dashed countdown slot — an empty slot still reads as a slot
 * where a deadline lives (see `ifIgnored.ts`).
 *
 * The tick is one second because the last minute of an `auto_approve` window
 * is exactly when an operator needs to know whether they still have time to
 * read the reasoning. It costs a `setState` per second on one small subtree,
 * and only while the element is mounted.
 */

import { useEffect, useState } from 'react';
import { Box, Tooltip, Typography } from '@mui/material';
import TimerOutlinedIcon from '@mui/icons-material/TimerOutlined';
import { formatCountdown, millisecondsUntil } from './ifIgnored';

export interface TimeRemainingProps {
  /** The instant the window closes. Never null — see the note above. */
  timeoutAt: string;
  /** `body2` in a table cell, `body1` beside the decision buttons. */
  variant?: 'body1' | 'body2';
  /** Fixed clock, for tests. Live when omitted. */
  now?: Date;
}

export function TimeRemaining({
  timeoutAt,
  variant = 'body2',
  now,
}: TimeRemainingProps) {
  const [tick, setTick] = useState(() => (now ?? new Date()).getTime());

  useEffect(() => {
    // A fixed clock is a fixed clock: a caller that passed `now` is asserting
    // the time, and a timer would fight it.
    if (now) return;
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [now]);

  const remaining = millisecondsUntil(timeoutAt, new Date(tick));
  const lapsed = !Number.isFinite(remaining) || remaining <= 0;

  return (
    <Tooltip title={`Window closes ${timeoutAt}`}>
      <Box
        // The hook a test asserts the ABSENCE of for a parked approval.
        data-testid="approval-countdown"
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.5,
          minWidth: 0,
        }}
      >
        <TimerOutlinedIcon
          fontSize="small"
          color={lapsed ? 'disabled' : 'inherit'}
        />
        <Typography
          variant={variant}
          component="span"
          color={lapsed ? 'text.secondary' : 'text.primary'}
          sx={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {formatCountdown(remaining)}
        </Typography>
      </Box>
    </Tooltip>
  );
}

export default TimeRemaining;
