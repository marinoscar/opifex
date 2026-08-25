/**
 * The confirm step in front of a revocation (#101).
 *
 * ONE dialog, one button, and the same component on the list and on the detail
 * screen. #101's third criterion is that manual revocation is "available and
 * immediate"; a confirm step is fine because revocation is permanent and
 * cannot be undone, but a multi-screen flow would not be — and two different
 * revoke experiences would be worse than either.
 *
 * ## The note is optional, and the dialog opens focused on the button
 *
 * The API's schema defaults to `{}` precisely so that revoking without
 * explaining yourself is not a 400: narrowing what runs unattended is the safe
 * direction and must never be harder than granting. So the note is offered,
 * labelled as optional, and never in the way of the one tap.
 *
 * It is offered at all because it is appended to `endDetail` — the sentence
 * the next operator reads when they find the grant dead and wonder whether to
 * issue a new one.
 *
 * ## What the dialog says out loud
 *
 * That there is no undo, and that restoring trust means a NEW grant. Both are
 * facts about the API (`TrustGrantService.revoke` never reactivates), and an
 * operator who expected a pause would otherwise discover the difference only
 * when looking for the button that puts it back.
 */

import { useState } from 'react';
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

/** The API's own ceiling on the note (`revokeTrustGrantSchema`). */
export const NOTE_MAX_LENGTH = 2000;

export interface RevokeGrantDialogProps {
  open: boolean;
  /** What is being switched off, in words. Class title and repository. */
  scope: string;
  isRevoking: boolean;
  onCancel: () => void;
  onConfirm: (note?: string) => void;
}

export function RevokeGrantDialog({
  open,
  scope,
  isRevoking,
  onCancel,
  onConfirm,
}: RevokeGrantDialogProps) {
  const [note, setNote] = useState('');

  // A note typed for one grant must never travel to the next. The dialog is
  // reused across rows, so the reset has to happen on open rather than on
  // unmount. Adjusted during render rather than in an effect: an effect reset
  // the field one commit AFTER the dialog appeared, so the previous row's note
  // was on screen for a frame (react-hooks/set-state-in-effect). Keyed on the
  // false -> true edge, so re-renders while open leave typing alone.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setNote('');
  }

  const trimmed = note.trim();

  return (
    <Dialog
      open={open}
      onClose={isRevoking ? undefined : onCancel}
      fullWidth
      maxWidth="sm"
      aria-labelledby="revoke-grant-title"
    >
      <DialogTitle id="revoke-grant-title">
        Revoke this trust grant?
      </DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>
          {scope} stops running unattended immediately. There is no undo and no
          grace period: restoring trust means issuing a new grant, which
          re-attaches its own expiry, budget ceiling and auto-revoke thresholds.
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
          helperText="Appended to the grant's end reason — the sentence the next operator reads."
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={isRevoking}>
          Cancel
        </Button>
        <Button
          variant="contained"
          color="error"
          disabled={isRevoking}
          startIcon={
            isRevoking ? (
              <CircularProgress size={16} color="inherit" />
            ) : undefined
          }
          onClick={() => onConfirm(trimmed ? trimmed : undefined)}
        >
          Revoke
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default RevokeGrantDialog;
