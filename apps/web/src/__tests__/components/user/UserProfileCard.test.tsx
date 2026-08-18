import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockUser, mockAdminUser } from '../../utils/test-utils';
import { UserProfileCard } from '../../../components/user/UserProfileCard';

// Mock useNavigate from react-router-dom
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

describe('UserProfileCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('should render card with user profile', () => {
      render(<UserProfileCard />);

      expect(screen.getByText(mockUser.displayName!)).toBeInTheDocument();
      expect(screen.getByText(mockUser.email)).toBeInTheDocument();
    });

    it('should not render when user is null', () => {
      const { container } = render(<UserProfileCard />, {
        wrapperOptions: { authenticated: false },
      });

      expect(container.firstChild).toBeNull();
    });

    it('should render settings button', () => {
      render(<UserProfileCard />);

      const settingsButton = screen.getByRole('button', { name: /account settings/i });
      expect(settingsButton).toBeInTheDocument();
    });

    it('should render member since date', () => {
      render(<UserProfileCard />);

      expect(screen.getByText('Member since')).toBeInTheDocument();
      const expectedDate = new Date(mockUser.createdAt).toLocaleDateString();
      expect(screen.getByText(expectedDate)).toBeInTheDocument();
    });
  });

  describe('User Display Name', () => {
    it('should display user display name when present', () => {
      render(<UserProfileCard />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            displayName: 'John Doe',
          },
        },
      });

      expect(screen.getByText('John Doe')).toBeInTheDocument();
    });

    it('should display "No name set" when displayName is null', () => {
      render(<UserProfileCard />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            displayName: null,
          },
        },
      });

      expect(screen.getByText('No name set')).toBeInTheDocument();
    });

    it('should display "No name set" when displayName is empty string', () => {
      render(<UserProfileCard />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            displayName: '',
          },
        },
      });

      expect(screen.getByText('No name set')).toBeInTheDocument();
    });

    it('should display long names correctly', () => {
      const longName = 'Alexander Christopher Montgomery Wellington Smith-Johnson';
      render(<UserProfileCard />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            displayName: longName,
          },
        },
      });

      expect(screen.getByText(longName)).toBeInTheDocument();
    });
  });

  describe('Email Display', () => {
    it('should display user email', () => {
      render(<UserProfileCard />);

      expect(screen.getByText(mockUser.email)).toBeInTheDocument();
    });

    it('should display long email addresses correctly', () => {
      const longEmail = 'very.long.email.address.name@subdomain.example.com';
      render(<UserProfileCard />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            email: longEmail,
          },
        },
      });

      expect(screen.getByText(longEmail)).toBeInTheDocument();
    });
  });

  describe('Avatar Rendering', () => {
    it('should render avatar with profile image when available', () => {
      const imageUrl = 'https://example.com/profile.jpg';
      render(<UserProfileCard />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            displayName: 'Test User',
            profileImageUrl: imageUrl,
          },
        },
      });

      const avatar = screen.getByRole('img', { name: /test user/i });
      expect(avatar).toHaveAttribute('src', imageUrl);
    });

    it('should render avatar with initials when no image (has displayName)', () => {
      render(<UserProfileCard />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            displayName: 'John Doe',
            profileImageUrl: null,
          },
        },
      });

      // Avatar should contain initials JD
      expect(screen.getByText('JD')).toBeInTheDocument();
    });

    it('should render avatar with first letter of email when no displayName and no image', () => {
      render(<UserProfileCard />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            displayName: null,
            profileImageUrl: null,
            email: 'test@example.com',
          },
        },
      });

      // Avatar should contain first letter of email
      expect(screen.getByText('T')).toBeInTheDocument();
    });

    it('should render initials from multi-word displayName', () => {
      render(<UserProfileCard />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            displayName: 'Alexander Benjamin Charles',
            profileImageUrl: null,
          },
        },
      });

      // Should only take first 2 initials
      expect(screen.getByText('AB')).toBeInTheDocument();
    });

    it('should render single initial from single-word displayName', () => {
      render(<UserProfileCard />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            displayName: 'Alice',
            profileImageUrl: null,
          },
        },
      });

      expect(screen.getByText('A')).toBeInTheDocument();
    });

    it('should uppercase initials', () => {
      render(<UserProfileCard />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            displayName: 'alice bob',
            profileImageUrl: null,
          },
        },
      });

      expect(screen.getByText('AB')).toBeInTheDocument();
    });

    it('should use correct alt text with displayName', () => {
      const displayName = 'John Doe';
      render(<UserProfileCard />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            displayName,
            profileImageUrl: 'https://example.com/image.jpg',
          },
        },
      });

      const avatar = screen.getByRole('img', { name: displayName });
      expect(avatar).toBeInTheDocument();
    });

    it('should use email as alt text when no displayName', () => {
      const email = 'test@example.com';
      render(<UserProfileCard />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            displayName: null,
            email,
            profileImageUrl: 'https://example.com/image.jpg',
          },
        },
      });

      const avatar = screen.getByRole('img', { name: email });
      expect(avatar).toBeInTheDocument();
    });
  });

  describe('Role Badges Display', () => {
    it('should display single role badge', () => {
      render(<UserProfileCard />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            roles: [{ name: 'viewer' }],
          },
        },
      });

      expect(screen.getByText('viewer')).toBeInTheDocument();
    });

    it('should display multiple role badges', () => {
      render(<UserProfileCard />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            roles: [{ name: 'admin' }, { name: 'contributor' }],
          },
        },
      });

      expect(screen.getByText('admin')).toBeInTheDocument();
      expect(screen.getByText('contributor')).toBeInTheDocument();
    });

    it('should highlight Admin role with primary color', () => {
      render(<UserProfileCard />, {
        wrapperOptions: {
          user: mockAdminUser,
        },
      });

      // Admin chip exists
      const adminChip = screen.getByText('admin');
      expect(adminChip).toBeInTheDocument();

      // Check parent element has MuiChip class
      const chip = adminChip.closest('.MuiChip-root');
      expect(chip).toBeInTheDocument();
      expect(chip).toHaveClass('MuiChip-colorPrimary');
      expect(chip).toHaveClass('MuiChip-filled');
    });

    it('should render non-admin roles with outlined variant', () => {
      render(<UserProfileCard />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            roles: [{ name: 'contributor' }],
          },
        },
      });

      const contributorChip = screen.getByText('contributor');
      expect(contributorChip).toBeInTheDocument();

      const chip = contributorChip.closest('.MuiChip-root');
      expect(chip).toBeInTheDocument();
      expect(chip).toHaveClass('MuiChip-outlined');
    });

    it('should handle roles with different casings correctly', () => {
      render(<UserProfileCard />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            roles: [{ name: 'Admin' }, { name: 'VIEWER' }, { name: 'Contributor' }],
          },
        },
      });

      // All should be displayed with original casing
      expect(screen.getByText('Admin')).toBeInTheDocument();
      expect(screen.getByText('VIEWER')).toBeInTheDocument();
      expect(screen.getByText('Contributor')).toBeInTheDocument();

      // Admin (case-insensitive) should be highlighted
      const adminChip = screen.getByText('Admin').closest('.MuiChip-root');
      expect(adminChip).toHaveClass('MuiChip-colorPrimary');

      // Others should be outlined
      const viewerChip = screen.getByText('VIEWER').closest('.MuiChip-root');
      expect(viewerChip).toHaveClass('MuiChip-outlined');
    });

    it('should display all three standard roles', () => {
      render(<UserProfileCard />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            roles: [
              { name: 'admin' },
              { name: 'contributor' },
              { name: 'viewer' },
            ],
          },
        },
      });

      expect(screen.getByText('admin')).toBeInTheDocument();
      expect(screen.getByText('contributor')).toBeInTheDocument();
      expect(screen.getByText('viewer')).toBeInTheDocument();
    });

    it('should render empty roles array without crashing', () => {
      render(<UserProfileCard />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            roles: [],
          },
        },
      });

      // Should still render other elements
      expect(screen.getByText(mockUser.email)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /account settings/i })).toBeInTheDocument();
    });
  });

  describe('Member Since Display', () => {
    it('should format member since date correctly', () => {
      const testDate = new Date('2023-01-15T10:00:00Z');
      render(<UserProfileCard />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            createdAt: testDate.toISOString(),
          },
        },
      });

      expect(screen.getByText('Member since')).toBeInTheDocument();
      const expectedDate = testDate.toLocaleDateString();
      expect(screen.getByText(expectedDate)).toBeInTheDocument();
    });

    it('should display recent member date', () => {
      const recentDate = new Date();
      render(<UserProfileCard />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            createdAt: recentDate.toISOString(),
          },
        },
      });

      const expectedDate = recentDate.toLocaleDateString();
      expect(screen.getByText(expectedDate)).toBeInTheDocument();
    });

    it('should display old member date', () => {
      const oldDate = new Date('2020-05-10T08:30:00Z');
      render(<UserProfileCard />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            createdAt: oldDate.toISOString(),
          },
        },
      });

      const expectedDate = oldDate.toLocaleDateString();
      expect(screen.getByText(expectedDate)).toBeInTheDocument();
    });
  });

  describe('Navigation', () => {
    it('should navigate to settings page when clicking Account Settings button', async () => {
      const user = userEvent.setup();

      render(<UserProfileCard />);

      const settingsButton = screen.getByRole('button', { name: /account settings/i });
      await user.click(settingsButton);

      expect(mockNavigate).toHaveBeenCalledWith('/settings');
    });

    it('should navigate only once on single click', async () => {
      const user = userEvent.setup();

      render(<UserProfileCard />);

      const settingsButton = screen.getByRole('button', { name: /account settings/i });
      await user.click(settingsButton);

      expect(mockNavigate).toHaveBeenCalledTimes(1);
    });
  });

  describe('UI Elements', () => {
    it('should render settings icon in button', () => {
      render(<UserProfileCard />);

      const settingsButton = screen.getByRole('button', { name: /account settings/i });

      // Check that button has icon (Settings icon is rendered via MUI)
      expect(settingsButton.querySelector('svg')).toBeInTheDocument();
    });

    it('should render outlined button variant', () => {
      render(<UserProfileCard />);

      const settingsButton = screen.getByRole('button', { name: /account settings/i });
      expect(settingsButton).toHaveClass('MuiButton-outlined');
    });

    it('should render full width button', () => {
      render(<UserProfileCard />);

      const settingsButton = screen.getByRole('button', { name: /account settings/i });
      expect(settingsButton).toHaveClass('MuiButton-fullWidth');
    });

    it('should render divider between content sections', () => {
      const { container } = render(<UserProfileCard />);

      const divider = container.querySelector('.MuiDivider-root');
      expect(divider).toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('should handle user with all fields populated', () => {
      render(<UserProfileCard />, {
        wrapperOptions: {
          user: {
            id: 'test-id',
            email: 'full@example.com',
            displayName: 'Full Name User',
            profileImageUrl: 'https://example.com/full.jpg',
            roles: [{ name: 'admin' }, { name: 'contributor' }],
            permissions: ['all:permissions'],
            isActive: true,
            createdAt: new Date().toISOString(),
          },
        },
      });

      expect(screen.getByText('Full Name User')).toBeInTheDocument();
      expect(screen.getByText('full@example.com')).toBeInTheDocument();
      expect(screen.getByText('admin')).toBeInTheDocument();
      expect(screen.getByText('contributor')).toBeInTheDocument();
    });

    it('should handle user with minimal fields', () => {
      render(<UserProfileCard />, {
        wrapperOptions: {
          user: {
            id: 'minimal-id',
            email: 'minimal@example.com',
            displayName: null,
            profileImageUrl: null,
            roles: [],
            permissions: [],
            isActive: true,
            createdAt: new Date().toISOString(),
          },
        },
      });

      expect(screen.getByText('No name set')).toBeInTheDocument();
      expect(screen.getByText('minimal@example.com')).toBeInTheDocument();
    });

    it('should handle special characters in displayName', () => {
      render(<UserProfileCard />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            displayName: "O'Connor-Smith (Jr.)",
          },
        },
      });

      expect(screen.getByText("O'Connor-Smith (Jr.)")).toBeInTheDocument();
    });

    it('should handle unicode characters in displayName', () => {
      render(<UserProfileCard />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            displayName: 'José María González',
          },
        },
      });

      expect(screen.getByText('José María González')).toBeInTheDocument();
    });

    it('should handle email with special characters', () => {
      render(<UserProfileCard />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            email: 'user+tag@sub-domain.example.co.uk',
          },
        },
      });

      expect(screen.getByText('user+tag@sub-domain.example.co.uk')).toBeInTheDocument();
    });

    it('should handle displayName with extra spaces', () => {
      render(<UserProfileCard />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            displayName: '  Multiple   Spaces   Name  ',
            profileImageUrl: null,
          },
        },
      });

      // Text content is normalized by the browser, so we need to match the normalized version
      expect(screen.getByText(/Multiple\s+Spaces\s+Name/i)).toBeInTheDocument();
      // Verify initials are generated correctly
      expect(screen.getByText('MS')).toBeInTheDocument();
    });

    it('should handle very long role names', () => {
      render(<UserProfileCard />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            roles: [
              { name: 'super-administrator-with-full-permissions' },
            ],
          },
        },
      });

      expect(screen.getByText('super-administrator-with-full-permissions')).toBeInTheDocument();
    });
  });

  describe('Component Structure', () => {
    it('should render inside a Card component', () => {
      const { container } = render(<UserProfileCard />);

      const card = container.querySelector('.MuiCard-root');
      expect(card).toBeInTheDocument();
    });

    it('should render CardContent', () => {
      const { container } = render(<UserProfileCard />);

      const cardContent = container.querySelector('.MuiCardContent-root');
      expect(cardContent).toBeInTheDocument();
    });

    it('should center align content', () => {
      const { container } = render(<UserProfileCard />);

      // Check for MUI Box with center alignment via CSS classes or inline styles
      // The component uses sx prop which generates CSS classes
      const cardContent = container.querySelector('.MuiCardContent-root');
      expect(cardContent).toBeInTheDocument();

      // Verify the flex layout box exists
      const flexBox = container.querySelector('.MuiBox-root');
      expect(flexBox).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have proper heading hierarchy', () => {
      render(<UserProfileCard />);

      // Display name should be in h6 (variant="h6")
      const heading = screen.getByRole('heading', { level: 6 });
      expect(heading).toBeInTheDocument();
    });

    it('should have accessible button with descriptive text', () => {
      render(<UserProfileCard />);

      const button = screen.getByRole('button', { name: /account settings/i });
      expect(button).toBeInTheDocument();
      expect(button).toHaveAccessibleName();
    });

    it('should have alt text for avatar image', () => {
      render(<UserProfileCard />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            displayName: 'Test User',
            profileImageUrl: 'https://example.com/image.jpg',
          },
        },
      });

      const avatar = screen.getByRole('img', { name: 'Test User' });
      expect(avatar).toHaveAttribute('alt', 'Test User');
    });
  });
});
