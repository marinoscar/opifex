/**
 * `/projects` — the destination that MANAGES repositories (#406, epic #403).
 *
 * The operator's objection, in their words: *"repository selection should not
 * be a configuration, should be a main feature like projects, make sure is
 * part of the main menu."* Until this page, the Projects menu item opened a
 * read-only table whose own subtitle said the Control Center was where the
 * permissions it displayed were changed — the one main-menu entry named after
 * repositories deferring to a settings screen. This is that screen.
 *
 * ## Two panes, and unassigned is one of the choices
 *
 * The list on the left is the projects plus the unassigned bucket; the panel
 * on the right manages whatever is selected. Unassigned is the FIRST row and
 * the default selection, because every repository registered before #404 has
 * `projectId: null` — on any existing deployment it is where all of them are,
 * and a screen that hid them until they were filed somewhere would strand
 * every registration this application has ever made.
 *
 * On a phone the two panes stack, list above panel, which is the reading order
 * anyway: choose a group, then work in it.
 *
 * ## Permissions
 *
 * `projects:read` reaches the page — the string `RepositoriesController` and
 * `ProjectsController` both enforce, declared once in `config/destinations.ts`
 * and asserted on the route in `App.tsx`. `projects:write` unlocks every
 * action: creating and editing projects, adding, retiring, de-registering,
 * moving, and the ladder switches. Without it the page is a working read-only
 * view rather than a disabled one, and the API refuses the writes regardless
 * of what is on screen.
 *
 * ## Which group is open lives in the URL (#461)
 *
 * `/projects?project=<uuid>`, or a bare `/projects` for the unassigned bucket.
 * It used to be `useState` here, which meant the selection did not survive a
 * reload, could not be linked to, and could not be handed to another screen —
 * and handing it to `/steering` is exactly what this page now has to do. The
 * parameter takes the same values `GET /repositories?projectId=` takes, so
 * there is no third spelling of "unassigned" between the address bar, the
 * screen and the request.
 *
 * The alternative was a `/projects/:id` route. It was rejected because the
 * unassigned bucket has no id: the route would have needed a sentinel segment
 * for the one selection every deployment lands on, and `?project=none` already
 * has a meaning here that the API itself defines. A query parameter also keeps
 * `/projects` as the single owned prefix in `config/destinations.ts`, so the
 * rail highlights the same row whatever is selected.
 *
 * ## The project row and the repository panel share one truth about counts
 *
 * A repository moving in or out changes a project's `repositoryCount`, and the
 * panel tells the list so rather than the list re-reading everything. The
 * alternative — a full project re-read per assignment — would spend a request
 * to learn a number the write already implied.
 */

import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Container,
  Stack,
  Typography,
} from '@mui/material';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import TuneIcon from '@mui/icons-material/Tune';

import { DeleteProjectDialog } from '../components/projects/DeleteProjectDialog';
import { ProjectFormDialog } from '../components/projects/ProjectFormDialog';
import { ProjectList } from '../components/projects/ProjectList';
import { ProjectRepositoriesPanel } from '../components/projects/ProjectRepositoriesPanel';
import { STEERING_PERMISSION } from '../config/steeringLink';
import { usePermissions } from '../hooks/usePermissions';
import { useProjects } from '../hooks/useProjects';
import {
  scopeFromQueryValue,
  type Project,
  type ProjectScope,
} from '../types/projects';

/** The permission `ProjectsController` and `RepositoriesController` enforce. */
const WRITE_PERMISSION = 'projects:write';

/** What it takes to open the Control Center. */
const CONTROL_CENTER_PERMISSION = 'system_settings:read';
/**
 * The Control Center's LANDING section, not its Repositories one.
 *
 * That section is now a signpost back to this page (#406), so deep-linking to
 * it would send an operator on a round trip to be told to come back. What is
 * actually next door is the GitHub credential and the readiness chain — which
 * is where somebody whose repository will not register needs to go.
 */
const CONTROL_CENTER_PATH = '/admin/settings';

/**
 * The query parameter carrying which group is open. See the header.
 *
 * Absent, or `none`, is the unassigned bucket. Anything else is a project id.
 */
const PROJECT_PARAM = 'project';

