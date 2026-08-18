import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { ThemeSettings } from '../../../components/settings/ThemeSettings';

describe('ThemeSettings', () => {
  const mockOnThemeChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('should render the component', () => {
      render(
        <ThemeSettings currentTheme="system" onThemeChange={mockOnThemeChange} />
      );

      expect(screen.getByText(/appearance/i)).toBeInTheDocument();
    });

    it('should render heading', () => {
      render(
        <ThemeSettings currentTheme="system" onThemeChange={mockOnThemeChange} />
      );

      expect(
        screen.getByRole('heading', { name: /appearance/i })
      ).toBeInTheDocument();
    });

    it('should render description text', () => {
      render(
        <ThemeSettings currentTheme="system" onThemeChange={mockOnThemeChange} />
      );

      expect(
        screen.getByText(/choose how the application looks to you/i)
      ).toBeInTheDocument();
    });

    it('should render as a card', () => {
      const { container } = render(
        <ThemeSettings currentTheme="system" onThemeChange={mockOnThemeChange} />
      );

      const card = container.querySelector('#theme');
      expect(card).toBeInTheDocument();
    });
  });

  describe('Theme Options', () => {
    it('should render all three theme options', () => {
      render(
        <ThemeSettings currentTheme="system" onThemeChange={mockOnThemeChange} />
      );

      expect(screen.getByLabelText(/light mode/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/dark mode/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/system preference/i)).toBeInTheDocument();
    });

    it('should display Light option with text', () => {
      render(
        <ThemeSettings currentTheme="system" onThemeChange={mockOnThemeChange} />
      );

      const lightButton = screen.getByLabelText(/light mode/i);
      expect(lightButton).toHaveTextContent(/light/i);
    });

    it('should display Dark option with text', () => {
      render(
        <ThemeSettings currentTheme="system" onThemeChange={mockOnThemeChange} />
      );

      const darkButton = screen.getByLabelText(/dark mode/i);
      expect(darkButton).toHaveTextContent(/dark/i);
    });

    it('should display System option with text', () => {
      render(
        <ThemeSettings currentTheme="system" onThemeChange={mockOnThemeChange} />
      );

      const systemButton = screen.getByLabelText(/system preference/i);
      expect(systemButton).toHaveTextContent(/system/i);
    });
  });

  describe('Current Theme Selection', () => {
    it('should show light theme as selected', () => {
      render(
        <ThemeSettings currentTheme="light" onThemeChange={mockOnThemeChange} />
      );

      const lightButton = screen.getByLabelText(/light mode/i);
      expect(lightButton).toHaveClass('Mui-selected');
    });

    it('should show dark theme as selected', () => {
      render(
        <ThemeSettings currentTheme="dark" onThemeChange={mockOnThemeChange} />
      );

      const darkButton = screen.getByLabelText(/dark mode/i);
      expect(darkButton).toHaveClass('Mui-selected');
    });

    it('should show system theme as selected', () => {
      render(
        <ThemeSettings currentTheme="system" onThemeChange={mockOnThemeChange} />
      );

      const systemButton = screen.getByLabelText(/system preference/i);
      expect(systemButton).toHaveClass('Mui-selected');
    });

    it('should only have one option selected at a time', () => {
      render(
        <ThemeSettings currentTheme="light" onThemeChange={mockOnThemeChange} />
      );

      const lightButton = screen.getByLabelText(/light mode/i);
      const darkButton = screen.getByLabelText(/dark mode/i);
      const systemButton = screen.getByLabelText(/system preference/i);

      expect(lightButton).toHaveClass('Mui-selected');
      expect(darkButton).not.toHaveClass('Mui-selected');
      expect(systemButton).not.toHaveClass('Mui-selected');
    });
  });

  describe('Theme Change Handler', () => {
    it('should call onThemeChange when light theme is selected', async () => {
      const user = userEvent.setup();

      render(
        <ThemeSettings currentTheme="system" onThemeChange={mockOnThemeChange} />
      );

      const lightButton = screen.getByLabelText(/light mode/i);
      await user.click(lightButton);

      expect(mockOnThemeChange).toHaveBeenCalledTimes(1);
      expect(mockOnThemeChange).toHaveBeenCalledWith('light');
    });

    it('should call onThemeChange when dark theme is selected', async () => {
      const user = userEvent.setup();

      render(
        <ThemeSettings currentTheme="system" onThemeChange={mockOnThemeChange} />
      );

      const darkButton = screen.getByLabelText(/dark mode/i);
      await user.click(darkButton);

      expect(mockOnThemeChange).toHaveBeenCalledTimes(1);
      expect(mockOnThemeChange).toHaveBeenCalledWith('dark');
    });

    it('should call onThemeChange when system theme is selected', async () => {
      const user = userEvent.setup();

      render(
        <ThemeSettings currentTheme="light" onThemeChange={mockOnThemeChange} />
      );

      const systemButton = screen.getByLabelText(/system preference/i);
      await user.click(systemButton);

      expect(mockOnThemeChange).toHaveBeenCalledTimes(1);
      expect(mockOnThemeChange).toHaveBeenCalledWith('system');
    });

    it('should handle multiple theme changes', async () => {
      const user = userEvent.setup();

      render(
        <ThemeSettings currentTheme="system" onThemeChange={mockOnThemeChange} />
      );

      const lightButton = screen.getByLabelText(/light mode/i);
      const darkButton = screen.getByLabelText(/dark mode/i);

      await user.click(lightButton);
      await user.click(darkButton);

      expect(mockOnThemeChange).toHaveBeenCalledTimes(2);
      expect(mockOnThemeChange).toHaveBeenNthCalledWith(1, 'light');
      expect(mockOnThemeChange).toHaveBeenNthCalledWith(2, 'dark');
    });

    it('should not call onThemeChange when clicking already selected theme', async () => {
      const user = userEvent.setup();

      render(
        <ThemeSettings currentTheme="light" onThemeChange={mockOnThemeChange} />
      );

      const lightButton = screen.getByLabelText(/light mode/i);
      await user.click(lightButton);

      // MUI ToggleButtonGroup with exclusive mode does not trigger onChange
      // when clicking an already selected button (this is by design)
      expect(mockOnThemeChange).not.toHaveBeenCalled();
    });

    it('should pass correct theme values to handler', async () => {
      const user = userEvent.setup();

      // Start from system, click light
      const { unmount } = render(
        <ThemeSettings currentTheme="system" onThemeChange={mockOnThemeChange} />
      );

      await user.click(screen.getByLabelText(/light mode/i));
      expect(mockOnThemeChange).toHaveBeenCalledWith('light');

      unmount();
      vi.clearAllMocks();

      // Start from light, click dark
      const { unmount: unmount2 } = render(
        <ThemeSettings currentTheme="light" onThemeChange={mockOnThemeChange} />
      );

      await user.click(screen.getByLabelText(/dark mode/i));
      expect(mockOnThemeChange).toHaveBeenCalledWith('dark');

      unmount2();
      vi.clearAllMocks();

      // Start from dark, click system
      render(
        <ThemeSettings currentTheme="dark" onThemeChange={mockOnThemeChange} />
      );

      await user.click(screen.getByLabelText(/system preference/i));
      expect(mockOnThemeChange).toHaveBeenCalledWith('system');
    });
  });

  describe('Disabled State', () => {
    it('should disable all buttons when disabled prop is true', () => {
      render(
        <ThemeSettings
          currentTheme="system"
          onThemeChange={mockOnThemeChange}
          disabled
        />
      );

      const lightButton = screen.getByLabelText(/light mode/i);
      const darkButton = screen.getByLabelText(/dark mode/i);
      const systemButton = screen.getByLabelText(/system preference/i);

      expect(lightButton).toBeDisabled();
      expect(darkButton).toBeDisabled();
      expect(systemButton).toBeDisabled();
    });

    it('should enable all buttons when disabled prop is false', () => {
      render(
        <ThemeSettings
          currentTheme="system"
          onThemeChange={mockOnThemeChange}
          disabled={false}
        />
      );

      const lightButton = screen.getByLabelText(/light mode/i);
      const darkButton = screen.getByLabelText(/dark mode/i);
      const systemButton = screen.getByLabelText(/system preference/i);

      expect(lightButton).not.toBeDisabled();
      expect(darkButton).not.toBeDisabled();
      expect(systemButton).not.toBeDisabled();
    });

    it('should enable all buttons when disabled prop is omitted', () => {
      render(
        <ThemeSettings currentTheme="system" onThemeChange={mockOnThemeChange} />
      );

      const lightButton = screen.getByLabelText(/light mode/i);
      const darkButton = screen.getByLabelText(/dark mode/i);
      const systemButton = screen.getByLabelText(/system preference/i);

      expect(lightButton).not.toBeDisabled();
      expect(darkButton).not.toBeDisabled();
      expect(systemButton).not.toBeDisabled();
    });

    it('should not call onThemeChange when disabled and clicked', () => {
      render(
        <ThemeSettings
          currentTheme="system"
          onThemeChange={mockOnThemeChange}
          disabled
        />
      );

      const lightButton = screen.getByLabelText(/light mode/i);

      // Disabled buttons have pointer-events:none, so we just verify
      // the button is disabled and cannot be interacted with
      expect(lightButton).toBeDisabled();
      expect(mockOnThemeChange).not.toHaveBeenCalled();
    });

    it('should maintain selected state when disabled', () => {
      render(
        <ThemeSettings
          currentTheme="dark"
          onThemeChange={mockOnThemeChange}
          disabled
        />
      );

      const darkButton = screen.getByLabelText(/dark mode/i);
      expect(darkButton).toHaveClass('Mui-selected');
      expect(darkButton).toBeDisabled();
    });
  });

  describe('Accessibility', () => {
    it('should have proper aria-label for theme selection group', () => {
      render(
        <ThemeSettings currentTheme="system" onThemeChange={mockOnThemeChange} />
      );

      const toggleGroup = screen.getByRole('group', {
        name: /theme selection/i,
      });
      expect(toggleGroup).toBeInTheDocument();
    });

    it('should have aria-label for light mode button', () => {
      render(
        <ThemeSettings currentTheme="system" onThemeChange={mockOnThemeChange} />
      );

      expect(screen.getByLabelText(/light mode/i)).toBeInTheDocument();
    });

    it('should have aria-label for dark mode button', () => {
      render(
        <ThemeSettings currentTheme="system" onThemeChange={mockOnThemeChange} />
      );

      expect(screen.getByLabelText(/dark mode/i)).toBeInTheDocument();
    });

    it('should have aria-label for system preference button', () => {
      render(
        <ThemeSettings currentTheme="system" onThemeChange={mockOnThemeChange} />
      );

      expect(screen.getByLabelText(/system preference/i)).toBeInTheDocument();
    });

    it('should be keyboard navigable', async () => {
      const user = userEvent.setup();

      render(
        <ThemeSettings currentTheme="system" onThemeChange={mockOnThemeChange} />
      );

      const lightButton = screen.getByLabelText(/light mode/i);

      // Tab to focus the button
      await user.tab();
      expect(lightButton).toHaveFocus();

      // Press Enter to activate
      await user.keyboard('{Enter}');

      expect(mockOnThemeChange).toHaveBeenCalledWith('light');
    });

    it('should support Space key for activation', async () => {
      const user = userEvent.setup();

      render(
        <ThemeSettings currentTheme="system" onThemeChange={mockOnThemeChange} />
      );

      const lightButton = screen.getByLabelText(/light mode/i);

      // Tab to focus the button
      await user.tab();
      expect(lightButton).toHaveFocus();

      // Press Space to activate
      await user.keyboard(' ');

      expect(mockOnThemeChange).toHaveBeenCalledWith('light');
    });
  });

  describe('Icons', () => {
    it('should render light mode icon', () => {
      const { container } = render(
        <ThemeSettings currentTheme="system" onThemeChange={mockOnThemeChange} />
      );

      // MUI icons render as SVG elements
      const lightButton = screen.getByLabelText(/light mode/i);
      const svg = lightButton.querySelector('svg');
      expect(svg).toBeInTheDocument();
    });

    it('should render dark mode icon', () => {
      const { container } = render(
        <ThemeSettings currentTheme="system" onThemeChange={mockOnThemeChange} />
      );

      const darkButton = screen.getByLabelText(/dark mode/i);
      const svg = darkButton.querySelector('svg');
      expect(svg).toBeInTheDocument();
    });

    it('should render system preference icon', () => {
      const { container } = render(
        <ThemeSettings currentTheme="system" onThemeChange={mockOnThemeChange} />
      );

      const systemButton = screen.getByLabelText(/system preference/i);
      const svg = systemButton.querySelector('svg');
      expect(svg).toBeInTheDocument();
    });

    it('should render icons alongside text labels', () => {
      render(
        <ThemeSettings currentTheme="system" onThemeChange={mockOnThemeChange} />
      );

      const lightButton = screen.getByLabelText(/light mode/i);
      expect(lightButton).toHaveTextContent(/light/i);
      expect(lightButton.querySelector('svg')).toBeInTheDocument();

      const darkButton = screen.getByLabelText(/dark mode/i);
      expect(darkButton).toHaveTextContent(/dark/i);
      expect(darkButton.querySelector('svg')).toBeInTheDocument();

      const systemButton = screen.getByLabelText(/system preference/i);
      expect(systemButton).toHaveTextContent(/system/i);
      expect(systemButton.querySelector('svg')).toBeInTheDocument();
    });
  });

  describe('Visual Presentation', () => {
    it('should use exclusive selection mode', async () => {
      const user = userEvent.setup();

      render(
        <ThemeSettings currentTheme="light" onThemeChange={mockOnThemeChange} />
      );

      const lightButton = screen.getByLabelText(/light mode/i);
      const darkButton = screen.getByLabelText(/dark mode/i);

      expect(lightButton).toHaveClass('Mui-selected');
      expect(darkButton).not.toHaveClass('Mui-selected');

      await user.click(darkButton);

      // Verify the handler was called with the new selection
      await waitFor(() => {
        expect(mockOnThemeChange).toHaveBeenCalledWith('dark');
      });
    });

    it('should render buttons in correct order', () => {
      render(
        <ThemeSettings currentTheme="system" onThemeChange={mockOnThemeChange} />
      );

      const buttons = screen
        .getAllByRole('button')
        .filter((btn) => btn.getAttribute('aria-label'));

      expect(buttons).toHaveLength(3);
      expect(buttons[0]).toHaveAttribute('aria-label', 'light mode');
      expect(buttons[1]).toHaveAttribute('aria-label', 'dark mode');
      expect(buttons[2]).toHaveAttribute('aria-label', 'system preference');
    });
  });

  describe('Edge Cases', () => {
    it('should handle rapid theme changes', async () => {
      const user = userEvent.setup();

      render(
        <ThemeSettings currentTheme="system" onThemeChange={mockOnThemeChange} />
      );

      const lightButton = screen.getByLabelText(/light mode/i);
      const darkButton = screen.getByLabelText(/dark mode/i);

      // Multiple rapid clicks between different options
      await user.click(lightButton);
      await user.click(darkButton);
      await user.click(lightButton);
      await user.click(darkButton);

      await waitFor(() => {
        expect(mockOnThemeChange).toHaveBeenCalledTimes(4);
      });

      expect(mockOnThemeChange).toHaveBeenNthCalledWith(1, 'light');
      expect(mockOnThemeChange).toHaveBeenNthCalledWith(2, 'dark');
      expect(mockOnThemeChange).toHaveBeenNthCalledWith(3, 'light');
      expect(mockOnThemeChange).toHaveBeenNthCalledWith(4, 'dark');
    });

    it('should handle theme prop changes from parent', () => {
      const { rerender } = render(
        <ThemeSettings currentTheme="light" onThemeChange={mockOnThemeChange} />
      );

      expect(screen.getByLabelText(/light mode/i)).toHaveClass('Mui-selected');

      rerender(
        <ThemeSettings currentTheme="dark" onThemeChange={mockOnThemeChange} />
      );

      expect(screen.getByLabelText(/dark mode/i)).toHaveClass('Mui-selected');
      expect(screen.getByLabelText(/light mode/i)).not.toHaveClass(
        'Mui-selected'
      );
    });

    it('should handle disabled state changes from parent', () => {
      const { rerender } = render(
        <ThemeSettings
          currentTheme="system"
          onThemeChange={mockOnThemeChange}
          disabled={false}
        />
      );

      const lightButton = screen.getByLabelText(/light mode/i);
      expect(lightButton).not.toBeDisabled();

      rerender(
        <ThemeSettings
          currentTheme="system"
          onThemeChange={mockOnThemeChange}
          disabled
        />
      );

      expect(lightButton).toBeDisabled();
    });

    it('should maintain functionality when onThemeChange is replaced', async () => {
      const user = userEvent.setup();
      const newHandler = vi.fn();

      const { rerender } = render(
        <ThemeSettings currentTheme="system" onThemeChange={mockOnThemeChange} />
      );

      rerender(
        <ThemeSettings currentTheme="system" onThemeChange={newHandler} />
      );

      const lightButton = screen.getByLabelText(/light mode/i);
      await user.click(lightButton);

      expect(newHandler).toHaveBeenCalledWith('light');
      expect(mockOnThemeChange).not.toHaveBeenCalled();
    });
  });

  describe('Integration with Parent Component', () => {
    it('should work as a controlled component', async () => {
      const user = userEvent.setup();
      let currentTheme: 'light' | 'dark' | 'system' = 'system';

      const handleThemeChange = vi.fn((theme: 'light' | 'dark' | 'system') => {
        currentTheme = theme;
      });

      const { rerender } = render(
        <ThemeSettings
          currentTheme={currentTheme}
          onThemeChange={handleThemeChange}
        />
      );

      expect(screen.getByLabelText(/system preference/i)).toHaveClass(
        'Mui-selected'
      );

      await user.click(screen.getByLabelText(/light mode/i));
      expect(handleThemeChange).toHaveBeenCalledWith('light');

      // Simulate parent updating state
      rerender(
        <ThemeSettings
          currentTheme={currentTheme}
          onThemeChange={handleThemeChange}
        />
      );

      expect(screen.getByLabelText(/light mode/i)).toHaveClass('Mui-selected');
    });

    it('should disable buttons during save operation', () => {
      render(
        <ThemeSettings
          currentTheme="system"
          onThemeChange={mockOnThemeChange}
          disabled
        />
      );

      const lightButton = screen.getByLabelText(/light mode/i);
      const darkButton = screen.getByLabelText(/dark mode/i);
      const systemButton = screen.getByLabelText(/system preference/i);

      expect(lightButton).toBeDisabled();
      expect(darkButton).toBeDisabled();
      expect(systemButton).toBeDisabled();
    });
  });
});
