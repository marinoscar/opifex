/**
 * Filing a repository into a project, or taking it back out (#404, #406).
 *
 * ## "No project" is one of the choices, listed first
 *
 * Unassigned is where every repository registered before projects existed
 * lives, and it is a destination an operator may deliberately choose — not the
 * absence of one. Rendering it as a first-class row rather than as a "clear"
 * link is the same decision the API made when it spelled the filter
 * `projectId=none` instead of adding an `unassigned` flag.
 *
 * ## The list is searched server-side
 *
 * A deployment may have more projects than one page holds, and filtering the
 * page in the browser would search 25 rows while calling itself a search over
 * the projects. `useProjects` sends the search to the API, which is the same
 * rule `useAvailableRepositories` states for the repository picker.
 *
 * ## The current project is shown and cannot be chosen
 *
 * Moving a repository to where it already is would be a no-op the API would
 * answer 200 to, which reads as a move that happened. It is marked instead.
 */

import { useState } from 'react';
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  LinearProgress,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

import { useProjects } from '../../hooks/useProjects';
import type { RepositorySummary } from '../../types/cockpit';

export interface MoveRepositoryDialogProps {
  repository: RepositorySummary;
  /** `projects:write`. Without it nothing here can be chosen. */
  canWrite: boolean;
  onClose: () => void;
  /**
   * `null` means the unassigned bucket. Rejects with the API's own refusal,
   * which this dialog renders rather than closing over.
   */
  onMove: (projectId: string | null) => Promise<void>;
}

/** Mounted only while open, so the project list is read when it is asked for. */
export function MoveRepositoryDialog({
  repository,
  canWrite,
  onClose,
  onMove,
}: MoveRepositoryDialogProps) {
  const { projects, isLoading, error, search, applySearch } = useProjects();
  const [searchDraft, setSearchDraft] = useState('');
  const [isMoving, setIsMoving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const move = async (projectId: string | null) => {
    setFailure(null);
    setIsMoving(true);
    try {
      await onMove(projectId);
      // Closed on success only: a dialog that closed on a rejection would take
      // the API's reason with it.
      onClose();
    } catch (err) {
      setFailure(
        err instanceof Error ? err.message : 'The API refused the move.',
      );
      setIsMoving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      aria-labelledby="move-repository-title"
    >
      <DialogTitle id="move-repository-title">
        Move {repository.fullName}
      </DialogTitle>

      <DialogContent dividers>
        <DialogContentText sx={{ mb: 2 }}>
          A project is a grouping and nothing more — moving a repository changes
          nothing about what it observes, what it may dispatch, or any run it
          has already had.
        </DialogContentText>

        <Stack
          component="form"
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          sx={{ mb: 2 }}
          onSubmit={(event) => {
            event.preventDefault();
            applySearch(searchDraft);
          }}
        >
          <TextField
            fullWidth
            size="small"
            label="Search projects"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
          />
          <Button type="submit" variant="outlined" disabled={isLoading}>
            Search
          </Button>
        </Stack>

        {error !== null && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        {failure !== null && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {failure}
          </Alert>
        )}

        {isLoading && <LinearProgress aria-label="Loading projects" />}

        <List aria-label="Where to move this repository">
          <ListItem divider disablePadding>
            <ListItemButton
              disabled={!canWrite || isMoving || repository.projectId === null}
              onClick={() => void move(null)}
            >
              <ListItemText
                primary={
                  <Stack
                    direction="row"
                    spacing={1}
                    sx={{ alignItems: 'center' }}
                  >
                    <span>No project</span>
                    {repository.projectId === null && (
                      <Chip size="small" label="current" variant="outlined" />
                    )}
                  </Stack>
                }
                secondary={
                  'Unassigned. Still registered, still observed, still ' +
                  'walked up the ladder — the state every repository was in ' +
                  'before projects existed.'
                }
              />
            </ListItemButton>
          </ListItem>

          {projects.map((project) => {
            const isCurrent = project.id === repository.projectId;
            return (
              <ListItem key={project.id} divider disablePadding>
                <ListItemButton
                  disabled={!canWrite || isMoving || isCurrent}
                  onClick={() => void move(project.id)}
                >
                  <ListItemText
                    primary={
                      <Stack
                        direction="row"
                        spacing={1}
                        sx={{ alignItems: 'center' }}
                      >
                        <span>{project.name}</span>
                        <Chip
                          size="small"
                          label={project.slug}
                          variant="outlined"
                        />
                        {isCurrent && (
                          <Chip
                            size="small"
                            label="current"
                            variant="outlined"
                          />
                        )}
                      </Stack>
                    }
                    secondary={
                      project.description ??
                      `${project.repositoryCount} ${
                        project.repositoryCount === 1
                          ? 'repository'
                          : 'repositories'
                      }`
                    }
                  />
                </ListItemButton>
              </ListItem>
            );
          })}
        </List>

        {!isLoading && projects.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            {search === ''
              ? 'No project exists yet. A repository can stay unassigned indefinitely.'
              : `No project matches “${search}”.`}
          </Typography>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose} disabled={isMoving}>
          Cancel
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default MoveRepositoryDialog;
