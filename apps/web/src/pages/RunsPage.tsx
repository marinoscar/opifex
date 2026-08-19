import { Box, Container, Typography } from '@mui/material';
import { NotWiredState } from '../components/common/NotWiredState';

/**
 * `/runs` — every run the reconciler has observed.
 *
 * Epic #19, issue #70. The page is routed and navigable BEFORE it has data on
 * purpose: the destination model lists it as `status: 'planned'`, and a planned
 * destination that 404s teaches the operator nothing about what the system will
 * do. What it must never do is invent rows — see the honesty contract in
 * `components/common/NotWiredState.tsx`.
 *
 * When the runs endpoint lands this page becomes a `DataTable` with its column
 * definitions in `components/runs/runColumns.tsx` (the `userListColumns.tsx`
 * pattern), the destination flips to `live`, and it gains the permission its
 * controller actually enforces — all in the same pull request.
 */
export default function RunsPage() {
  return (
    <Container maxWidth="xl">
      <Box sx={{ py: 2 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Runs
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 4 }}>
          Every agent run, its status, and what it changed.
        </Typography>

        <NotWiredState
          title="No runs to show"
          detail="This will list every run the reconciler has observed — work order, project, status, duration and the pull request it opened. Nothing is dispatched yet, and the API has no runs endpoint, so there is no run history to report rather than an empty one."
          phase="Phase 2 — Reconciler, read-only"
        />
      </Box>
    </Container>
  );
}
