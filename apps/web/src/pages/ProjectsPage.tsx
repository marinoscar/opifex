import { Box, Container, Typography } from '@mui/material';
import { NotWiredState } from '../components/common/NotWiredState';

/**
 * `/projects` — the repositories Opifex supervises.
 *
 * Epic #19, issue #70. Planned destination; see `RunsPage.tsx`.
 *
 * This destination owns `/projects`, and by the longest-prefix rule in
 * `config/destinations.ts` it will also own `/projects/:id/runs` when that
 * route lands — the nested runs view highlights Projects, not Runs, because
 * that is where the operator navigated from.
 */
export default function ProjectsPage() {
  return (
    <Container maxWidth="xl">
      <Box sx={{ py: 2 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Projects
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 4 }}>
          The repositories under supervision, and what each one is allowed to
          do.
        </Typography>

        <NotWiredState
          title="No projects registered"
          detail="This will list each supervised repository with its runner capabilities, trust level and open work. The reconciler that discovers and mirrors project state has not been built, so no repository has been registered — this is an absence of a registry, not an empty one."
          phase="Phase 2 — Reconciler, read-only"
        />
      </Box>
    </Container>
  );
}
