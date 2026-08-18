import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { AddEmailDialog } from '../../../components/admin/AddEmailDialog';

describe('AddEmailDialog', () => {
  const mockOnClose = vi.fn();
  const mockOnAdd = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockOnAdd.mockResolvedValue(undefined);
  });

  describe('Rendering', () => {
    it('should render when open=true', () => {
      render(
        <AddEmailDialog open={true} onClose={mockOnClose} onAdd={mockOnAdd} />,
      );

      expect(
        screen.getByRole('dialog', { name: /add email to allowlist/i }),
      ).toBeInTheDocument();
    });

    it('should not render when open=false', () => {
      render(
        <AddEmailDialog open={false} onClose={mockOnClose} onAdd={mockOnAdd} />,
      );

      expect(
        screen.queryByRole('dialog', { name: /add email to allowlist/i }),
      ).not.toBeInTheDocument();
    });

    it('should render email input field', () => {
      render(
        <AddEmailDialog open={true} onClose={mockOnClose} onAdd={mockOnAdd} />,
      );

      expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
    });

    it('should render notes input field', () => {
      render(
        <AddEmailDialog open={true} onClose={mockOnClose} onAdd={mockOnAdd} />,
      );

      expect(screen.getByLabelText(/notes \(optional\)/i)).toBeInTheDocument();
    });

    it('should render cancel button', () => {
      render(
        <AddEmailDialog open={true} onClose={mockOnClose} onAdd={mockOnAdd} />,
      );

      expect(
        screen.getByRole('button', { name: /cancel/i }),
      ).toBeInTheDocument();
    });

    it('should render submit button', () => {
      render(
        <AddEmailDialog open={true} onClose={mockOnClose} onAdd={mockOnAdd} />,
      );

      expect(
        screen.getByRole('button', { name: /add email/i }),
      ).toBeInTheDocument();
    });
  });

  describe('Email Validation', () => {
    it('should not call onAdd when email is empty', async () => {
      const user = userEvent.setup();

      render(
        <AddEmailDialog open={true} onClose={mockOnClose} onAdd={mockOnAdd} />,
      );

      const submitButton = screen.getByRole('button', { name: /add email/i });
      await user.click(submitButton);

      // Give it a moment for any async operations
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockOnAdd).not.toHaveBeenCalled();
    });

    it('should not call onAdd for invalid email format', async () => {
      const user = userEvent.setup();

      render(
        <AddEmailDialog open={true} onClose={mockOnClose} onAdd={mockOnAdd} />,
      );

      const emailInput = screen.getByLabelText(/email address/i);
      await user.type(emailInput, 'invalid-email');

      const submitButton = screen.getByRole('button', { name: /add email/i });
      await user.click(submitButton);

      // Give it a moment for any async operations
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockOnAdd).not.toHaveBeenCalled();
    });

    it('should accept valid email format', async () => {
      const user = userEvent.setup();

      render(
        <AddEmailDialog open={true} onClose={mockOnClose} onAdd={mockOnAdd} />,
      );

      const emailInput = screen.getByLabelText(/email address/i);
      await user.type(emailInput, 'valid@example.com');

      const submitButton = screen.getByRole('button', { name: /add email/i });
      await user.click(submitButton);

      await waitFor(() => {
        expect(mockOnAdd).toHaveBeenCalledWith('valid@example.com', undefined);
      });
    });

    it('should trim whitespace from email', async () => {
      const user = userEvent.setup();

      render(
        <AddEmailDialog open={true} onClose={mockOnClose} onAdd={mockOnAdd} />,
      );

      const emailInput = screen.getByLabelText(/email address/i);
      await user.type(emailInput, '  whitespace@example.com  ');

      const submitButton = screen.getByRole('button', { name: /add email/i });
      await user.click(submitButton);

      await waitFor(() => {
        expect(mockOnAdd).toHaveBeenCalledWith(
          'whitespace@example.com',
          undefined,
        );
      });
    });

    it('should validate email with plus sign', async () => {
      const user = userEvent.setup();

      render(
        <AddEmailDialog open={true} onClose={mockOnClose} onAdd={mockOnAdd} />,
      );

      const emailInput = screen.getByLabelText(/email address/i);
      await user.type(emailInput, 'user+tag@example.com');

      const submitButton = screen.getByRole('button', { name: /add email/i });
      await user.click(submitButton);

      await waitFor(() => {
        expect(mockOnAdd).toHaveBeenCalledWith('user+tag@example.com', undefined);
      });
    });
  });

  describe('Submit Functionality', () => {
    it('should call onAdd with correct params when form submitted', async () => {
      const user = userEvent.setup();

      render(
        <AddEmailDialog open={true} onClose={mockOnClose} onAdd={mockOnAdd} />,
      );

      const emailInput = screen.getByLabelText(/email address/i);
      const notesInput = screen.getByLabelText(/notes \(optional\)/i);

      await user.type(emailInput, 'test@example.com');
      await user.type(notesInput, 'Test note');

      const submitButton = screen.getByRole('button', { name: /add email/i });
      await user.click(submitButton);

      await waitFor(() => {
        expect(mockOnAdd).toHaveBeenCalledWith('test@example.com', 'Test note');
      });
    });

    it('should call onAdd with email only when notes empty', async () => {
      const user = userEvent.setup();

      render(
        <AddEmailDialog open={true} onClose={mockOnClose} onAdd={mockOnAdd} />,
      );

      const emailInput = screen.getByLabelText(/email address/i);
      await user.type(emailInput, 'test@example.com');

      const submitButton = screen.getByRole('button', { name: /add email/i });
      await user.click(submitButton);

      await waitFor(() => {
        expect(mockOnAdd).toHaveBeenCalledWith('test@example.com', undefined);
      });
    });

    it('should close dialog on successful submission', async () => {
      const user = userEvent.setup();

      render(
        <AddEmailDialog open={true} onClose={mockOnClose} onAdd={mockOnAdd} />,
      );

      const emailInput = screen.getByLabelText(/email address/i);
      await user.type(emailInput, 'test@example.com');

      const submitButton = screen.getByRole('button', { name: /add email/i });
      await user.click(submitButton);

      await waitFor(() => {
        expect(mockOnClose).toHaveBeenCalled();
      });
    });

    it('should reset form on successful submission', async () => {
      const user = userEvent.setup();

      const { rerender } = render(
        <AddEmailDialog open={true} onClose={mockOnClose} onAdd={mockOnAdd} />,
      );

      const emailInput = screen.getByLabelText(/email address/i);
      const notesInput = screen.getByLabelText(/notes \(optional\)/i);

      await user.type(emailInput, 'test@example.com');
      await user.type(notesInput, 'Test note');

      const submitButton = screen.getByRole('button', { name: /add email/i });
      await user.click(submitButton);

      await waitFor(() => {
        expect(mockOnClose).toHaveBeenCalled();
      });

      // Reopen dialog
      rerender(
        <AddEmailDialog open={true} onClose={mockOnClose} onAdd={mockOnAdd} />,
      );

      // Fields should be empty
      const newEmailInput = screen.getByLabelText(/email address/i);
      const newNotesInput = screen.getByLabelText(/notes \(optional\)/i);
      expect(newEmailInput).toHaveValue('');
      expect(newNotesInput).toHaveValue('');
    });

    it('should show error when submission fails', async () => {
      const user = userEvent.setup();
      mockOnAdd.mockRejectedValue(new Error('Failed to add email'));

      render(
        <AddEmailDialog open={true} onClose={mockOnClose} onAdd={mockOnAdd} />,
      );

      const emailInput = screen.getByLabelText(/email address/i);
      await user.type(emailInput, 'test@example.com');

      const submitButton = screen.getByRole('button', { name: /add email/i });
      await user.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText(/failed to add email/i)).toBeInTheDocument();
      });

      expect(mockOnClose).not.toHaveBeenCalled();
    });

    it('should not close dialog when submission fails', async () => {
      const user = userEvent.setup();
      mockOnAdd.mockRejectedValue(new Error('Network error'));

      render(
        <AddEmailDialog open={true} onClose={mockOnClose} onAdd={mockOnAdd} />,
      );

      const emailInput = screen.getByLabelText(/email address/i);
      await user.type(emailInput, 'test@example.com');

      const submitButton = screen.getByRole('button', { name: /add email/i });
      await user.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText(/network error/i)).toBeInTheDocument();
      });

      expect(mockOnClose).not.toHaveBeenCalled();
    });

    it('should trim whitespace from notes', async () => {
      const user = userEvent.setup();

      render(
        <AddEmailDialog open={true} onClose={mockOnClose} onAdd={mockOnAdd} />,
      );

      const emailInput = screen.getByLabelText(/email address/i);
      const notesInput = screen.getByLabelText(/notes \(optional\)/i);

      await user.type(emailInput, 'test@example.com');
      await user.type(notesInput, '  Whitespace notes  ');

      const submitButton = screen.getByRole('button', { name: /add email/i });
      await user.click(submitButton);

      await waitFor(() => {
        expect(mockOnAdd).toHaveBeenCalledWith(
          'test@example.com',
          'Whitespace notes',
        );
      });
    });
  });

  describe('Cancel Functionality', () => {
    it('should call onClose when cancel button clicked', async () => {
      const user = userEvent.setup();

      render(
        <AddEmailDialog open={true} onClose={mockOnClose} onAdd={mockOnAdd} />,
      );

      const cancelButton = screen.getByRole('button', { name: /cancel/i });
      await user.click(cancelButton);

      expect(mockOnClose).toHaveBeenCalled();
      expect(mockOnAdd).not.toHaveBeenCalled();
    });

    it('should reset form when cancelled', async () => {
      const user = userEvent.setup();

      const { rerender } = render(
        <AddEmailDialog open={true} onClose={mockOnClose} onAdd={mockOnAdd} />,
      );

      const emailInput = screen.getByLabelText(/email address/i);
      await user.type(emailInput, 'test@example.com');

      const cancelButton = screen.getByRole('button', { name: /cancel/i });
      await user.click(cancelButton);

      // Reopen dialog
      rerender(
        <AddEmailDialog open={true} onClose={mockOnClose} onAdd={mockOnAdd} />,
      );

      const newEmailInput = screen.getByLabelText(/email address/i);
      expect(newEmailInput).toHaveValue('');
    });
  });

  describe('Disabled State', () => {
    it('should disable inputs while submitting', async () => {
      const user = userEvent.setup();
      let resolveAdd: () => void;
      mockOnAdd.mockReturnValue(
        new Promise((resolve) => {
          resolveAdd = resolve;
        }),
      );

      render(
        <AddEmailDialog open={true} onClose={mockOnClose} onAdd={mockOnAdd} />,
      );

      const emailInput = screen.getByLabelText(/email address/i);
      await user.type(emailInput, 'test@example.com');

      const submitButton = screen.getByRole('button', { name: /add email/i });
      await user.click(submitButton);

      // Inputs should be disabled
      await waitFor(() => {
        expect(screen.getByLabelText(/email address/i)).toBeDisabled();
        expect(screen.getByLabelText(/notes \(optional\)/i)).toBeDisabled();
      });

      // Resolve the promise
      resolveAdd!();
    });

    it('should disable buttons while submitting', async () => {
      const user = userEvent.setup();
      let resolveAdd: () => void;
      mockOnAdd.mockReturnValue(
        new Promise((resolve) => {
          resolveAdd = resolve;
        }),
      );

      render(
        <AddEmailDialog open={true} onClose={mockOnClose} onAdd={mockOnAdd} />,
      );

      const emailInput = screen.getByLabelText(/email address/i);
      await user.type(emailInput, 'test@example.com');

      const submitButton = screen.getByRole('button', { name: /add email/i });
      await user.click(submitButton);

      // Buttons should be disabled
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
        expect(
          screen.getByRole('button', { name: /adding/i }),
        ).toBeDisabled();
      });

      // Resolve the promise
      resolveAdd!();
    });

    it('should show "Adding..." text while submitting', async () => {
      const user = userEvent.setup();
      let resolveAdd: () => void;
      mockOnAdd.mockReturnValue(
        new Promise((resolve) => {
          resolveAdd = resolve;
        }),
      );

      render(
        <AddEmailDialog open={true} onClose={mockOnClose} onAdd={mockOnAdd} />,
      );

      const emailInput = screen.getByLabelText(/email address/i);
      await user.type(emailInput, 'test@example.com');

      const submitButton = screen.getByRole('button', { name: /add email/i });
      await user.click(submitButton);

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /adding/i }),
        ).toBeInTheDocument();
      });

      // Resolve the promise
      resolveAdd!();
    });

    it('should have cancel button disabled while submitting', async () => {
      const user = userEvent.setup();
      let resolveAdd: () => void;
      mockOnAdd.mockReturnValue(
        new Promise((resolve) => {
          resolveAdd = resolve;
        }),
      );

      render(
        <AddEmailDialog open={true} onClose={mockOnClose} onAdd={mockOnAdd} />,
      );

      const emailInput = screen.getByLabelText(/email address/i);
      await user.type(emailInput, 'test@example.com');

      const submitButton = screen.getByRole('button', { name: /add email/i });
      await user.click(submitButton);

      // Cancel button should be disabled while submitting
      await waitFor(() => {
        const cancelButton = screen.getByRole('button', { name: /cancel/i });
        expect(cancelButton).toBeDisabled();
      });

      // Resolve the promise
      resolveAdd!();
    });
  });

  describe('Error Display', () => {
    it('should display custom error message from exception', async () => {
      const user = userEvent.setup();
      mockOnAdd.mockRejectedValue(
        new Error('Email already exists in allowlist'),
      );

      render(
        <AddEmailDialog open={true} onClose={mockOnClose} onAdd={mockOnAdd} />,
      );

      const emailInput = screen.getByLabelText(/email address/i);
      await user.type(emailInput, 'duplicate@example.com');

      const submitButton = screen.getByRole('button', { name: /add email/i });
      await user.click(submitButton);

      await waitFor(
        () => {
          expect(
            screen.getByText(/email already exists in allowlist/i),
          ).toBeInTheDocument();
        },
        { timeout: 3000 },
      );
    });
  });

  describe('Form Submission', () => {
    it('should submit form when Enter key pressed in email field', async () => {
      const user = userEvent.setup();

      render(
        <AddEmailDialog open={true} onClose={mockOnClose} onAdd={mockOnAdd} />,
      );

      const emailInput = screen.getByLabelText(/email address/i);
      await user.type(emailInput, 'test@example.com{Enter}');

      await waitFor(() => {
        expect(mockOnAdd).toHaveBeenCalledWith('test@example.com', undefined);
      });
    });
  });
});
