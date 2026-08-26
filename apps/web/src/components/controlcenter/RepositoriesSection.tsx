/**
 * Repositories — the enablement ladder (#350, epic #332).
 *
 * Every registered repository, each with the four flags rendered as the
 * ordered progression `repository.dto.ts` documents: observe, mirror labels,
 * spec feedback, dispatch. This replaces `ProjectsPage`'s instruction to run
 * `curl -d '{"observeEnabled":true}'`, which was the only way to move any of
 * them.
 *
 * ## Read-only is a state, not a disabled screen
 *
 * `system_settings:read` gets an operator into the Control Center;
 * `projects:read` is what `RepositoriesController` enforces on the list. Those
 * are different permissions and an operator may hold one without the other, so
 * a 403 here is reported as a fact about the ACCOUNT rather than rendered as
 * an empty list — a screen that shows "no repositories" to someone who simply
 * may not ask is the failure mode this epic keeps naming.
 */

import { Alert, Box, Stack, Typography } from '@mui/material';

import { LoadingSpinner } from '../common/LoadingSpinner';
import { RepositoryLadderCard } from './RepositoryLadderCard';
import { LADDER_RUNGS } from '../../config/repositoryLadder';
import { useRepositoryLadder } from '../../hooks/useRepositoryLadder';

export interface RepositoriesSectionProps {
  /** `projects:write` — the string `RepositoriesController.update` enforces. */
  canWrite: boolean;
}

export function RepositoriesSection({ canWrite }: RepositoriesSectionProps) {
  // Read here rather than in the shell, so opening the Control Center on the
  // Readiness tab does not fire a `/repositories` page for an operator who may
  // hold `system_settings:read` and not `projects:read` — a request certain to
  // 403, for a section they never opened.
  const ladder = useRepositoryLadder();
  const {
    repositories,
    total,
    isLoading,
    error,
    savingId,
    probingId,
    probes,
    save,
    testAccess,
  } = ladder;

  if (isLoading) {
    return <LoadingSpinner />;
  }

  if (error) {
    return (
      <Alert severity="error">
        {error} Reading the repository list needs <code>projects:read</code>,
        which is a different permission from the one that opens this screen.
      </Alert>
    );
  }

  if (repositories.length === 0) {
    return (
      <Alert severity="info">
        No repository is registered, so there is no ladder to climb yet. Opifex
        only observes repositories it has been told about, and registration
        verifies the repository is reachable with the configured token before
        accepting it — see <code>POST /api/repositories</code> and the runbook.
      </Alert>
    );
  }

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {ladderSentence()}
      </Typography>

      {total > repositories.length && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Showing {repositories.length} of {total} registered repositories. The
          list endpoint caps a page at 100.
        </Alert>
      )}

      <Stack component="ul" spacing={2} sx={{ p: 0, m: 0 }}>
        {repositories.map((repository) => (
          <RepositoryLadderCard
            key={repository.id}
            repository={repository}
            canWrite={canWrite}
            isSaving={savingId === repository.id}
            onSave={(input) => save(repository.id, input)}
            probe={probes[repository.id]}
            isProbing={probingId === repository.id}
            onTestAccess={() => void testAccess(repository.id)}
          />
        ))}
      </Stack>
    </Box>
  );
}

/**
 * The ladder said once, at the top, in its own order.
 *
 * Built from `LADDER_RUNGS` rather than typed out, so a rung added or reordered
 * cannot leave this sentence describing the previous design.
 */
function ladderSentence(): string {
  const names = LADDER_RUNGS.map((rung) => rung.title.toLowerCase()).join(
    ', then ',
  );
  return (
    `Each repository is enabled in stages — ${names} — because the ` +
    'observation week has to end one repository at a time, and reading, ' +
    'writing a label and running are three different permissions to grant.'
  );
}

export default RepositoriesSection;
