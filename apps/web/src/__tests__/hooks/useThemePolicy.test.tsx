import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useThemePolicy } from '../../hooks/useThemePolicy';
import * as authContext from '../../contexts/AuthContext';

/**
 * #79: `allowUserThemeOverride` existed server-side, had an admin UI, and
 * nothing honoured it — an administrator could turn it off and every user kept
 * their toggle. This hook is what makes the setting real.
 */

function withUser(user: Record<string, unknown> | null) {
  vi.spyOn(authContext, 'useAuth').mockReturnValue({
    user,
  } as unknown as ReturnType<typeof authContext.useAuth>);
}

describe('useThemePolicy', () => {
  it('allows the override when the flag is true', () => {
    withUser({ allowUserThemeOverride: true });
    expect(renderHook(() => useThemePolicy()).result.current).toEqual({
      canOverrideTheme: true,
    });
  });

  it('forbids it when an administrator has pinned the theme', () => {
    withUser({ allowUserThemeOverride: false });
    expect(
      renderHook(() => useThemePolicy()).result.current.canOverrideTheme,
    ).toBe(false);
  });

  it('defaults to allowed before /auth/me has landed', () => {
    // Guessing wrong this way makes a toggle appear and then vanish. Guessing
    // the other way hides a control from everyone whenever the API is slow.
    withUser(null);
    expect(
      renderHook(() => useThemePolicy()).result.current.canOverrideTheme,
    ).toBe(true);
  });

  it('defaults to allowed when an older API omits the field', () => {
    withUser({ id: 'u1' });
    expect(
      renderHook(() => useThemePolicy()).result.current.canOverrideTheme,
    ).toBe(true);
  });
});