export default function ProjectsPage() {
  const { hasPermission } = usePermissions();
  const canWrite = hasPermission(WRITE_PERMISSION);
  // `workorders:write`, read off the destination registry — NOT `projects:read`
  // and not `projects:write`. Steering is a different right from managing
  // repositories, and an account can legitimately reach this page holding
  // neither. Where it is false the steering entry points are not rendered at
  // all: a disabled button, or one that 403s when pressed, would advertise a
  // capability this account does not have.
  const canSteer = hasPermission(STEERING_PERMISSION);
  const projectsResult = useProjects();
  const {
    projects,
    isLoading,
    error,
    page,
    totalPages,
    search,
    goToPage,
    applySearch,
    create,
    update,
    remove,
    adjustRepositoryCount,
  } = projectsResult;

  const [searchParams, setSearchParams] = useSearchParams();
  const scope = scopeFromQueryValue(searchParams.get(PROJECT_PARAM));

  const [searchDraft, setSearchDraft] = useState(search);
  /** Open with a project to edit it, with null to create one, closed when undefined. */
  const [form, setForm] = useState<{ project: Project | null } | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);

  // The URL says WHICH project; the list is where its name and slug come from.
  // The last row seen for the open id is kept so a search that filters that row
  // out of the list beside the panel does not blank the header over it — and
  // it is dropped the moment the open id changes, so a name never outlives the
  // selection it described. This is a cache of a loaded row, not a second
  // record of the selection: nothing outside this page reads it.
  const [named, setNamed] = useState<Project | null>(null);
  const openProjectId = scope.kind === 'project' ? scope.id : null;
  const loaded =
    openProjectId === null
      ? null
      : (projects.find((candidate) => candidate.id === openProjectId) ?? null);
  const selectedProject =
    loaded ?? (named !== null && named.id === openProjectId ? named : null);
  // Identity, not deep equality: `useProjects` replaces the row object on every
  // read and on every update, so a changed object IS a changed row, and a
  // rename reaches the header without an effect that would paint the stale
  // name for a frame first.
  if (selectedProject !== named) {
    setNamed(selectedProject);
  }

  const select = (next: ProjectScope) => {
    setSearchParams((previous) => {
      const params = new URLSearchParams(previous);
      // Cleared rather than written as `none`: a bare `/projects` is the
      // canonical unassigned view and the address the rail already points at.
      if (next.kind === 'unassigned') params.delete(PROJECT_PARAM);
      else params.set(PROJECT_PARAM, next.id);
      return params;
    });
  };

  return (
    <Container maxWidth="xl">
      <Box sx={{ py: 2 }}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          sx={{
            mb: 3,
            alignItems: { xs: 'flex-start', sm: 'center' },
            justifyContent: 'space-between',
          }}
        >
          <Box>
            <Typography variant="h4" component="h1" gutterBottom>
              Projects
            </Typography>
            <Typography color="text.secondary">
              Repositories are added, enabled and retired here. A project is a
              grouping; a repository does not need one to be used.
            </Typography>
          </Box>
          {hasPermission(CONTROL_CENTER_PERMISSION) && (
            <Button
              size="small"
              startIcon={<TuneIcon />}
              component={RouterLink}
              to={CONTROL_CENTER_PATH}
            >
              Control Center
            </Button>
          )}
        </Stack>

        {!canWrite && (
          <Alert severity="info" variant="outlined" sx={{ mb: 2 }}>
            This account holds <code>projects:read</code> and not{' '}
            <code>{WRITE_PERMISSION}</code>, so everything here is readable and
            nothing can be changed. The API enforces that regardless of what
            this screen shows.
          </Alert>
        )}

        <Stack direction={{ xs: 'column', md: 'row' }} spacing={3}>
          <ProjectList
            projects={projects}
            isLoading={isLoading}
            error={error}
            page={page}
            totalPages={totalPages}
            searchDraft={searchDraft}
            onSearchDraftChange={setSearchDraft}
            onApplySearch={() => applySearch(searchDraft)}
            onGoToPage={goToPage}
            selected={scope}
            onSelect={select}
            canWrite={canWrite}
            onCreate={() => setForm({ project: null })}
          />

          <ProjectRepositoriesPanel
            // Remounts on a scope change, so no draft switch position or probe
            // result from one group can survive into another.
            key={scope.kind === 'unassigned' ? 'unassigned' : scope.id}
            scope={scope}
            project={selectedProject}
            isProjectLoading={loaded === null && isLoading}
            canWrite={canWrite}
            canSteer={canSteer}
            onEditProject={() =>
              selectedProject !== null && setForm({ project: selectedProject })
            }
            onDeleteProject={() =>
              selectedProject !== null && setDeleting(selectedProject)
            }
            onRepositoryCountChanged={adjustRepositoryCount}
          />
        </Stack>
      </Box>

      {form !== null && (
        <ProjectFormDialog
          project={form.project}
          onClose={() => setForm(null)}
          onSubmit={async (input) => {
            if (form.project === null) {
              const created = await create(input);
              // Open what was just made. Creating a project and being left on
              // the previous selection would make the operator hunt for it.
              select({ kind: 'project', id: created.id });
            } else {
              // No navigation: the id has not changed, and the renamed row
              // arrives through the list the header reads its name from.
              await update(form.project.id, input);
            }
          }}
        />
      )}

      {deleting !== null && (
        <DeleteProjectDialog
          project={deleting}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await remove(deleting.id);
            // Its repositories are now unassigned, which is exactly where the
            // operator should be looking — and the project they were in no
            // longer exists to be selected.
            select({ kind: 'unassigned' });
          }}
        />
      )}
    </Container>
  );
}
