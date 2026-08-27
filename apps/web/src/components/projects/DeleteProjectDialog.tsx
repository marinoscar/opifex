/**
 * Deleting a project, and saying what that does NOT do (#404, epic #403).
 *
 * The one fact worth stating loudest is the non-cascade: the repositories in
 * the project are not deleted with it, they become unassigned — still
 * registered, still observed, still dispatchable, which is the state every
 * repository was in before projects existed. So the confirmation names the
 * count from the project row before the request, and reports the count the API
 * returned after it.
 *
 * That is the opposite of `DELETE /api/repositories/:id`, which IS refused
 * while there is anything to lose. A project owns no work orders, no runs and
 * no events, so nothing in the provenance graph depends on it and there is
 * nothing here to refuse for.
 */

import { useState } from 'react';
import {
  Alert,
  AlertTitle,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from '@mui/material';

import type { Project } from '../../types/projects';

export interface DeleteProjectDialogProps {
  project: Project;
  onClose: () => void;
  /** Rejects with the API's own refusal, which this dialog renders. */
  onConfirm: () => Promise<void>;
}

export function DeleteProjectDialog({
  project,
  onClose,
  onConfirm,
}: DeleteProjectDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setError(null);
    setIsDeleting(true);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'The API refused the deletion.',
      );
      setIsDeleting(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      aria-labelledby="delete-project-title"
    >
      <DialogTitle id="delete-project-title">
        Delete {project.name}?
      </DialogTitle>
      <DialogContent dividers>
        <DialogContentText>
          The project is a grouping. Deleting it removes the label and nothing
          else.
        </DialogContentText>
        <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
          <AlertTitle>
            {project.repositoryCount}{' '}
            {project.repositoryCount === 1 ? 'repository' : 'repositories'} will
            become unassigned
          </AlertTitle>
          They are not deleted. They stay registered, keep every rung they have,
          keep their work orders and runs, and appear under Unassigned — where
          they can be enabled and managed exactly as they are now.
        </Alert>
        {error !== null && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={isDeleting}>
          Cancel
        </Button>
        <Button
          color="error"
          variant="contained"
          onClick={() => void confirm()}
          disabled={isDeleting}
        >
          Delete project
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default DeleteProjectDialog;
