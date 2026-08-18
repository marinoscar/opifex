/**
 * Admin → Users: the "Manage roles" dialog (issue #67, epic #51).
 *
 * ## Why a dialog and not the nested menu it replaces
 *
 * `UserList` used to open a `Menu`, then a SECOND `Menu` anchored to the same
 * element, holding one checkbox per role. That shape has no card equivalent:
 * the mobile renderer gives a row exactly one trailing control, and a submenu
 * anchored to a menu item is not a thing a card header can host. Rather than
 * teach the card renderer about nested menus, the multi-select becomes what it
 * always was — a small form — and the row action that opens it is a single
 * `DataTableRowAction`, identical in all three layouts.
 *
 * ## Why the validation moved inside
 *
 * The old code called `window.alert('User must have at least one role')` from
 * the menu's click handler. A native alert is unstyled, unreachable by the
 * assistive-technology conventions the rest of the app follows, blocks the
 * event loop, and — the practical problem — cannot be asserted on without
 * stubbing a global. The rule lives here now as inline validation: the empty
 * selection is describable, the Save button is disabled, and the message is in
 * the accessibility tree next to the control that caused it.
 *
 * The API enforces the same rule (`updateUserRolesSchema` requires
 * `min(1)`), so this is a second line, not the only one.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  FormGroup,
  Stack,
} from '@mui/material';
import type { UserListItem } from '../../types';
import { AVAILABLE_ROLES } from './userListColumns';

export interface ManageRolesDialogProps {
  /** The user being edited, or `null` when the dialog is closed. */
  user: UserListItem | null;
  onClose: () => void;
  onSave: (userId: string, roles: string[]) => Promise<void>;
}

const EMPTY_ROLES_MESSAGE = 'User must have at least one role';

export function ManageRolesDialog({ user, onClose, onSave }: ManageRolesDialogProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed whenever a different user is opened. Keyed on the user ID (a
  // scalar), never on the user OBJECT: `useUsers` replaces every row object on
  // each refetch, and keying on identity would wipe an in-progress edit on the
  // next poll.
  const userId = user?.id ?? null;
  const rolesKey = user?.roles.join(',') ?? '';
  useEffect(() => {
    setSelected(rolesKey ? rolesKey.split(',') : []);
    setError(null);
  }, [userId, rolesKey]);

  const toggle = (role: string) => {
    setSelected((current) =>
      current.includes(role) ? current.filter((r) => r !== role) : [...current, role],
    );
  };

  const isEmpty = selected.length === 0;
  const roleOptions = useMemo(() => [...AVAILABLE_ROLES], []);

  const handleSave = async () => {
    if (!user || isEmpty) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(user.id, selected);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update roles');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={Boolean(user)} onClose={saving ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Manage roles</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <DialogContentText>
            {user ? `Choose the roles for ${user.email}.` : ''}
          </DialogContentText>

          {error && <Alert severity="error">{error}</Alert>}

          {/* The validation message renders BEFORE the group it constrains and
              is referenced by it, so a screen reader reaches the rule while
              moving through the checkboxes rather than only on submit. */}
          {isEmpty && (
            <Alert severity="warning" id="manage-roles-empty">
              {EMPTY_ROLES_MESSAGE}
            </Alert>
          )}

          <FormGroup
            aria-label="Roles"
            aria-describedby={isEmpty ? 'manage-roles-empty' : undefined}
          >
            {roleOptions.map((role) => (
              <FormControlLabel
                key={role}
                control={
                  <Checkbox
                    checked={selected.includes(role)}
                    onChange={() => toggle(role)}
                    disabled={saving}
                  />
                }
                label={role}
              />
            ))}
          </FormGroup>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button variant="contained" onClick={handleSave} disabled={isEmpty || saving}>
          {saving ? 'Saving…' : 'Save roles'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
