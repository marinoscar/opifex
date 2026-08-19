import { Box, Container, Typography } from '@mui/material';
import { NotWiredState } from '../components/common/NotWiredState';

/**
 * `/cost` — spend per outcome.
 *
 * Epic #19, issue #70. Planned destination; see `RunsPage.tsx`.
 *
 * Cost is one of VISION §10's six success metrics, and the one most easily
 * misread: an unwired cost page showing "$0.00" would report the single most
 * reassuring number the system can produce, about a system that has never run.
 * Hence the em dash, here and in every metric tile.
 */
export default function CostPage() {
  return (
    <Container maxWidth="xl">
      <Box sx={{ py: 2 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Cost
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 4 }}>
          What the work costs, per merged pull request rather than per token.
        </Typography>

        <NotWiredState
          title="No spend to report"
          detail="This will break spend down by project and by run, against the budget ceiling each project is given. No run has been dispatched and no budget has been enforced, so there is no spend — reported here as unknown rather than as zero."
          phase="Phase 4 — Execution"
        />
      </Box>
    </Container>
  );
}
