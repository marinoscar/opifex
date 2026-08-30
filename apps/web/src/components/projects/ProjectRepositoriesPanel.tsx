/**
 * The repositories of one scope, managed (#406, epic #403).
 *
 * This is what the Projects destination now opens onto: not a table that reads
 * permissions and points at a settings screen, but the place they are changed.
 * Adding, the enablement ladder, retiring, de-registering and moving all
 * happen here.
 *
 * ## The scope may be a project or may be "no project"
 *
 * Both are rendered by this one component, with a different header and the
 * same body, because the repositories in them are managed identically. Making
 * unassigned a lesser screen — a list without the ladder, or without the Add
 * button — would strand every repository registered before projects existed,
 * which today is all of them.
 *
 * ## The ladder is #350's, moved rather than rebuilt
 *
 * `RepositoryLadderCard` and its `config/repositoryLadder` ordering came here
 * unchanged. The progression observe → mirror labels → spec feedback →
 * dispatch, and the out-of-order confirmation, are the design; where they are
 * mounted is not.
 *
 * ## The observed label row sits with the ladder, not inside it (#415)
 *
 * `RepositoryLadderCard` draws it; the state lives in `useRepositoryLadder`
 * beside the access probes, keyed by repository id. That is deliberate: the
 * registration dialog's answer carries a label report for the repository it
 * just created, and a per-card hook would have nowhere to put it — the new row
 * would ask GitHub again for something asked a second earlier.
 *
 * ## Steering is offered from here, and only to somebody who may steer (#461)
 *
 * The project header carries a link to `/steering?scope=project:<uuid>` and
 * each ladder card one to its own repository, because those are the two places
 * on this screen where what an instruction would reach is unambiguous. Both
 * are absent — not disabled — without `workorders:write`, which is a different
 * right from the `projects:read` that opens this page and the `projects:write`
 * that unlocks it. The API enforces it either way; what a rendered-and-refused
 * button would add is a promise this screen cannot keep.
 *
 * A card offers the link only while its repository is one steering can
 * actually reach: `useSteeringScopes` builds its options from
 * `observeEnabled=true&retired=false`, steering's own definition of
 * registered, so a link from a retired or unobserved repository would open the
 * picker on nothing chosen and look like the selection had been dropped.
 *
 * ## One dialog of each kind, mounted by this panel
 *
 * The stand-down dialog asks how many work orders a repository has before it
 * decides whether de-registering is offered. Mounting one per card would ask
 * that question once per row on every open; mounting one here asks it once,
 * for the row the operator actually chose.
 */

import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Skeleton,
  Stack,
  Typography,
} from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import ForumIcon from '@mui/icons-material/Forum';

import { AddRepositoryDialog } from './AddRepositoryDialog';
import { MoveRepositoryDialog } from './MoveRepositoryDialog';
import { RepositoryLadderCard } from './RepositoryLadderCard';
import { RetireRepositoryDialog } from './RetireRepositoryDialog';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { LADDER_RUNGS } from '../../config/repositoryLadder';
import {
  steerProjectHref,
  steerRepositoryHref,
} from '../../config/steeringLink';
import { useRepositoryLadder } from '../../hooks/useRepositoryLadder';
import {
  assignRepositoryToProject,
  unassignRepositoryFromProject,
} from '../../services/api';
import type { RegisteredRepository } from '../../services/api';
import type { RepositorySummary } from '../../types/cockpit';
import type { Project, ProjectScope } from '../../types/projects';

export interface ProjectRepositoriesPanelProps {
  scope: ProjectScope;
  /**
   * The selected project, or null.
   *
   * Null for the unassigned bucket, and ALSO null for a project whose row has
   * not arrived — the id lives in the URL and the name lives in the list, so a
   * reload onto `/projects?project=<uuid>` knows which project before it knows
   * what it is called. `isProjectLoading` tells the two apart.
   */
  project: Project | null;
  /** The projects list is still being read, so a missing row is not an answer. */
  isProjectLoading?: boolean;
  /** `projects:write` — the string `RepositoriesController` enforces. */
  canWrite: boolean;
  /**
   * `workorders:write` — what `SteeringController` enforces.
   *
   * Defaults to FALSE so a caller that does not ask the question offers
   * nothing. Every steering link on this screen is withheld when it is false;
   * see the header for why absent rather than disabled.
   */
  canSteer?: boolean;
  onEditProject: () => void;
  onDeleteProject: () => void;
  /**
   * A repository entered or left a project. `delta` is applied to that
   * project's `repositoryCount` in the list beside this panel, so the badge
   * does not need a re-read of the whole project list to stay true.
   */
  onRepositoryCountChanged: (projectId: string, delta: number) => void;
}

