/**
 * The confirm step in front of a manual demotion (#101, VISION §7).
 *
 * Deliberately a sibling of `RevokeGrantDialog` rather than a shared "confirm
 * with a note" component: the two acts have different consequences and the
 * dialog's whole job is to state them. Revoking ends ONE grant permanently;
 * demoting takes a CLASS off the promoted rung, suspends every grant it
 * authorized — and may be undone by the ladder itself within the hour.
 *
 * That last part is stated BEFORE the tap, not only after it. The response
 * carries `rungMayBeRestoredByLadder` and the outcome banner surfaces it, but
 * an operator who is told only afterwards has already formed the belief the
 * banner then has to correct.
 */

import { useEffect, useState } from 'react';
import {
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  TextField,
} from '@mui/material';

/** The API's own ceiling on the note (`demoteClassSchema`). */
export const NOTE_MAX_LENGTH = 2000;

export interface DemoteClassDialogProps {
  open: boolean;
  /** The class, in words: its registry title, falling back to its id. */
  className: string;
  isDemoting: boolean;
  onCancel: () => void;
  onConfirm: (note?: string) => void;
}

export function DemoteClassDialog({
  open,
  className,
  isDemoting,
  onCancel,
  onConfirm,
}: DemoteClassDialogProps) {
  const [note, setNote] = useState('');

  useEffect(() => {
    if (open) setNote('');
  }, [open]);

  const trimmed = note.trim();

  return (
    <Dialog
      open={open}
      onClose={isDemoting ? undefined : onCancel}
      fullWidth
      maxWidth="sm"
      aria-labelledby="demote-class-title"
    >
      <DialogTitle id="demote-class-title">
        Demote {className} off the promoted rung?
      </DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>
          Every active trust grant for this class is suspended, and nothing
          re-creates a suspended grant — only a person granting trust again.
          That part is durable.
        </DialogContentText>
        <DialogContentText sx={{ mb: 2 }}>
          The RUNG is not. If this class&rsquo;s record still clears the bar,
          the next hourly evaluation will put it back on the promoted rung. The
          suspended grants stay suspended either way, so nothing resumes
          running.
        </DialogContentText>
        <TextField
          fullWidth
          multiline
          minRows={2}
          size="small"
          label="Why (optional)"
          value={note}
          onChange={(event) =>
            setNote(event.target.value.slice(0, NOTE_MAX_LENGTH))
          }
          slotProps={{ htmlInput: { maxLength: NOTE_MAX_LENGTH } }}
          helperText="Appended to the change detail — the only record that this demotion was a person's and not the ladder's."
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={isDemoting}>
          Cancel
        </Button>
        <Button
          variant="contained"
          color="error"
          disabled={isDemoting}
          startIcon={
            isDemoting ? (
              <CircularProgress size={16} color="inherit" />
            ) : undefined
          }
          onClick={() => onConfirm(trimmed ? trimmed : undefined)}
        >
          Demote
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default DemoteClassDialog;
