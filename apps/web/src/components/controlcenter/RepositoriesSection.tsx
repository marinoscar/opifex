/**
 * Repositories — registration (#401) and the enablement ladder (#350, epic
 * #332).
 *
 * Every registered repository, each with the four flags rendered as the
 * ordered progression `repository.dto.ts` documents: observe, mirror labels,
 * spec feedback, dispatch. This replaces `ProjectsPage`'s instruction to run
 * `curl -d '{"observeEnabled":true}'`, which was the only way to move any of
 * them.
 *
 * ## Adding one is now possible here at all
 *
 * `POST /api/repositories` has always existed and nothing in `apps/web` called
 * it, so an operator saw whatever was curl'd in once and could not add a
 * second — the gap #350 closed for ENABLING a repository and never covered for
 * adding one. The Add affordance below opens a picker over what the configured
 * credential can actually reach, rather than a text field for a value the
 * system can enumerate.
 *
 * The button is rendered in every state that has one, including the empty one:
 * a deployment with nothing registered is exactly when somebody needs to add
 * something, and putting the affordance behind a populated list would be the
 * same dead end in a new place.
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

import { useState } from 'react';
import { Alert, Box, Button, Stack, Typography } from '@mui/material';

import { AddRepositoryDialog } from './AddRepositoryDialog';
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
    adopt,
  } = ladder;

  // Mounted only while open, so the picker's GitHub request happens when the
  // operator asks for it rather than on every load of this section.
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  /** The registration a picker row pointed at. Highlighted, never scrolled to
   * blindly. */
  const [revealedId, setRevealedId] = useState<string | null>(null);

  const showRegistered = (repositoryId: string) => {
    setIsPickerOpen(false);
    setRevealedId(repositoryId);
    // Optional-called: jsdom does not implement `scrollIntoView`, and the
    // highlight above is what actually carries the meaning — the same
    // treatment `useHashScroll` gives it. The card is already mounted behind
    // the dialog, so there is nothing to wait for.
    document
      .getElementById(`repository-${repositoryId}`)
      ?.scrollIntoView?.({ block: 'center' });
  };

  const picker = isPickerOpen && (
    <AddRepositoryDialog
      canWrite={canWrite}
      onClose={() => setIsPickerOpen(false)}
      onRegistered={adopt}
      onShowRegistered={showRegistered}
    />
  );

  const addButton = (
    <Button
      variant="contained"
      size="small"
      onClick={() => setIsPickerOpen(true)}
      disabled={!canWrite}
    >
      Add repository
    </Button>
  );

  // ONE tree, with the picker always at the same position in it.
  //
  // Registering the first repository moves this section from its empty state
  // to its populated one, and an early `return` per state would put the dialog
  // in a different place in each — so React would unmount and remount it on
  // exactly the render that reported success, throwing away the confirmation
  // and firing a second GitHub listing. The picker is a sibling of whichever
  // body is rendered, and survives the swap.
  const body = isLoading ? (
    <LoadingSpinner />
  ) : error ? (
    <Alert severity="error">
      {error} Reading the repository list needs <code>projects:read</code>,
      which is a different permission from the one that opens this screen.
    </Alert>
  ) : repositories.length === 0 ? (
    <Box>
      <Alert severity="info" sx={{ mb: 2 }}>
        No repository is registered, so there is no ladder to climb yet. Opifex
        only observes repositories it has been told about, and registration
        verifies the repository is reachable with the configured token before
        accepting it. Add one below — the list offered is what the configured
        credential can actually reach.
      </Alert>
      {addButton}
    </Box>
  ) : (
    <Box>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        sx={{
          mb: 2,
          alignItems: { sm: 'flex-start' },
          justifyContent: 'space-between',
        }}
      >
        <Typography variant="body2" color="text.secondary">
          {ladderSentence()}
        </Typography>
        <Box sx={{ flexShrink: 0 }}>{addButton}</Box>
      </Stack>

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
            isRevealed={revealedId === repository.id}
          />
        ))}
      </Stack>
    </Box>
  );

  return (
    <Box>
      {body}
      {picker}
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
