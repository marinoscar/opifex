/**
 * Component tests — Admin → System settings → Feature flags, after the
 * DataTable migration (#67).
 *
 * The component's substance is unchanged: local-first editing, one `PUT` on
 * save, the add-flag dialog, the delete, and the read-only mode. What changed
 * is the SHAPE it is drawn in — a `List` of `ListItem`s with a
 * `ListItemSecondaryAction` became a table with a `render`ed inline editor and
 * a row action.
 *
 * Table mechanics are asserted once by `runDataTableConformanceSuite`; the
 * suite is not invoked with these columns, because a `<Switch>` inside a
 * `render` is the same "interactive control inside a custom cell" shape the
 * fixture's `<a>` already covers.
 *
 * The old file asserted the list markup — `getAllByRole('checkbox')` for the
 * switches (they were unnamed), `ListItemText` secondary text, and delete
 * buttons found by index. Every one of those queries is now expressed by NAME,
 * which is possible precisely because the switch is labelled correctly.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { FeatureFlagsList } from '../../../components/admin/FeatureFlagsList';
import {
  installLayoutStubs,
  resetContainerWidth,
  setInitialContainerWidth,
} from '../../../components/datatable/__tests__/testUtils/layoutStubs';
import { api } from '../../../services/api';

const defaultFlags = {
  zebra_mode: true,
  alpha_feature: false,
  beta_feature: true,
};

function renderFlags(
  props: Partial<React.ComponentProps<typeof FeatureFlagsList>> = {},
  width = 1400,
) {
  const onSave = props.onSave ?? vi.fn().mockResolvedValue(undefined);
  setInitialContainerWidth(width);
  const result = render(
    <FeatureFlagsList flags={props.flags ?? defaultFlags} onSave={onSave} disabled={props.disabled} />,
  );
  return { ...result, onSave };
}

const switchFor = (key: string) => screen.getByRole('switch', { name: `Toggle ${key}` });
const deleteFor = (key: string) =>
  screen.getByRole('button', { name: `Delete flag for ${key}` });

// ---------------------------------------------------------------------------

describe('FeatureFlagsList', () => {
  beforeAll(() => {
    installLayoutStubs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetContainerWidth(1400);
    vi.spyOn(api, 'get').mockResolvedValue({ dataTables: {} } as never);
    vi.spyOn(api, 'patch').mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Rendering
  // =========================================================================

  describe('rendering', () => {
    it('renders the heading, Add Flag and Save Changes', () => {
      renderFlags();

      expect(screen.getByText('Feature Flags')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /add flag/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    });

    it('renders one row per flag, in alphabetical order', async () => {
      renderFlags();

      await screen.findByText('alpha_feature');
      const cells = screen
        .getAllByRole('gridcell')
        .map((cell) => cell.textContent)
        .filter((text) => text && text in defaultFlags);
      expect(cells).toEqual(['alpha_feature', 'beta_feature', 'zebra_mode']);
    });

    it('gives every switch an accessible name that identifies its flag', async () => {
      renderFlags();

      await screen.findByText('alpha_feature');
      // `<Switch aria-label>` would have put the name on the wrapper span,
      // leaving the element with `role="switch"` nameless — which is what the
      // old suite's `getAllByRole('checkbox')[index]` queries worked around.
      expect(switchFor('alpha_feature')).toBeInTheDocument();
      expect(switchFor('beta_feature')).toBeInTheDocument();
      expect(switchFor('zebra_mode')).toBeInTheDocument();
    });

    it('reflects each flag’s value in its switch', async () => {
      renderFlags();

      await screen.findByText('alpha_feature');
      expect(switchFor('zebra_mode')).toBeChecked();
      expect(switchFor('beta_feature')).toBeChecked();
      expect(switchFor('alpha_feature')).not.toBeChecked();
    });

    it('shows the empty state and still offers Add Flag with no flags configured', async () => {
      renderFlags({ flags: {} });

      expect(await screen.findByText('No feature flags configured')).toBeInTheDocument();
      expect(screen.queryByRole('switch')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /add flag/i })).toBeInTheDocument();
    });

    it('handles keys with special characters', async () => {
      renderFlags({ flags: { 'feature-with-dash': true, 'feature.with.dots': false } });

      await screen.findByText('feature-with-dash');
      expect(switchFor('feature-with-dash')).toBeChecked();
      expect(switchFor('feature.with.dots')).not.toBeChecked();
    });
  });

  // =========================================================================
  // Toggling
  // =========================================================================

  describe('toggling', () => {
    it('toggles a flag on and off and enables Save', async () => {
      const user = userEvent.setup();
      renderFlags();

      await screen.findByText('alpha_feature');
      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();

      await user.click(switchFor('alpha_feature'));
      expect(switchFor('alpha_feature')).toBeChecked();
      expect(screen.getByRole('button', { name: /save changes/i })).toBeEnabled();

      await user.click(switchFor('zebra_mode'));
      expect(switchFor('zebra_mode')).not.toBeChecked();
    });

    it('sends every local change in one save', async () => {
      const user = userEvent.setup();
      const { onSave } = renderFlags();

      await screen.findByText('alpha_feature');
      await user.click(switchFor('alpha_feature'));
      await user.click(switchFor('zebra_mode'));
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() =>
        expect(onSave).toHaveBeenCalledWith({
          zebra_mode: false,
          alpha_feature: true,
          beta_feature: true,
        }),
      );
      expect(onSave).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Delete — now a row action with a confirmation
  // =========================================================================

  describe('delete', () => {
    it('removes a flag through the row action’s confirmation dialog', async () => {
      const user = userEvent.setup();
      const { onSave } = renderFlags();

      await screen.findByText('alpha_feature');
      await user.click(deleteFor('alpha_feature'));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Delete flag?')).toBeInTheDocument();
      // Still present: the dialog gates the removal.
      expect(screen.getByText('alpha_feature')).toBeInTheDocument();

      await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

      // Wait for the dialog to unmount too: while it is open MUI marks the
      // rest of the tree `aria-hidden`, so a role query would not see Save.
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(screen.queryByText('alpha_feature')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /save changes/i })).toBeEnabled();

      await user.click(screen.getByRole('button', { name: /save changes/i }));
      await waitFor(() =>
        expect(onSave).toHaveBeenCalledWith({ zebra_mode: true, beta_feature: true }),
      );
    });

    it('falls back to the empty state when every flag is deleted', async () => {
      const user = userEvent.setup();
      renderFlags({ flags: { only_flag: true } });

      await screen.findByText('only_flag');
      await user.click(deleteFor('only_flag'));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

      expect(await screen.findByText('No feature flags configured')).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Add flag dialog
  // =========================================================================

  describe('add flag dialog', () => {
    async function openDialog(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getByRole('button', { name: /add flag/i }));
      return screen.findByRole('dialog');
    }

    it('adds a new flag, disabled by default, and closes', async () => {
      const user = userEvent.setup();
      renderFlags();

      const dialog = await openDialog(user);
      await user.type(within(dialog).getByLabelText(/flag name/i), 'new_flag');
      await user.click(within(dialog).getByRole('button', { name: 'Add' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(switchFor('new_flag')).not.toBeChecked();
    });

    it('replaces spaces with underscores in the flag name', async () => {
      const user = userEvent.setup();
      renderFlags();

      const dialog = await openDialog(user);
      await user.type(within(dialog).getByLabelText(/flag name/i), 'my new flag');
      await user.click(within(dialog).getByRole('button', { name: 'Add' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(switchFor('my_new_flag')).toBeInTheDocument();
    });

    it('refuses a duplicate key and keeps the dialog open', async () => {
      const user = userEvent.setup();
      renderFlags();

      const dialog = await openDialog(user);
      await user.type(within(dialog).getByLabelText(/flag name/i), 'zebra_mode');
      await user.click(within(dialog).getByRole('button', { name: 'Add' }));

      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getAllByText('zebra_mode')).toHaveLength(1);
    });

    it('disables Add until a name is typed, and cancels cleanly', async () => {
      const user = userEvent.setup();
      renderFlags();

      const dialog = await openDialog(user);
      expect(within(dialog).getByRole('button', { name: 'Add' })).toBeDisabled();

      await user.type(within(dialog).getByLabelText(/flag name/i), 'x');
      expect(within(dialog).getByRole('button', { name: 'Add' })).toBeEnabled();

      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(screen.queryByRole('switch', { name: 'Toggle x' })).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // Saving
  // =========================================================================

  describe('saving', () => {
    it('shows "Saving..." and disables Save while the write is in flight', async () => {
      const user = userEvent.setup();
      let resolve!: () => void;
      const onSave = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
      renderFlags({ onSave });

      await screen.findByText('alpha_feature');
      await user.click(switchFor('alpha_feature'));
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      const saving = await screen.findByRole('button', { name: /saving\.\.\./i });
      expect(saving).toBeDisabled();

      resolve();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument(),
      );
    });

    it('keeps the local edit when the save fails', async () => {
      const user = userEvent.setup();
      const onSave = vi.fn().mockRejectedValue(new Error('nope'));
      renderFlags({ onSave });

      await screen.findByText('alpha_feature');
      await user.click(switchFor('alpha_feature'));
      await user.click(screen.getByRole('button', { name: /save changes/i })).catch(() => {});

      await waitFor(() => expect(onSave).toHaveBeenCalled());
      // The edit survives, and Save is offered again.
      expect(switchFor('alpha_feature')).toBeChecked();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /save changes/i })).toBeEnabled(),
      );
    });
  });

  // =========================================================================
  // Read-only mode
  // =========================================================================

  describe('read-only mode', () => {
    /**
     * `disabled` conflates "no system_settings:write" with "a save is in
     * flight", so it is expressed as a per-row/per-control `disabled` rather
     * than by dropping controls: a viewer must still be able to SEE which
     * flags exist, which are on, and that they are deletable by someone.
     */
    it('disables every control but keeps them all present', async () => {
      renderFlags({ disabled: true });

      await screen.findByText('alpha_feature');
      for (const key of Object.keys(defaultFlags)) {
        expect(switchFor(key)).toBeDisabled();
        expect(deleteFor(key)).toBeDisabled();
      }
      expect(screen.getByRole('button', { name: /add flag/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    });

    it('leaves the controls live when disabled is false or absent', async () => {
      renderFlags({ disabled: false });

      await screen.findByText('alpha_feature');
      expect(switchFor('alpha_feature')).toBeEnabled();
      expect(deleteFor('alpha_feature')).toBeEnabled();
      expect(screen.getByRole('button', { name: /add flag/i })).toBeEnabled();
    });
  });
});
