import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, mockUser, mockAdminUser } from './utils/test-utils';
import { Box, Typography, Button } from '@mui/material';

// Example component for demonstration
function ExampleComponent({ onClick }: { onClick?: () => void }) {
  return (
    <Box>
      <Typography variant="h4">Example Component</Typography>
      <Button onClick={onClick}>Click Me</Button>
    </Box>
  );
}

describe('Example Component Test (Framework Demo)', () => {
  it('renders component with providers', () => {
    renderWithProviders(<ExampleComponent />);

    expect(screen.getByText('Example Component')).toBeInTheDocument();
  });

  it('handles user interactions', async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();

    renderWithProviders(<ExampleComponent onClick={handleClick} />);

    const button = screen.getByText('Click Me');
    await user.click(button);

    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('renders with authenticated user context', () => {
    renderWithProviders(<ExampleComponent />, {
      wrapperOptions: { authenticated: true, user: mockUser },
    });

    expect(screen.getByText('Example Component')).toBeInTheDocument();
  });

  it('renders with admin user context', () => {
    renderWithProviders(<ExampleComponent />, {
      wrapperOptions: { authenticated: true, user: mockAdminUser },
    });

    expect(screen.getByText('Example Component')).toBeInTheDocument();
  });

  it('renders with dark theme', () => {
    renderWithProviders(<ExampleComponent />, {
      wrapperOptions: { theme: 'dark' },
    });

    expect(screen.getByText('Example Component')).toBeInTheDocument();
  });

  it('renders at specific route', () => {
    renderWithProviders(<ExampleComponent />, {
      wrapperOptions: { route: '/some-path' },
    });

    expect(screen.getByText('Example Component')).toBeInTheDocument();
  });
});