export function ProjectRepositoriesPanel({
  scope,
  project,
  isProjectLoading = false,
  canWrite,
  canSteer = false,
  onEditProject,
  onDeleteProject,
  onRepositoryCountChanged,
}: ProjectRepositoriesPanelProps) {
  const {
    repositories,
    total,
    isLoading,
    error,
    savingId,
    probingId,
    probes,
    labelReports,
    labelErrors,
    checkingLabelsId,
    repairingLabelsId,
    checkLabels,
    repairLabels,
    save,
    testAccess,
    retire,
    unretire,
    remove,
    evict,
    adopt,
  } = useRepositoryLadder(scope);

  // Each dialog is mounted only while it is open, so its request happens when
  // the operator asks for it rather than on every render of this panel.
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [retiring, setRetiring] = useState<RepositorySummary | null>(null);
  const [moving, setMoving] = useState<RepositorySummary | null>(null);
  /** The registration a picker row pointed at. Highlighted, never scrolled to
   * blindly. */
  const [revealedId, setRevealedId] = useState<string | null>(null);

  const projectId = scope.kind === 'project' ? scope.id : null;

  const showRegistered = (repositoryId: string) => {
    setIsPickerOpen(false);
    setRevealedId(repositoryId);
    // Optional-called: jsdom does not implement `scrollIntoView`, and the
    // highlight is what actually carries the meaning. The card is already
    // mounted behind the dialog, so there is nothing to wait for.
    document
      .getElementById(`repository-${repositoryId}`)
      ?.scrollIntoView?.({ block: 'center' });
  };

  const handleRegistered = (repository: RegisteredRepository) => {
    // `adopt` also takes in the label report the registration returned, so a
    // new row arrives with an observation already taken (#415) rather than
    // asking for a check of something checked a second ago.
    adopt(repository);
    if (projectId !== null) onRepositoryCountChanged(projectId, 1);
  };

  /**
   * Move one repository, then take it out of this list.
   *
   * Assign and unassign are two different endpoints rather than one PATCH,
   * because `DELETE /projects/:id/repositories/:repositoryId` asserts the
   * repository is in THIS project — a stale screen cannot unassign it from
   * wherever it was really moved to.
   */
  const moveRepository = async (
    repository: RepositorySummary,
    destination: string | null,
  ) => {
    if (destination !== null) {
      await assignRepositoryToProject(destination, repository.id);
      onRepositoryCountChanged(destination, 1);
    } else if (repository.projectId !== null) {
      await unassignRepositoryFromProject(repository.projectId, repository.id);
    }
    if (repository.projectId !== null) {
      onRepositoryCountChanged(repository.projectId, -1);
    }
    // It has left this scope, so it leaves this list. Nothing was deleted.
    evict(repository.id);
  };

  const handleRemoved = (repository: RepositorySummary) => {
    if (repository.projectId !== null) {
      onRepositoryCountChanged(repository.projectId, -1);
    }
  };

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

  const body = isLoading ? (
    <LoadingSpinner />
  ) : error !== null ? (
    <Alert severity="error">
      {error} Reading the repository list needs <code>projects:read</code>.
    </Alert>
  ) : repositories.length === 0 ? (
    <Box>
      <Alert severity="info" sx={{ mb: 2 }}>
        {scope.kind === 'unassigned'
          ? 'No repository is outside a project. Everything registered is filed somewhere — or nothing is registered yet.'
          : 'No repository is in this project yet. Adding one here registers it straight into the project; an existing repository can be moved in from wherever it is now.'}{' '}
        Opifex only observes repositories it has been told about, and
        registration verifies the repository is reachable with the configured
        token before accepting it.
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
          Showing {repositories.length} of {total} repositories here. The list
          endpoint caps a page at 100.
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
            labels={labelReports[repository.id]}
            labelsError={labelErrors[repository.id] ?? null}
            isCheckingLabels={checkingLabelsId === repository.id}
            isRepairingLabels={repairingLabelsId === repository.id}
            onCheckLabels={() => void checkLabels(repository.id)}
            onRepairLabels={() => void repairLabels(repository.id)}
            isRevealed={revealedId === repository.id}
            steerHref={
              // Only what steering can actually reach — see the header.
              canSteer &&
              repository.observeEnabled &&
              repository.retiredAt === null
                ? steerRepositoryHref(repository.fullName)
                : undefined
            }
            onRemove={() => setRetiring(repository)}
            onUnretire={() => unretire(repository.id)}
            onMove={() => setMoving(repository)}
          />
        ))}
      </Stack>
    </Box>
  );

  return (
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <ScopeHeader
        scope={scope}
        project={project}
        isProjectLoading={isProjectLoading}
        canWrite={canWrite}
        canSteer={canSteer}
        onEditProject={onEditProject}
        onDeleteProject={onDeleteProject}
      />

      {body}

      {isPickerOpen && (
        <AddRepositoryDialog
          canWrite={canWrite}
          projectId={projectId ?? undefined}
          projectName={project?.name}
          onClose={() => setIsPickerOpen(false)}
          onRegistered={handleRegistered}
          onShowRegistered={showRegistered}
        />
      )}

      {retiring !== null && (
        <RetireRepositoryDialog
          repository={retiring}
          canWrite={canWrite}
          onClose={() => setRetiring(null)}
          onRetire={(reason) => retire(retiring.id, reason)}
          onDeregister={async () => {
            await remove(retiring.id);
            handleRemoved(retiring);
          }}
        />
      )}

      {moving !== null && (
        <MoveRepositoryDialog
          repository={moving}
          canWrite={canWrite}
          onClose={() => setMoving(null)}
          onMove={(destination) => moveRepository(moving, destination)}
        />
      )}
    </Box>
  );
}

