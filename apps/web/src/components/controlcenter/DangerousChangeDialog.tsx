/**
 * The one confirmation a `dangerous` operator setting goes through (#381).
 *
 * ## Shared, because two screens were answering the question differently
 *
 * #349 built this dialog inside the spend ceilings panel: it states what moves
 * — raise or lower, shorter or longer window — beside the spend against that
 * window, and links ADR-0018 rather than paraphrasing it. #348's Configuration
 * section rendered the same four keys with no confirmation at all, because it
 * renders whatever the registry publishes and the registry's `dangerous` flag
 * only drew a chip.
 *
 * The fix keeps the generic rendering promise and moves the dialog out here,
 * so a key marked `dangerous` in the backend registry is gated on both screens
 * with no per-key frontend code. What each screen supplies is the DESCRIPTION
 * (`config/dangerousChanges.ts`), not the gate.
 *
 * ## "Are you sure" is not a question anyone has answered no to
 *
 * So this dialog never asks it. Every row states the field, the value it holds
 * now, the value it would hold, and what that does; the footer states that the
 * write is stored, audited against this account, and why a figure that used to
 * require host access is editable at all. A screen that knows something the
 * change list cannot model — the current spend against a ceiling's window, or
 * that such a figure exists on another tab — passes it as children, which is
 * the generalisation #381 asked for.
 */

import type { ReactNode } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  Link,
} from '@mui/material';

import { CEILING_ADR } from '../../config/spendCeilings';
import type { DangerousChange } from '../../config/dangerousChanges';

export interface DangerousChangeDialogProps {
  open: boolean;
  /** Names what is about to change, in the operator's words. */
  title: string;
  changes: readonly DangerousChange[];
  /** The affirmative action, saying what it does rather than "OK". */
  confirmLabel: string;
  /** Defaults to "Go back" — the way out, never the default action. */
  cancelLabel?: string;
  /** Anything the calling screen knows that a change list cannot carry. */
  children?: ReactNode;
  disabled?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DangerousChangeDialog({
  open,
  title,
  changes,
  confirmLabel,
  cancelLabel = 'Go back',
  children,
  disabled = false,
  onCancel,
  onConfirm,
}: DangerousChangeDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      aria-labelledby="confirm-dangerous-change"
      fullWidth
      maxWidth="sm"
    >
      <DialogTitle id="confirm-dangerous-change">{title}</DialogTitle>
      <DialogContent>
        {changes.length === 0 ? (
          // Defensive, and deliberately not silent: an empty dialog would be
          // a confirmation of nothing, which is worse than no confirmation.
          <DialogContentText variant="body2">
            Nothing was described for this change, which is a bug in this
            screen. Go back and check what is on it before saving.
          </DialogContentText>
        ) : (
          changes.map((change) => (
            <Box key={change.key} sx={{ mb: 2 }}>
              <DialogContentText sx={{ fontFamily: 'monospace' }}>
                {change.label}: {change.from} → {change.to}
              </DialogContentText>
              <DialogContentText variant="body2">
                {change.consequence}
              </DialogContentText>
              {change.takesEffect && (
                <DialogContentText variant="caption" component="p">
                  When it takes effect: {change.takesEffect}
                </DialogContentText>
              )}
            </Box>
          ))
        )}

        {children}

        <Divider sx={{ my: 1 }} />
        <DialogContentText variant="body2">
          This is written to the database and is recorded in{' '}
          <code>audit_events</code> against this account. See{' '}
          <Link href={CEILING_ADR.url} target="_blank" rel="noreferrer">
            {CEILING_ADR.id}
          </Link>{' '}
          for why a value that used to require host access is editable here, and
          what that rests on.
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>{cancelLabel}</Button>
        <Button
          variant="contained"
          color="warning"
          disabled={disabled}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default DangerousChangeDialog;
