/**
 * The escalation panel — the most important thing on the dashboard.
 *
 * Epic #19, VISION §9: "A stalled run that nobody is told about is the exact
 * failure this system exists to eliminate." This panel is that telling, which
 * is why `DashboardPage` renders it ABOVE the metrics on a phone: the metrics
 * are how the system is doing, this is what needs doing right now, and the
 * phone is where an operator reads the second one.
 *
 * ## Its empty state and its unwired state are OPPOSITE claims
 *
 * This panel is the reason `EmptyState` and `NotWiredState` are two components:
 *
 *   empty   -> "the watchdog looked at every run and none needs you" — the
 *              best news the cockpit can deliver, and it is stated
 *              confidently, in primary text, with a check mark.
 *   unwired -> "there is no watchdog" — which says nothing whatsoever about
 *              the health of any run, and is drawn recessively with a roadmap
 *              phase instead of a verdict.
 *
 * An operator who reads the second as the first has been reassured by a
 * component that has never looked at a run. Do not let these converge.
 */

import { Box, Button } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { NotWiredState } from '../common/NotWiredState';
import { EmptyState } from '../common/EmptyState';
import { PanelCard } from './PanelCard';
import { AttentionRow } from './AttentionRow';
import { useRunsNeedingAttention } from '../../hooks/useRunsNeedingAttention';

export function AttentionPanel() {
  const { data, state, error, phase } = useRunsNeedingAttention();

  // One `now` for the whole list, so five rows cannot report five different
  // "current" times, and one render cannot straddle a minute boundary.
  const now = new Date();

  return (
    <PanelCard
      title="Needs attention"
      subtitle="Runs the control plane says a human has to touch."
      action={
        <Button component={RouterLink} to="/runs" size="small">
          All runs
        </Button>
      }
      state={state}
      error={error}
      unwiredContent={
        <NotWiredState
          variant="compact"
          title="Escalations appear here once the watchdog lands"
          detail="Stalled, failed and quarantined runs will be listed here with the reason and the age of the last event. Nothing is watching runs yet, so this panel is empty because there is no watchdog — not because every run is healthy."
          phase={phase}
        />
      }
      emptyContent={
        <EmptyState
          title="Nothing needs attention."
          detail="Every run is either progressing or parked with a reset time. Blocked runs resume on their own and are deliberately not listed here."
          action={
            <Button component={RouterLink} to="/runs" size="small" variant="outlined">
              View all runs
            </Button>
          }
        />
      }
    >
      {/* A real list, not a stack of divs: a screen reader user gets "list, 3
          items" and can skip it, which on the panel most likely to be read
          under time pressure is worth the two extra elements. */}
      <Box component="ul" sx={{ m: 0, p: 0 }}>
        {data?.map((run) => <AttentionRow key={run.id} run={run} now={now} />)}
      </Box>
    </PanelCard>
  );
}

export default AttentionPanel;
