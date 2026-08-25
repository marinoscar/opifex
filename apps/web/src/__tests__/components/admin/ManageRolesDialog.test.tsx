/**
 * How the checkbox list is seeded from the `user` prop (#185).
 *
 * The seeding used to run in a `useEffect`, so the first commit for a newly
 * opened user showed the PREVIOUS user's roles. It is now adjusted during
 * render, keyed on the same scalar key the effect used — the user id plus the
 * roles, never the row object, because `useUsers` replaces every row object on
 * each refetch and keying on identity would wipe an edit in progress.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { ManageRolesDialog } from '../../../components/admin/ManageRolesDialog';
import type { UserListItem } from '../../../types';

function makeUser(overrides: Partial<UserListItem> = {}): UserListItem {
  return {
    id: 'user-1',
    email: 'ada@example.com',
    displayName: 'Ada',
    providerDisplayName: null,
    profileImageUrl: null,
    isActive: true,
    roles: ['viewer'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const box = (role: string) => screen.getByRole('checkbox', { name: role });

describe('ManageRolesDialog — seeding from props', () => {
  const handlers = { onClose: vi.fn(), onSave: vi.fn() };

  it('checks the roles the user already has, on the first render', () => {
    render(
      <ManageRolesDialog
        user={makeUser({ roles: ['admin', 'viewer'] })}
        {...handlers}
      />,
    );

    expect(box('admin')).toBeChecked();
    expect(box('viewer')).toBeChecked();
    expect(box('contributor')).not.toBeChecked();
  });

  it('re-seeds when a different user is opened', () => {
    const { rerender } = render(
      <ManageRolesDialog user={makeUser({ roles: ['admin'] })} {...handlers} />,
    );
    expect(box('admin')).toBeChecked();

    rerender(
      <ManageRolesDialog
        user={makeUser({ id: 'user-2', roles: ['contributor'] })}
        {...handlers}
      />,
    );

    expect(box('contributor')).toBeChecked();
    expect(box('admin')).not.toBeChecked();
  });

  it('keeps an edit in progress when a refetch replaces the row object', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ManageRolesDialog user={makeUser()} {...handlers} />,
    );

    await user.click(box('contributor'));
    expect(box('contributor')).toBeChecked();

    // Same id, same roles, brand new object — a poll landing, not a new user.
    rerender(<ManageRolesDialog user={makeUser()} {...handlers} />);

    expect(box('contributor')).toBeChecked();
  });

  it('blocks saving once every role is unchecked', async () => {
    const user = userEvent.setup();
    render(<ManageRolesDialog user={makeUser()} {...handlers} />);

    await user.click(box('viewer'));

    expect(
      screen.getByText('User must have at least one role'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  });
});
