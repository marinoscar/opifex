/**
 * Choosing which group of repositories to manage (#406, epic #403).
 *
 * ## Unassigned is the first row and is never hidden
 *
 * Every repository registered before #404 has `projectId: null`, so on any
 * existing deployment this row is where ALL of them are. A screen that offered
 * projects only — or that put unassigned behind a filter — would strand every
 * registration made before projects existed. It is listed first, always
 * present, and selectable whether or not a single project exists.
 *
 * The count beside it is deliberately absent rather than guessed: the project
 * rows carry `repositoryCount` from the API, and there is no equivalent field
 * for the unassigned bucket. Rendering a number this build did not receive —
 * or spending a request per render to compute one — would be worse than
 * letting the panel say how many once the bucket is opened.
 *
 * ## Selection is a prop, not state
 *
 * The page owns which scope is selected, because the repository panel beside
 * this list reads from the same value. Two owners would be two ideas of where
 * the operator is.
 */

import {
  Box,
  Button,
  Chip,
  Divider,
  LinearProgress,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import FolderOffIcon from '@mui/icons-material/FolderOff';

import type { Project, ProjectScope } from '../../types/projects';

export interface ProjectListProps {
  projects: Project[];
  isLoading: boolean;
  /** Why the list could not be read, if it could not. */
  error: string | null;
  page: number;
  totalPages: number;
  /** The search being typed. Owned by the page so it survives a re-render. */
  searchDraft: string;
  onSearchDraftChange: (value: string) => void;
  /** Send the typed search to the API — it filters every page, not this one. */
  onApplySearch: () => void;
  onGoToPage: (page: number) => void;
  selected: ProjectScope;
  onSelect: (scope: ProjectScope) => void;
  /** `projects:write`. Without it the New project button is not offered. */
  canWrite: boolean;
  onCreate: () => void;
}

export function ProjectList({
  projects,
  isLoading,
  error,
  page,
  totalPages,
  searchDraft,
  onSearchDraftChange,
  onApplySearch,
  onGoToPage,
  selected,
  onSelect,
  canWrite,
  onCreate,
}: ProjectListProps) {
  return (
    <Paper
      variant="outlined"
      sx={{ p: 2, width: { md: 320 }, flexShrink: 0, alignSelf: 'flex-start' }}
      component="nav"
      aria-label="Projects"
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1 }}
      >
        <Typography variant="subtitle1" component="h2">
          Projects
        </Typography>
        {canWrite && (
          <Button size="small" variant="contained" onClick={onCreate}>
            New project
          </Button>
        )}
      </Stack>

      <Box
        component="form"
        onSubmit={(event) => {
          event.preventDefault();
          onApplySearch();
        }}
        sx={{ mb: 1 }}
      >
        <TextField
          fullWidth
          size="small"
          label="Search projects"
          value={searchDraft}
          onChange={(event) => onSearchDraftChange(event.target.value)}
          helperText="Matched by the API over every project's name and slug, not just this page."
        />
      </Box>

      {isLoading && <LinearProgress aria-label="Loading projects" />}

      <List disablePadding>
        <ListItem disablePadding>
          <ListItemButton
            selected={selected.kind === 'unassigned'}
            onClick={() => onSelect({ kind: 'unassigned' })}
          >
            <ListItemText
              primary={
                <Stack
                  direction="row"
                  spacing={1}
                  sx={{ alignItems: 'center' }}
                >
                  <FolderOffIcon fontSize="small" color="action" />
                  <span>Unassigned</span>
                </Stack>
              }
              secondary="Repositories in no project. A normal place to be."
            />
          </ListItemButton>
        </ListItem>

        <Divider sx={{ my: 1 }} />

        {projects.map((project) => (
          <ListItem key={project.id} disablePadding>
            <ListItemButton
              selected={
                selected.kind === 'project' && selected.id === project.id
              }
              onClick={() => onSelect({ kind: 'project', id: project.id })}
            >
              <ListItemText
                primary={
                  <Stack
                    direction="row"
                    spacing={1}
                    sx={{
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <Typography variant="body2" noWrap sx={{ minWidth: 0 }}>
                      {project.name}
                    </Typography>
                    {/* A Chip rather than a Badge: a Badge with no children
                        positions itself against an empty root, and the count
                        has to be legible in its own right here. */}
                    <Chip
                      size="small"
                      label={project.repositoryCount}
                      aria-label={`${project.repositoryCount} repositories`}
                    />
                  </Stack>
                }
                secondary={
                  <Chip
                    size="small"
                    variant="outlined"
                    label={project.slug}
                    component="span"
                  />
                }
                slotProps={{ secondary: { component: 'span' } }}
              />
            </ListItemButton>
          </ListItem>
        ))}
      </List>

      {error !== null && (
        <Typography variant="body2" color="error" sx={{ mt: 1 }}>
          {error}
        </Typography>
      )}

      {!isLoading && error === null && projects.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          No project yet. Repositories do not need one — everything registered
          so far lives in Unassigned above.
        </Typography>
      )}

      {totalPages > 1 && (
        <Stack
          direction="row"
          spacing={1}
          sx={{ mt: 1, alignItems: 'center', justifyContent: 'center' }}
        >
          <Button
            size="small"
            disabled={isLoading || page <= 1}
            onClick={() => onGoToPage(page - 1)}
          >
            Previous
          </Button>
          <Typography variant="caption" color="text.secondary">
            Page {page} of {totalPages}
          </Typography>
          <Button
            size="small"
            disabled={isLoading || page >= totalPages}
            onClick={() => onGoToPage(page + 1)}
          >
            Next
          </Button>
        </Stack>
      )}
    </Paper>
  );
}

export default ProjectList;
