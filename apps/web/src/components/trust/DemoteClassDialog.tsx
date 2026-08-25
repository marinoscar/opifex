/**
 * The confirm step in front of a manual demotion (#101, VISION §7).
 *
 * Deliberately a sibling of `RevokeGrantDialog` rather than a shared "confirm
 * with a note" component: the two acts have different consequences and the
 * dialog's whole job is to state them. Revoking ends ONE grant permanently;
 * demoting takes a CLASS off the promoted rung, suspends every grant it
 * authorized — and holds the rung for a STATED TERM rather than forever.
 *
 * That term is stated BEFORE the tap, not only after it (#244). The response
 * carries `manualHoldUntil` and the outcome banner shows the exact instant,
 * but an operator told only afterwards has already formed a belief about how
 * long their judgement lasts that the banner then has to correct — and the
 * whole point of a hold with an expiry is that nobody is surprised by it.
 *
 * The number of days is a PROP, read from the API's `thresholds`, and is never
 * written down in this file. A client-side `14` is how a dialog ends up
 * promising a term the API stopped honouring.
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
  /**
   * `PromotionThresholds.manualHoldDays`, straight from the response.
   *
   * Required rather than defaulted: a default would be a second copy of the
   * policy living in this app, silently correct until the day it was not.
   */
  manualHoldDays: number;
  isDemoting: boolean;
  onCancel: () => void;
  onConfirm: (note?: string) => void;
}

export function DemoteClassDialog({
  open,
  className,
  manualHoldDays,
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
        <DialogContentText sx={{ mb: 2 }} data-testid="demote-hold-term">
          The rung is held for {manualHoldDays} days. The ladder may not promote
          this class back before then, however its record reads — and after that
          it is judged again on the numbers, measured over a window that no
          longer contains what you are reacting to now.
        </DialogContentText>
        <DialogContentText sx={{ mb: 2 }}>
          Nothing lifts the hold early, and there is no control that does.
          Restoring autonomy sooner means granting trust again, which a class
          off the promoted rung can still hold.
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
