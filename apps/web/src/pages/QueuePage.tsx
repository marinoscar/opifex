import { Box, Container, Typography } from '@mui/material';
import { NotWiredState } from '../components/common/NotWiredState';

/**
 * `/queue` — work orders waiting for a runner.
 *
 * Epic #19, issue #70. Planned destination; see `RunsPage.tsx` for why a
 * planned page is routed rather than withheld.
 *
 * The queue is the one surface where a fabricated number would be actively
 * dangerous: "0 waiting" and "we do not know what is waiting" lead an operator
 * to opposite decisions, and only one of them is true today.
 */
export default function QueuePage() {
  return (
    <Container maxWidth="xl">
      <Box sx={{ py: 2 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Queue
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 4 }}>
          Work orders waiting for a runner, in dispatch order.
        </Typography>

        <NotWiredState
          title="Queue depth is unknown"
          detail="This will show what is waiting, how long it has waited, and why it has not started — no capacity, a budget ceiling, or a rate limit with a reset time. Dispatch does not exist yet, so there is no queue to measure; this is deliberately not reported as a depth of zero."
          phase="Phase 4 — Execution"
        />
      </Box>
    </Container>
  );
}
