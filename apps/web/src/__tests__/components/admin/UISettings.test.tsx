import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../../utils/test-utils';
import { UISettings } from '../../../components/admin/UISettings';

describe('UISettings', () => {
  const mockOnSave = vi.fn();

  const defaultSettings = {
    allowUserThemeOverride: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockOnSave.mockResolvedValue(undefined);
  });

  describe('Rendering', () => {
    it('should render UI settings heading', () => {
      render(
        <UISettings settings={defaultSettings} onSave={mockOnSave} />,
        { wrapperOptions: { user: mockAdminUser } }
      );

      expect(screen.getByText('User Interface')).toBeInTheDocument();
    });

    it('should render theme override switch with label', () => {
      render(
        <UISettings settings={defaultSettings} onSave={mockOnSave} />,
        { wrapperOptions: { user: mockAdminUser } }
      );

      expect(
        screen.getByLabelText(/allow users to override system theme/i)
      ).toBeInTheDocument();
    });

    it('should show helper text explaining theme override', () => {
      render(
        <UISettings settings={defaultSettings} onSave={mockOnSave} />,
        { wrapperOptions: { user: mockAdminUser } }
      );

      expect(
        screen.getByText(/when disabled, all users will use the system-defined theme/i)
      ).toBeInTheDocument();
    });

    it('should render save button', () => {
      render(
        <UISettings settings={defaultSettings} onSave={mockOnSave} />,
        { wrapperOptions: { user: mockAdminUser } }
      );

      expect(
        screen.getByRole('button', { name: /save changes/i })
      ).toBeInTheDocument();
    });

    it('should display switch as checked when allowUserThemeOverride is true', () => {
      render(
        <UISettings settings={defaultSettings} onSave={mockOnSave} />,
        { wrapperOptions: { user: mockAdminUser } }
      );

      const switchElement = screen.getByRole('switch', {
        name: /allow users to override system theme/i,
      });
      expect(switchElement).toBeChecked();
    });

    it('should display switch as unchecked when allowUserThemeOverride is false', () => {
      render(
        <UISettings
          settings={{ allowUserThemeOverride: false }}
          onSave={mockOnSave}
        />,
        { wrapperOptions: { user: mockAdminUser } }
      );

      const switchElement = screen.getByRole('switch', {
        name: /allow users to override system theme/i,
      });
      expect(switchElement).not.toBeChecked();
    });
  });

  describe('Initial State', () => {
    it('should disable save button when no changes made', () => {
      render(
        <UISettings settings={defaultSettings} onSave={mockOnSave} />,
        { wrapperOptions: { user: mockAdminUser } }
      );

      const saveButton = screen.getByRole('button', {
        name: /save changes/i,
      });
      expect(saveButton).toBeDisabled();
    });

    it('should update switch state when settings prop changes', async () => {
      const { rerender } = render(
        <UISettings settings={defaultSettings} onSave={mockOnSave} />,
        { wrapperOptions: { user: mockAdminUser } }
      );

      const newSettings = {
        allowUserThemeOverride: false,
      };

      rerender(<UISettings settings={newSettings} onSave={mockOnSave} />);

      await waitFor(() => {
        const switchElement = screen.getByRole('switch', {
          name: /allow users to override system theme/i,
        });
        expect(switchElement).not.toBeChecked();
      });
    });
  });

  describe('User Interaction', () => {
    it('should toggle switch when clicked', async () => {
      const user = userEvent.setup();

      render(
        <UISettings settings={defaultSettings} onSave={mockOnSave} />,
        { wrapperOptions: { user: mockAdminUser } }
      );

      const switchElement = screen.getByRole('switch', {
        name: /allow users to override system theme/i,
      });

      expect(switchElement).toBeChecked();

      await user.click(switchElement);

      expect(switchElement).not.toBeChecked();
    });

    it('should enable save button when switch is toggled', async () => {
      const user = userEvent.setup();

      render(
        <UISettings settings={defaultSettings} onSave={mockOnSave} />,
        { wrapperOptions: { user: mockAdminUser } }
      );

      const switchElement = screen.getByRole('switch', {
        name: /allow users to override system theme/i,
      });
      const saveButton = screen.getByRole('button', {
        name: /save changes/i,
      });

      expect(saveButton).toBeDisabled();

      await user.click(switchElement);

      expect(saveButton).not.toBeDisabled();
    });

    it('should disable save button when switch is toggled back to original value', async () => {
      const user = userEvent.setup();

      render(
        <UISettings settings={defaultSettings} onSave={mockOnSave} />,
        { wrapperOptions: { user: mockAdminUser } }
      );

      const switchElement = screen.getByRole('switch', {
        name: /allow users to override system theme/i,
      });
      const saveButton = screen.getByRole('button', {
        name: /save changes/i,
      });

      // Toggle off
      await user.click(switchElement);
      expect(saveButton).not.toBeDisabled();

      // Toggle back on (original value)
      await user.click(switchElement);
      expect(saveButton).toBeDisabled();
    });
  });

  describe('Save Functionality', () => {
    it('should call onSave with updated value when save button clicked', async () => {
      const user = userEvent.setup();

      render(
        <UISettings settings={defaultSettings} onSave={mockOnSave} />,
        { wrapperOptions: { user: mockAdminUser } }
      );

      const switchElement = screen.getByRole('switch', {
        name: /allow users to override system theme/i,
      });
      const saveButton = screen.getByRole('button', {
        name: /save changes/i,
      });

      await user.click(switchElement);
      await user.click(saveButton);

      await waitFor(() => {
        expect(mockOnSave).toHaveBeenCalledWith({
          allowUserThemeOverride: false,
        });
      });
    });

    it('should call onSave only once on button click', async () => {
      const user = userEvent.setup();

      render(
        <UISettings settings={defaultSettings} onSave={mockOnSave} />,
        { wrapperOptions: { user: mockAdminUser } }
      );

      const switchElement = screen.getByRole('switch', {
        name: /allow users to override system theme/i,
      });
      const saveButton = screen.getByRole('button', {
        name: /save changes/i,
      });

      await user.click(switchElement);
      await user.click(saveButton);

      await waitFor(() => {
        expect(mockOnSave).toHaveBeenCalledTimes(1);
      });
    });

    it('should call onSave with true when toggling from false to true', async () => {
      const user = userEvent.setup();

      render(
        <UISettings
          settings={{ allowUserThemeOverride: false }}
          onSave={mockOnSave}
        />,
        { wrapperOptions: { user: mockAdminUser } }
      );

      const switchElement = screen.getByRole('switch', {
        name: /allow users to override system theme/i,
      });
      const saveButton = screen.getByRole('button', {
        name: /save changes/i,
      });

      await user.click(switchElement);
      await user.click(saveButton);

      await waitFor(() => {
        expect(mockOnSave).toHaveBeenCalledWith({
          allowUserThemeOverride: true,
        });
      });
    });
  });

  describe('Loading State', () => {
    it('should show "Saving..." text when save is in progress', async () => {
      const user = userEvent.setup();
      const slowSave = vi.fn(
        () => new Promise((resolve) => setTimeout(resolve, 100))
      );

      render(
        <UISettings settings={defaultSettings} onSave={slowSave} />,
        { wrapperOptions: { user: mockAdminUser } }
      );

      const switchElement = screen.getByRole('switch', {
        name: /allow users to override system theme/i,
      });
      const saveButton = screen.getByRole('button', {
        name: /save changes/i,
      });

      await user.click(switchElement);
      await user.click(saveButton);

      expect(
        screen.getByRole('button', { name: /saving\.\.\./i })
      ).toBeInTheDocument();
    });

    it('should disable save button while saving', async () => {
      const user = userEvent.setup();
      const slowSave = vi.fn(
        () => new Promise((resolve) => setTimeout(resolve, 100))
      );

      render(
        <UISettings settings={defaultSettings} onSave={slowSave} />,
        { wrapperOptions: { user: mockAdminUser } }
      );

      const switchElement = screen.getByRole('switch', {
        name: /allow users to override system theme/i,
      });
      const saveButton = screen.getByRole('button', {
        name: /save changes/i,
      });

      await user.click(switchElement);
      await user.click(saveButton);

      const savingButton = screen.getByRole('button', { name: /saving\.\.\./i });
      expect(savingButton).toBeDisabled();
    });

    it('should return to "Save Changes" text after save completes', async () => {
      const user = userEvent.setup();

      render(
        <UISettings settings={defaultSettings} onSave={mockOnSave} />,
        { wrapperOptions: { user: mockAdminUser } }
      );

      const switchElement = screen.getByRole('switch', {
        name: /allow users to override system theme/i,
      });
      const saveButton = screen.getByRole('button', {
        name: /save changes/i,
      });

      await user.click(switchElement);
      await user.click(saveButton);

      // Wait for save to complete
      await waitFor(() => {
        expect(mockOnSave).toHaveBeenCalled();
      });

      // Button text should be back to "Save Changes"
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /save changes/i })
        ).toBeInTheDocument();
      });
    });

    it('should re-enable save button after save completes', async () => {
      const user = userEvent.setup();

      render(
        <UISettings settings={defaultSettings} onSave={mockOnSave} />,
        { wrapperOptions: { user: mockAdminUser } }
      );

      const switchElement = screen.getByRole('switch', {
        name: /allow users to override system theme/i,
      });
      const saveButton = screen.getByRole('button', {
        name: /save changes/i,
      });

      await user.click(switchElement);
      await user.click(saveButton);

      await waitFor(() => {
        expect(mockOnSave).toHaveBeenCalled();
      });

      // Button text should be back to "Save Changes" (not "Saving...")
      await waitFor(() => {
        const button = screen.getByRole('button', { name: /save changes/i });
        expect(button).toBeInTheDocument();
      });

      // Button will still be enabled because local state differs from prop
      // In a real scenario, the parent would update the settings prop after save
      const button = screen.getByRole('button', { name: /save changes/i });
      expect(button).not.toBeDisabled();
    });

    it('should re-enable save button after save completes successfully', async () => {
      const user = userEvent.setup();
      const slowSave = vi.fn(
        () => new Promise((resolve) => setTimeout(resolve, 50))
      );

      render(
        <UISettings settings={defaultSettings} onSave={slowSave} />,
        { wrapperOptions: { user: mockAdminUser } }
      );

      const switchElement = screen.getByRole('switch', {
        name: /allow users to override system theme/i,
      });
      const saveButton = screen.getByRole('button', {
        name: /save changes/i,
      });

      await user.click(switchElement);
      await user.click(saveButton);

      await waitFor(() => {
        expect(slowSave).toHaveBeenCalled();
      });

      // Controls should be enabled again after save completes
      await waitFor(() => {
        const button = screen.getByRole('button', { name: /save changes/i });
        expect(button).not.toBeDisabled();
      });

      expect(switchElement).not.toBeDisabled();
    });
  });

  describe('Disabled State', () => {
    it('should disable switch when disabled prop is true', () => {
      render(
        <UISettings
          settings={defaultSettings}
          onSave={mockOnSave}
          disabled={true}
        />,
        { wrapperOptions: { user: mockAdminUser } }
      );

      const switchElement = screen.getByRole('switch', {
        name: /allow users to override system theme/i,
      });
      expect(switchElement).toBeDisabled();
    });

    it('should disable save button when disabled prop is true', () => {
      render(
        <UISettings
          settings={defaultSettings}
          onSave={mockOnSave}
          disabled={true}
        />,
        { wrapperOptions: { user: mockAdminUser } }
      );

      const saveButton = screen.getByRole('button', {
        name: /save changes/i,
      });
      expect(saveButton).toBeDisabled();
    });

    it('should disable save button even if there are changes when disabled prop is true', async () => {
      const user = userEvent.setup();

      const { rerender } = render(
        <UISettings settings={defaultSettings} onSave={mockOnSave} />,
        { wrapperOptions: { user: mockAdminUser } }
      );

      const switchElement = screen.getByRole('switch', {
        name: /allow users to override system theme/i,
      });

      // Make a change
      await user.click(switchElement);

      // Now disable the component
      rerender(
        <UISettings
          settings={defaultSettings}
          onSave={mockOnSave}
          disabled={true}
        />
      );

      const saveButton = screen.getByRole('button', {
        name: /save changes/i,
      });
      expect(saveButton).toBeDisabled();
    });

    it('should not disable switch when disabled prop is false', () => {
      render(
        <UISettings
          settings={defaultSettings}
          onSave={mockOnSave}
          disabled={false}
        />,
        { wrapperOptions: { user: mockAdminUser } }
      );

      const switchElement = screen.getByRole('switch', {
        name: /allow users to override system theme/i,
      });
      expect(switchElement).not.toBeDisabled();
    });

    it('should not disable switch when disabled prop is undefined', () => {
      render(
        <UISettings settings={defaultSettings} onSave={mockOnSave} />,
        { wrapperOptions: { user: mockAdminUser } }
      );

      const switchElement = screen.getByRole('switch', {
        name: /allow users to override system theme/i,
      });
      expect(switchElement).not.toBeDisabled();
    });

    it('should prevent interaction when disabled', () => {
      render(
        <UISettings
          settings={defaultSettings}
          onSave={mockOnSave}
          disabled={true}
        />,
        { wrapperOptions: { user: mockAdminUser } }
      );

      const switchElement = screen.getByRole('switch', {
        name: /allow users to override system theme/i,
      });
      const saveButton = screen.getByRole('button', {
        name: /save changes/i,
      });

      // Elements should be disabled, preventing interaction
      expect(switchElement).toBeDisabled();
      expect(saveButton).toBeDisabled();

      // onSave should not have been called
      expect(mockOnSave).not.toHaveBeenCalled();

      // Switch state should remain unchanged
      expect(switchElement).toBeChecked();
    });
  });

  describe('Edge Cases', () => {
    it('should preserve switch state across save operations', async () => {
      const user = userEvent.setup();

      render(
        <UISettings settings={defaultSettings} onSave={mockOnSave} />,
        { wrapperOptions: { user: mockAdminUser } }
      );

      const switchElement = screen.getByRole('switch', {
        name: /allow users to override system theme/i,
      });
      const saveButton = screen.getByRole('button', {
        name: /save changes/i,
      });

      // Change from true to false
      await user.click(switchElement);
      expect(switchElement).not.toBeChecked();

      await user.click(saveButton);

      await waitFor(() => {
        expect(mockOnSave).toHaveBeenCalledWith({
          allowUserThemeOverride: false,
        });
      });

      // Switch state should still be false (the changed value)
      expect(switchElement).not.toBeChecked();
    });

    it('should handle multiple rapid toggle clicks', async () => {
      const user = userEvent.setup();

      render(
        <UISettings settings={defaultSettings} onSave={mockOnSave} />,
        { wrapperOptions: { user: mockAdminUser } }
      );

      const switchElement = screen.getByRole('switch', {
        name: /allow users to override system theme/i,
      });

      // Rapidly toggle multiple times
      await user.click(switchElement); // false
      await user.click(switchElement); // true
      await user.click(switchElement); // false
      await user.click(switchElement); // true

      // Final state should be true (original value)
      expect(switchElement).toBeChecked();

      // Save button should be disabled (no changes)
      const saveButton = screen.getByRole('button', {
        name: /save changes/i,
      });
      expect(saveButton).toBeDisabled();
    });

    it('should handle settings prop update while save is in progress', async () => {
      const user = userEvent.setup();
      let resolveSave: () => void;
      const slowSave = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveSave = resolve;
          })
      );

      const { rerender } = render(
        <UISettings settings={defaultSettings} onSave={slowSave} />,
        { wrapperOptions: { user: mockAdminUser } }
      );

      const switchElement = screen.getByRole('switch', {
        name: /allow users to override system theme/i,
      });
      const saveButton = screen.getByRole('button', {
        name: /save changes/i,
      });

      await user.click(switchElement);
      await user.click(saveButton);

      // While saving, update the settings prop
      rerender(
        <UISettings
          settings={{ allowUserThemeOverride: false }}
          onSave={slowSave}
        />
      );

      // Resolve the save
      resolveSave!();

      await waitFor(() => {
        expect(slowSave).toHaveBeenCalled();
      });

      // After save completes and prop updates, switch should reflect new prop value
      await waitFor(() => {
        expect(switchElement).not.toBeChecked();
      });
    });

    it('should detect changes correctly after prop update', async () => {
      const user = userEvent.setup();

      const { rerender } = render(
        <UISettings settings={defaultSettings} onSave={mockOnSave} />,
        { wrapperOptions: { user: mockAdminUser } }
      );

      // Change from true to false
      const switchElement = screen.getByRole('switch', {
        name: /allow users to override system theme/i,
      });
      await user.click(switchElement);

      let saveButton = screen.getByRole('button', {
        name: /save changes/i,
      });
      expect(saveButton).not.toBeDisabled();

      // Update prop to match current state (false)
      rerender(
        <UISettings
          settings={{ allowUserThemeOverride: false }}
          onSave={mockOnSave}
        />
      );

      // Now there should be no changes
      await waitFor(() => {
        const button = screen.getByRole('button', {
          name: /save changes/i,
        });
        expect(button).toBeDisabled();
      });
    });

    it('should not call onSave when save button is disabled due to no changes', () => {
      render(
        <UISettings settings={defaultSettings} onSave={mockOnSave} />,
        { wrapperOptions: { user: mockAdminUser } }
      );

      const saveButton = screen.getByRole('button', {
        name: /save changes/i,
      });

      // Button should be disabled when there are no changes
      expect(saveButton).toBeDisabled();

      // onSave should not have been called
      expect(mockOnSave).not.toHaveBeenCalled();
    });
  });
});