/**
 * Which group is open, what may be done to it, and where it may be steered.
 *
 * The unassigned header explains rather than apologises. `projectId: null` is
 * not a broken state and the sentence says so, because an operator who reads
 * it as "these need filing" would file them for no reason.
 *
 * A project scope whose row has not arrived is NOT rendered as the unassigned
 * bucket. That was harmless while the selection was local state — nothing
 * could be selected that had not been clicked — and became a lie the moment
 * the selection moved into the URL (#461): a reload onto
 * `/projects?project=<uuid>` knows the id before it knows the name, and a
 * heading reading "Unassigned" over that project's repositories would be
 * wrong about the one thing this header exists to say.
 */
function ScopeHeader({
  scope,
  project,
  isProjectLoading,
  canWrite,
  canSteer,
  onEditProject,
  onDeleteProject,
}: {
  scope: ProjectScope;
  project: Project | null;
  isProjectLoading: boolean;
  canWrite: boolean;
  canSteer: boolean;
  onEditProject: () => void;
  onDeleteProject: () => void;
}) {
  if (scope.kind === 'unassigned') {
    return (
      <Box sx={{ mb: 2 }}>
        <Typography variant="h5" component="h2">
          Unassigned
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Repositories in no project. This is a first-class state, not a
          backlog: they are observed, dispatchable and walked up the ladder
          exactly like any other. Every repository registered before projects
          existed is here, and none of them has to be filed anywhere to be used.
        </Typography>
      </Box>
    );
  }

  // The id is known and the row is not, yet. A skeleton rather than a guess.
  if (project === null && isProjectLoading) {
    return (
      <Box sx={{ mb: 2 }}>
        <Skeleton variant="text" width={240} height={40} />
      </Box>
    );
  }

  // The row is not coming: the project is on another page of the list, hidden
  // by the search, or gone. Said plainly, because the repositories below are
  // whatever the API returned for this id and the operator is entitled to know
  // the heading could not be filled in.
  if (project === null) {
    return (
      <Box sx={{ mb: 2 }}>
        <Typography variant="h5" component="h2">
          Project
        </Typography>
        <Typography variant="body2" color="text.secondary">
          This project is not in the list beside the panel — it may be on
          another page of it, filtered out by the search, or no longer exist.
          The repositories below are whatever the API returned for it.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ mb: 2 }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        sx={{
          alignItems: { sm: 'center' },
          justifyContent: 'space-between',
          mb: 0.5,
        }}
      >
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography variant="h5" component="h2">
            {project.name}
          </Typography>
          <Chip size="small" variant="outlined" label={project.slug} />
        </Stack>
        <Stack direction="row" spacing={1}>
          {/* The whole project, scoped. Absent without `workorders:write`. */}
          {canSteer && (
            <Button
              size="small"
              startIcon={<ForumIcon />}
              component={RouterLink}
              to={steerProjectHref(project.id)}
            >
              Steer this project
            </Button>
          )}
          {canWrite && (
            <>
              <Button size="small" onClick={onEditProject}>
                Edit
              </Button>
              <Button size="small" color="error" onClick={onDeleteProject}>
                Delete project
              </Button>
            </>
          )}
        </Stack>
      </Stack>
      {project.description !== null && (
        <Typography variant="body2" color="text.secondary">
          {project.description}
        </Typography>
      )}
    </Box>
  );
}

/**
 * The ladder said once, at the top, in its own order.
 *
 * Built from `LADDER_RUNGS` rather than typed out, so a rung added or
 * reordered cannot leave this sentence describing the previous design.
 */
export function ladderSentence(): string {
  const names = LADDER_RUNGS.map((rung) => rung.title.toLowerCase()).join(
    ', then ',
  );
  return (
    `Each repository is enabled in stages — ${names} — because the ` +
    'observation week has to end one repository at a time, and reading, ' +
    'writing a label and running are three different permissions to grant.'
  );
}

export default ProjectRepositoriesPanel;
