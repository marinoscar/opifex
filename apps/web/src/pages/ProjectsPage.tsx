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
import { Link as RouterLink } from 'react-router-dom';
import TuneIcon from '@mui/icons-material/Tune';

import { DeleteProjectDialog } from '../components/projects/DeleteProjectDialog';
import { ProjectFormDialog } from '../components/projects/ProjectFormDialog';
import { ProjectList } from '../components/projects/ProjectList';
import { ProjectRepositoriesPanel } from '../components/projects/ProjectRepositoriesPanel';
import { usePermissions } from '../hooks/usePermissions';
import { useProjects } from '../hooks/useProjects';
import type { Project, ProjectScope } from '../types/projects';

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
 * Which group is open.
 *
 * A project is held as the OBJECT rather than as an id, so the header keeps
 * its name and slug when a search filters the row out of the list beside it.
 * Re-seeded during render from a freshly loaded row — the same render-time
 * reseed `RepositoryLadderCard` uses — so a rename shows up in the header
 * without an effect that would paint the stale name for a frame first.
 */
type Selection = { kind: 'unassigned' } | { kind: 'project'; project: Project };

export default function ProjectsPage() {
  const { hasPermission } = usePermissions();
  const canWrite = hasPermission(WRITE_PERMISSION);
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

  const [selection, setSelection] = useState<Selection>({ kind: 'unassigned' });
  const [searchDraft, setSearchDraft] = useState(search);
  /** Open with a project to edit it, with null to create one, closed when undefined. */
  const [form, setForm] = useState<{ project: Project | null } | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);

  // Re-seed the held project from the freshly loaded list. Identity, not deep
  // equality: `useProjects` replaces the row object on every read and on every
  // update, so a changed object IS a changed row, and an unchanged one costs
  // nothing.
  if (selection.kind === 'project') {
    const fresh = projects.find(
      (candidate) => candidate.id === selection.project.id,
    );
    if (fresh !== undefined && fresh !== selection.project) {
      setSelection({ kind: 'project', project: fresh });
    }
  }

  const scope: ProjectScope =
    selection.kind === 'unassigned'
      ? { kind: 'unassigned' }
      : { kind: 'project', id: selection.project.id };
  const selectedProject =
    selection.kind === 'project' ? selection.project : null;

  const select = (next: ProjectScope) => {
    if (next.kind === 'unassigned') {
      setSelection({ kind: 'unassigned' });
      return;
    }
    const project = projects.find((candidate) => candidate.id === next.id);
    if (project !== undefined) setSelection({ kind: 'project', project });
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
            canWrite={canWrite}
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
              setSelection({ kind: 'project', project: created });
            } else {
              const updated = await update(form.project.id, input);
              setSelection({ kind: 'project', project: updated });
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
            setSelection({ kind: 'unassigned' });
          }}
        />
      )}
    </Container>
  );
}
