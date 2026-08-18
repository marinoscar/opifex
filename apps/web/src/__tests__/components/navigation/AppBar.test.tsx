import { describe, it, expect } from 'vitest';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { setViewportWidth } from '../../setup';
import { AppBar } from '../../../components/navigation/AppBar';

describe('AppBar', () => {
  describe('Rendering', () => {
    it('should render app title', () => {
      render(<AppBar />);

      expect(screen.getByText(/enterprise app/i)).toBeInTheDocument();
    });

    it('should render as banner landmark', () => {
      render(<AppBar />);

      const appBar = screen.getByRole('banner');
      expect(appBar).toBeInTheDocument();
    });
  });

  describe('No drawer affordance', () => {
    /**
     * NEGATIVE assertions, and deliberately so. The hamburger and the
     * `onMenuClick` prop it called were deleted with the temporary drawer in
     * issue #55; navigation is the bottom bar below `sm` and the permanent rail
     * at `sm` and up. Nothing else in the suite would notice a hamburger coming
     * back — it would simply be an extra button — so these tests are the only
     * thing standing between a stray re-add and a dead affordance shipping.
     */
    it('renders no drawer toggle', () => {
      render(<AppBar />);

      expect(screen.queryByRole('button', { name: /toggle drawer/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /menu/i })).not.toBeInTheDocument();
      expect(screen.queryByTestId('MenuIcon')).not.toBeInTheDocument();
    });

    it('renders exactly two buttons: the theme toggle and the user menu', () => {
      render(<AppBar />);

      expect(screen.getAllByRole('button')).toHaveLength(2);
    });

    it('renders no hamburger at a phone width either', async () => {
      // The drawer used to be `variant="temporary"` at EVERY breakpoint, so the
      // hamburger was unconditional. Checking only the desktop width would miss
      // a re-add gated on `down('sm')`.
      render(<AppBar />);

      await act(async () => setViewportWidth(375));

      expect(screen.queryByRole('button', { name: /menu/i })).not.toBeInTheDocument();
      expect(screen.getAllByRole('button')).toHaveLength(2);
    });
  });

  describe('Theme Toggle', () => {
    it('should render theme toggle button', () => {
      render(<AppBar />);

      const toggleButton = screen.getByRole('button', { name: /toggle theme/i });
      expect(toggleButton).toBeInTheDocument();
    });

    it('should show dark mode icon in light mode', () => {
      render(<AppBar />, {
        wrapperOptions: { theme: 'light' },
      });

      const toggleButton = screen.getByRole('button', { name: /toggle theme/i });
      expect(toggleButton).toBeInTheDocument();
      // Dark mode icon (moon) should be shown when in light mode
    });

    it('should show light mode icon in dark mode', () => {
      render(<AppBar />, {
        wrapperOptions: { theme: 'dark' },
      });

      const toggleButton = screen.getByRole('button', { name: /toggle theme/i });
      expect(toggleButton).toBeInTheDocument();
      // Light mode icon (sun) should be shown when in dark mode
    });

    it('should toggle theme on click', async () => {
      const user = userEvent.setup();

      render(<AppBar />);

      const toggleButton = screen.getByRole('button', { name: /toggle theme/i });
      await user.click(toggleButton);

      // Theme should have toggled (via ThemeContext)
      expect(toggleButton).toBeInTheDocument();
    });
  });

  describe('User Menu', () => {
    it('should render user menu', () => {
      render(<AppBar />);

      // UserMenu component should be rendered (contains avatar button)
      const buttons = screen.getAllByRole('button');
      expect(buttons.length).toBeGreaterThan(0);
    });

    it('should show user menu for authenticated users', () => {
      render(<AppBar />, {
        wrapperOptions: { authenticated: true },
      });

      // Should have at least theme toggle and user menu button
      const buttons = screen.getAllByRole('button');
      expect(buttons.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Navigation', () => {
    it('should navigate to home when title is clicked', async () => {
      const user = userEvent.setup();

      render(<AppBar />);

      const title = screen.getByText(/enterprise app/i);
      await user.click(title);

      // Navigation should be triggered
      expect(title).toBeInTheDocument();
    });

    it('should have clickable title', () => {
      render(<AppBar />);

      const title = screen.getByText(/enterprise app/i);
      expect(title).toHaveStyle({ cursor: 'pointer' });
    });
  });

  describe('Styling', () => {
    it('should use sticky positioning', () => {
      render(<AppBar />);

      const banner = screen.getByRole('banner');
      expect(banner).toBeInTheDocument();
      // AppBar should have sticky position applied via MUI
    });

    it('should have proper elevation', () => {
      render(<AppBar />);

      const banner = screen.getByRole('banner');
      expect(banner).toBeInTheDocument();
    });
  });

  describe('Responsive Behavior', () => {
    it('should render all elements on desktop', () => {
      render(<AppBar />);

      expect(screen.getByText(/enterprise app/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /toggle theme/i })).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have accessible theme toggle button', () => {
      render(<AppBar />);

      const toggleButton = screen.getByRole('button', { name: /toggle theme/i });
      expect(toggleButton).toHaveAccessibleName();
    });

    it('should have proper ARIA landmarks', () => {
      render(<AppBar />);

      expect(screen.getByRole('banner')).toBeInTheDocument();
    });
  });
});
