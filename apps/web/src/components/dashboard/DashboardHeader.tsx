/**
 * The cockpit's title row: what this screen is, and how much to trust it.
 *
 * Epic #19. The heading is the easy half; the indicator beside it is the point.
 * A dashboard that polls has four honestly different things to say about the
 * numbers below it, and saying nothing is equivalent to claiming the first:
 *
 *   `live`    — fetched successfully, this is current
 *   `stale`   — the last fetch FAILED; what you see is older than it looks,
 *               and the chip carries the wall-clock time it was last true
 *   `error`   — we have nothing at all to show and cannot get it
 *   `unwired` — there is no endpoint; nothing below has ever been measured
 *
 * ## The refresh control is HIDDEN when unwired, not disabled
 *
 * A permanently disabled button is noise: it occupies the affordance for an
 * action that will never become available in this build, and a user who cannot
 * see why it is disabled reads it as breakage. Disabled means "not right now";
 * absent means "not a thing here". This is unwired, so it is absent.
 *
 * ## Why these use MUI's semantic chip colors and run statuses do not
 *
 * `theme/tokens.ts`'s hue-allocation rule reserves the status vocabulary for
 * RUN states. These four are states of the CONNECTION, not of any run, so they
 * are deliberately drawn from MUI's generic channels — using a status token
 * here would put a run's color on something that is not a run, which is the
 * collision the rule exists to prevent.
 */

import {
  Box,
  Chip,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import CircularProgress from '@mui/material/CircularProgress';
import { formatClockTime } from '../../utils/time';

export type DashboardStatus = 'live' | 'unwired' | 'stale' | 'error';

export interface DashboardHeaderProps {
  status: DashboardStatus;
  /** When the data below was last known good. Null until the first success. */
  lastUpdatedAt: Date | null;
  isRefreshing: boolean;
  onRefresh: () => void;
  /**
   * The roadmap phase named in the unwired chip. Passed in rather than read
   * from `config/cockpitApi.ts` here, so the header states the phase of the
   * resource it is actually reporting on.
   */
  phase?: string;
}

export function DashboardHeader({
  status,
  lastUpdatedAt,
  isRefreshing,
  onRefresh,
  phase,
}: DashboardHeaderProps) {
  const clock = formatClockTime(lastUpdatedAt);

  const chip = (() => {
    switch (status) {
      case 'unwired':
        return {
          label: phase ? `Not yet wired — ${phase}` : 'Not yet wired',
          color: 'default' as const,
        };
      case 'stale':
        return {
          // An absolute time, not "4m ago": a relative age that is itself only
          // recomputed on each poll is a stale string about staleness.
          label: clock ? `Stale since ${clock}` : 'Stale',
          color: 'warning' as const,
        };
      case 'error':
        return { label: 'Cannot reach the API', color: 'error' as const };
      case 'live':
      default:
        return {
          label: clock ? `Live — updated ${clock}` : 'Live',
          color: 'success' as const,
        };
    }
  })();

  return (
    <Box sx={{ mb: 3 }}>
      <Stack
        direction="row"
        spacing={2}
        // Wraps on a phone rather than squeezing the chip into an ellipsis —
        // the chip is the part of this row that carries information.
        sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}
      >
        <Typography variant="h4" component="h1">
          Cockpit
        </Typography>

        <Chip
          size="small"
          label={chip.label}
          color={chip.color}
          variant={status === 'unwired' ? 'outlined' : 'filled'}
        />

        <Box sx={{ flexGrow: 1 }} />

        {/* Absent, not disabled, when there is nothing to refresh. */}
        {status !== 'unwired' && (
          <Tooltip title="Refresh now">
            {/* The span keeps the tooltip working while the button is busy. */}
            <span>
              <IconButton
                onClick={onRefresh}
                disabled={isRefreshing}
                aria-label="Refresh dashboard"
                size="small"
              >
                {isRefreshing ? (
                  <CircularProgress size={18} />
                ) : (
                  <RefreshIcon />
                )}
              </IconButton>
            </span>
          </Tooltip>
        )}
      </Stack>

      <Typography color="text.secondary" sx={{ mt: 0.5 }}>
        Every run, what needs a human, and the six metrics this exists to move.
      </Typography>
    </Box>
  );
}

export default DashboardHeader;
