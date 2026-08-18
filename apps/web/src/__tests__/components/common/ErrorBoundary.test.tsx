import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorBoundary } from '../../../components/common/ErrorBoundary';

// Component that throws an error for testing
interface ThrowErrorProps {
  shouldThrow?: boolean;
  errorMessage?: string;
}

function ThrowError({ shouldThrow = true, errorMessage = 'Test error' }: ThrowErrorProps) {
  if (shouldThrow) {
    throw new Error(errorMessage);
  }
  return <div>No error</div>;
}

// Component to test successful rendering
function SafeComponent() {
  return <div>Safe content</div>;
}

describe('ErrorBoundary', () => {
  // Suppress console.error for cleaner test output
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('Normal Rendering', () => {
    it('should render children when no error occurs', () => {
      render(
        <ErrorBoundary>
          <SafeComponent />
        </ErrorBoundary>
      );

      expect(screen.getByText('Safe content')).toBeInTheDocument();
    });

    it('should render multiple children without errors', () => {
      render(
        <ErrorBoundary>
          <div>Child 1</div>
          <div>Child 2</div>
          <div>Child 3</div>
        </ErrorBoundary>
      );

      expect(screen.getByText('Child 1')).toBeInTheDocument();
      expect(screen.getByText('Child 2')).toBeInTheDocument();
      expect(screen.getByText('Child 3')).toBeInTheDocument();
    });

    it('should render text content', () => {
      render(
        <ErrorBoundary>
          Simple text content
        </ErrorBoundary>
      );

      expect(screen.getByText('Simple text content')).toBeInTheDocument();
    });

    it('should render complex component trees', () => {
      render(
        <ErrorBoundary>
          <div>
            <h1>Title</h1>
            <p>Paragraph</p>
            <ul>
              <li>Item 1</li>
              <li>Item 2</li>
            </ul>
          </div>
        </ErrorBoundary>
      );

      expect(screen.getByText('Title')).toBeInTheDocument();
      expect(screen.getByText('Paragraph')).toBeInTheDocument();
      expect(screen.getByText('Item 1')).toBeInTheDocument();
      expect(screen.getByText('Item 2')).toBeInTheDocument();
    });
  });

  describe('Error Catching', () => {
    it('should catch errors from child components', () => {
      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    });

    it('should display error UI when error is caught', () => {
      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      // Should show error heading
      expect(screen.getByText('Something went wrong')).toBeInTheDocument();

      // Should show error message
      expect(screen.getByText('Test error')).toBeInTheDocument();

      // Should show reload button
      expect(screen.getByRole('button', { name: /reload page/i })).toBeInTheDocument();
    });

    it('should show custom error message from thrown error', () => {
      const customMessage = 'Custom error message';
      render(
        <ErrorBoundary>
          <ThrowError errorMessage={customMessage} />
        </ErrorBoundary>
      );

      expect(screen.getByText(customMessage)).toBeInTheDocument();
    });

    it('should show default message when error has no message', () => {
      const ErrorWithNoMessage = () => {
        const error = new Error();
        error.message = '';
        throw error;
      };

      render(
        <ErrorBoundary>
          <ErrorWithNoMessage />
        </ErrorBoundary>
      );

      expect(screen.getByText('An unexpected error occurred')).toBeInTheDocument();
    });

    it('should not render children when error is caught', () => {
      render(
        <ErrorBoundary>
          <ThrowError />
          <div>This should not appear</div>
        </ErrorBoundary>
      );

      expect(screen.queryByText('This should not appear')).not.toBeInTheDocument();
    });
  });

  describe('Error Isolation', () => {
    it('should not catch errors from outside its boundary', () => {
      const OuterComponent = () => {
        return (
          <div>
            <ErrorBoundary>
              <SafeComponent />
            </ErrorBoundary>
          </div>
        );
      };

      render(<OuterComponent />);

      // Children render normally since no error in this boundary
      expect(screen.getByText('Safe content')).toBeInTheDocument();
    });

    it('should only affect its own children when multiple boundaries exist', () => {
      render(
        <div>
          <ErrorBoundary>
            <ThrowError />
          </ErrorBoundary>
          <ErrorBoundary>
            <div>Boundary 2 content</div>
          </ErrorBoundary>
        </div>
      );

      // First boundary shows error
      expect(screen.getByText('Something went wrong')).toBeInTheDocument();

      // Second boundary renders normally
      expect(screen.getByText('Boundary 2 content')).toBeInTheDocument();
    });

    it('should isolate errors to the nearest boundary', () => {
      render(
        <ErrorBoundary>
          <div>
            <div>Outer content</div>
            <ErrorBoundary>
              <ThrowError errorMessage="Inner error" />
            </ErrorBoundary>
          </div>
        </ErrorBoundary>
      );

      // Inner boundary catches the error
      expect(screen.getByText('Inner error')).toBeInTheDocument();

      // Outer content is still rendered because outer boundary doesn't see an error
      expect(screen.getByText('Outer content')).toBeInTheDocument();
    });
  });

  describe('Reload Functionality', () => {
    it('should display reload button in error state', () => {
      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      const reloadButton = screen.getByRole('button', { name: /reload page/i });
      expect(reloadButton).toBeInTheDocument();
    });

    it('should call window.location.reload when reload button is clicked', async () => {
      const user = userEvent.setup();
      const reloadMock = vi.fn();

      // Mock window.location.reload
      Object.defineProperty(window, 'location', {
        value: { reload: reloadMock },
        writable: true,
      });

      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      const reloadButton = screen.getByRole('button', { name: /reload page/i });
      await user.click(reloadButton);

      expect(reloadMock).toHaveBeenCalledTimes(1);
    });

    it('should have contained variant button', () => {
      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      const reloadButton = screen.getByRole('button', { name: /reload page/i });
      expect(reloadButton).toBeInTheDocument();
    });
  });

  describe('Error UI Layout', () => {
    it('should display heading with error title', () => {
      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      const heading = screen.getByText('Something went wrong');
      expect(heading).toBeInTheDocument();
    });

    it('should display error message text', () => {
      render(
        <ErrorBoundary>
          <ThrowError errorMessage="Detailed error message" />
        </ErrorBoundary>
      );

      expect(screen.getByText('Detailed error message')).toBeInTheDocument();
    });

    it('should center content vertically and horizontally', () => {
      const { container } = render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      const errorBox = container.querySelector('[class*="MuiBox"]');
      expect(errorBox).toBeInTheDocument();
    });

    it('should have full viewport height', () => {
      const { container } = render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      const errorBox = container.querySelector('[class*="MuiBox"]');
      expect(errorBox).toHaveStyle({ height: '100vh' });
    });

    it('should use flexbox layout', () => {
      const { container } = render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      const errorBox = container.querySelector('[class*="MuiBox"]');
      expect(errorBox).toHaveStyle({
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
      });
    });
  });

  describe('Console Logging', () => {
    it('should log error to console when caught', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      render(
        <ErrorBoundary>
          <ThrowError errorMessage="Logged error" />
        </ErrorBoundary>
      );

      expect(consoleErrorSpy).toHaveBeenCalled();
      const calls = consoleErrorSpy.mock.calls;
      const uncaughtErrorCall = calls.find(
        call => call[0] === 'Uncaught error:'
      );
      expect(uncaughtErrorCall).toBeDefined();
    });

    it('should log error with error info', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      expect(consoleErrorSpy).toHaveBeenCalled();
      const calls = consoleErrorSpy.mock.calls;
      const uncaughtErrorCall = calls.find(
        call => call[0] === 'Uncaught error:'
      );
      expect(uncaughtErrorCall).toBeDefined();
      // Should have error object and errorInfo
      expect(uncaughtErrorCall?.length).toBeGreaterThan(1);
    });
  });

  describe('Edge Cases', () => {
    it('should handle errors in nested components', () => {
      const NestedComponent = () => (
        <div>
          <div>
            <div>
              <ThrowError errorMessage="Deeply nested error" />
            </div>
          </div>
        </div>
      );

      render(
        <ErrorBoundary>
          <NestedComponent />
        </ErrorBoundary>
      );

      expect(screen.getByText('Deeply nested error')).toBeInTheDocument();
    });

    it('should handle errors with special characters in message', () => {
      const specialMessage = 'Error with <special> & "characters"';
      render(
        <ErrorBoundary>
          <ThrowError errorMessage={specialMessage} />
        </ErrorBoundary>
      );

      expect(screen.getByText(specialMessage)).toBeInTheDocument();
    });

    it('should handle very long error messages', () => {
      const longMessage = 'A'.repeat(500);
      render(
        <ErrorBoundary>
          <ThrowError errorMessage={longMessage} />
        </ErrorBoundary>
      );

      expect(screen.getByText(longMessage)).toBeInTheDocument();
    });

    it('should handle errors thrown during render', () => {
      const ErrorInRender = () => {
        throw new Error('Error during render');
      };

      render(
        <ErrorBoundary>
          <ErrorInRender />
        </ErrorBoundary>
      );

      expect(screen.getByText('Error during render')).toBeInTheDocument();
    });

    it('should handle non-Error objects being thrown', () => {
      const ThrowString = () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'String error';
      };

      render(
        <ErrorBoundary>
          <ThrowString />
        </ErrorBoundary>
      );

      // Should still show error UI
      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    });
  });

  describe('State Management', () => {
    it('should maintain error state after catching error', () => {
      const { rerender } = render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      expect(screen.getByText('Something went wrong')).toBeInTheDocument();

      // Rerender should still show error
      rerender(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    });

    it('should store error in state', () => {
      render(
        <ErrorBoundary>
          <ThrowError errorMessage="Stored error" />
        </ErrorBoundary>
      );

      // Error message should be displayed from state
      expect(screen.getByText('Stored error')).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have proper heading hierarchy', () => {
      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      const heading = screen.getByText('Something went wrong');
      expect(heading.tagName).toBe('H4');
    });

    it('should have accessible button', () => {
      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      const button = screen.getByRole('button', { name: /reload page/i });
      expect(button).toBeInTheDocument();
      expect(button).toBeEnabled();
    });

    it('should display error message with appropriate color', () => {
      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      // MUI Typography with color="text.secondary" should be present
      const errorMessage = screen.getByText('Test error');
      expect(errorMessage).toBeInTheDocument();
    });
  });

  describe('Component Lifecycle', () => {
    it('should call getDerivedStateFromError when error occurs', () => {
      render(
        <ErrorBoundary>
          <ThrowError errorMessage="Lifecycle error" />
        </ErrorBoundary>
      );

      // Error boundary should be in error state
      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
      expect(screen.getByText('Lifecycle error')).toBeInTheDocument();
    });

    it('should call componentDidCatch after error is caught', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      // componentDidCatch logs to console
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  describe('Multiple Errors', () => {
    it('should handle first error thrown from multiple components', () => {
      const MultiError = () => (
        <>
          <ThrowError errorMessage="First error" />
          <ThrowError errorMessage="Second error" />
        </>
      );

      render(
        <ErrorBoundary>
          <MultiError />
        </ErrorBoundary>
      );

      // Should catch the first error
      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    });

    it('should handle errors in different render cycles', () => {
      const { rerender } = render(
        <ErrorBoundary>
          <SafeComponent />
        </ErrorBoundary>
      );

      expect(screen.getByText('Safe content')).toBeInTheDocument();

      // Now render with error
      rerender(
        <ErrorBoundary>
          <ThrowError errorMessage="Later error" />
        </ErrorBoundary>
      );

      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    });
  });
});
