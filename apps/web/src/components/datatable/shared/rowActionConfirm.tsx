/**
 * DataTable — shared row-action confirmation.
 *
 * Extracted from `DesktopGridRenderer` in #253 so the card renderer gets the
 * *same* confirmation behaviour rather than a lookalike: identical default
 * copy, identical destructive palette, and — the important part — exactly ONE
 * dialog per table rather than one per row.
 *
 * The contract both renderers follow: a row-action control never executes an
 * action, it hands the descriptor to `run()`. `run()` either invokes it
 * immediately or parks it behind the dialog.
 */

import { useCallback, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from '@mui/material';
import type { DataTableRowAction } from '../types';

interface PendingConfirm<Row> {
  action: DataTableRowAction<Row>;
  row: Row;
}

/** Resolve the four dialog strings, filling in defaults. */
export function confirmCopy<Row>(action: DataTableRowAction<Row>, row: Row) {
  const options = typeof action.confirm === 'object' ? action.confirm : {};
  const description =
    typeof options.description === 'function' ? options.description(row) : options.description;
  return {
    title: options.title ?? `${action.label}?`,
    description:
      description ??
      (action.destructive
        ? 'This action cannot be undone.'
        : `Are you sure you want to ${action.label.toLowerCase()}?`),
    confirmLabel: options.confirmLabel ?? action.label,
    cancelLabel: options.cancelLabel ?? 'Cancel',
  };
}

export interface RowActionConfirm<Row> {
  /** Run an action, routing it through the dialog when it declares `confirm`. */
  run: (action: DataTableRowAction<Row>, row: Row) => void;
  /** The single dialog element. Render it once, anywhere in the renderer. */
  dialog: React.ReactElement;
}

export function useRowActionConfirm<Row>(): RowActionConfirm<Row> {
  const [pending, setPending] = useState<PendingConfirm<Row> | null>(null);

  const run = useCallback((action: DataTableRowAction<Row>, row: Row) => {
    if (action.confirm) {
      setPending({ action, row });
      return;
    }
    action.onClick(row);
  }, []);

  const close = useCallback(() => setPending(null), []);

  const copy = pending ? confirmCopy(pending.action, pending.row) : null;

  const dialog = (
    <Dialog open={Boolean(pending)} onClose={close} aria-labelledby="datatable-confirm-title">
      <DialogTitle id="datatable-confirm-title">{copy?.title}</DialogTitle>
      <DialogContent>
        <DialogContentText>{copy?.description}</DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>{copy?.cancelLabel}</Button>
        <Button
          variant="contained"
          color={pending?.action.destructive ? 'error' : 'primary'}
          onClick={() => {
            if (pending) pending.action.onClick(pending.row);
            close();
          }}
        >
          {copy?.confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );

  return { run, dialog };
}
