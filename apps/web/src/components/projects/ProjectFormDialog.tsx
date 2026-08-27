/**
 * Creating and renaming a project (#404, epic #403).
 *
 * One dialog for both, because the fields are the same three and the only
 * difference is which request is sent — two near-identical forms would drift.
 *
 * ## The slug is shown even when nobody typed one
 *
 * Omitting it derives one from the name, ONCE, at creation. That derivation is
 * the thing an operator is most likely to be surprised by later, so the
 * preview says what the handle will be before the request is sent. Deriving it
 * here as a PREVIEW is not the same as deciding it: the API derives the real
 * one, and if the two ever disagree the API's answer is what comes back and is
 * what the screen then shows.
 *
 * ## A taken slug is a 409, and is rendered as one
 *
 * The API refuses rather than suffixing, on the grounds that `billing-2` is a
 * handle nobody chose and nobody can predict. So the refusal has to arrive as
 * a message the operator can act on, which means the API's own — including the
 * case where the slug was derived and they never typed it, where "that slug is
 * taken" would otherwise be about a string they have never seen.
 *
 * ## Renaming leaves the slug alone
 *
 * Said on the form rather than left to be discovered, because the alternative
 * assumption — that a rename moves the handle — is the reasonable one.
 */

import { useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  Stack,
  DialogTitle,
  TextField,
  Typography,
} from '@mui/material';

import type { Project } from '../../types/projects';
import { deriveSlugPreview } from '../../config/projectSlug';

export interface ProjectFormDialogProps {
  /** The project being edited, or null to create one. */
  project: Project | null;
  onClose: () => void;
  /**
   * Rejects with the API's own refusal — 409 for a taken slug, 400 for a name
   * that derives nothing — which this dialog renders rather than swallowing.
   */
  onSubmit: (input: {
    name: string;
    slug?: string;
    description?: string | null;
  }) => Promise<void>;
}

export function ProjectFormDialog({
  project,
  onClose,
  onSubmit,
}: ProjectFormDialogProps) {
  const isEdit = project !== null;
  const [name, setName] = useState(project?.name ?? '');
  const [slug, setSlug] = useState(project?.slug ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Derived at render, never stored: a preview held in state would go stale
  // the moment the name changed and would have to be re-synced in an effect.
  const preview = deriveSlugPreview(name);
  const trimmedName = name.trim();
  const trimmedSlug = slug.trim();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setIsSaving(true);
    try {
      await onSubmit({
        name: trimmedName,
        // Omitted rather than sent empty. On create, omitting is what asks the
        // API to derive one; on edit, omitting is what leaves the handle
        // exactly where it was.
        ...(trimmedSlug === '' ? {} : { slug: trimmedSlug }),
        // `null` CLEARS the description and `''` is rejected by the API's
        // `min(1)` after trimming, so an empty box has to send null.
        description: description.trim() === '' ? null : description.trim(),
      });
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'The API refused the request.',
      );
      setIsSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      aria-labelledby="project-form-title"
    >
      <form onSubmit={(event) => void submit(event)}>
        <DialogTitle id="project-form-title">
          {isEdit ? `Edit ${project.name}` : 'New project'}
        </DialogTitle>

        <DialogContent dividers>
          <DialogContentText sx={{ mb: 2 }}>
            A project groups repositories and carries no authority of its own —
            nothing reads it to decide whether a run may happen. Deleting one
            later leaves its repositories registered and unassigned.
          </DialogContentText>

          <Stack spacing={2}>
            <TextField
              label="Name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              fullWidth
              autoFocus
              required
              disabled={isSaving}
              slotProps={{ htmlInput: { maxLength: 120 } }}
            />

            <TextField
              label="Slug"
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              fullWidth
              disabled={isSaving}
              slotProps={{ htmlInput: { maxLength: 64 } }}
              helperText={
                isEdit
                  ? 'The stable handle. Renaming the project does NOT move it — changing it here is how it moves, and everything that referenced the old one stops matching.'
                  : trimmedSlug === ''
                    ? preview === null
                      ? 'This name yields no slug, so one has to be typed here. Lower-case letters, numbers and single hyphens.'
                      : `Leave empty and the API derives “${preview}” from the name, once, at creation.`
                    : 'Lower-case letters, numbers and single hyphens.'
              }
              error={!isEdit && trimmedSlug === '' && preview === null}
            />

            <TextField
              label="Description (optional)"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              fullWidth
              multiline
              minRows={2}
              disabled={isSaving}
              slotProps={{ htmlInput: { maxLength: 2000 } }}
            />
          </Stack>

          {isEdit && (
            <Typography
              variant="caption"
              color="text.secondary"
              component="p"
              sx={{ mt: 2 }}
            >
              Current handle: <code>{project.slug}</code> ·{' '}
              {project.repositoryCount}{' '}
              {project.repositoryCount === 1 ? 'repository' : 'repositories'}
            </Typography>
          )}

          {error !== null && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {error}
            </Alert>
          )}
        </DialogContent>

        <DialogActions>
          <Button onClick={onClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="contained"
            disabled={isSaving || trimmedName === ''}
          >
            {isEdit ? 'Save' : 'Create project'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export default ProjectFormDialog;
