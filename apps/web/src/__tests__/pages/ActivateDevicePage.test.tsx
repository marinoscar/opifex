import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils/test-utils';
import ActivateDevicePage from '../../pages/ActivateDevicePage';
import type { DeviceActivationInfo, DeviceAuthorizationResponse } from '../../types';

// Use wildcard pattern to match API requests
const API_BASE = '*/api';

// Helper to create API error responses
function createErrorResponse(message: string, status: number, code?: string) {
  return HttpResponse.json(
    { message, code },
    { status }
  );
}

describe('ActivateDevicePage', () => {
  const mockDeviceInfo: DeviceActivationInfo = {
    userCode: 'ABCD-1234',
    clientInfo: {
      deviceName: 'My Smart TV',
      userAgent: 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36',
      ipAddress: '192.168.1.100',
    },
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 minutes from now
  };

  beforeEach(() => {
    // Reset any MSW handlers to defaults
    server.resetHandlers();
  });

  afterEach(() => {
    // Clean up any timers
    vi.clearAllTimers();
  });

  describe('Rendering', () => {
    it('should render page title', () => {
      render(<ActivateDevicePage />);

      expect(screen.getByRole('heading', { name: /authorize device/i })).toBeInTheDocument();
    });

    it('should render page description', () => {
      render(<ActivateDevicePage />);

      expect(screen.getByText(/link a device to your account/i)).toBeInTheDocument();
    });

    it('should render device code input in initial step', () => {
      render(<ActivateDevicePage />);

      expect(screen.getByLabelText(/device code/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /verify code/i })).toBeInTheDocument();
    });
  });

  describe('Device Code Input Handling', () => {
    it('should accept manual code input', async () => {
      const user = userEvent.setup({ delay: null });
      render(<ActivateDevicePage />);

      const input = screen.getByLabelText(/device code/i);
      await user.type(input, 'ABCD1234');

      expect(input).toHaveValue('ABCD-1234');
    });

    it('should format code with dash automatically', async () => {
      const user = userEvent.setup({ delay: null });
      render(<ActivateDevicePage />);

      const input = screen.getByLabelText(/device code/i);
      await user.type(input, 'test5678');

      expect(input).toHaveValue('TEST-5678');
    });

    it('should pre-fill code from URL query parameter', () => {
      render(<ActivateDevicePage />, {
        wrapperOptions: {
          route: '/activate-device?code=WXYZ-9876',
        },
      });

      const input = screen.getByLabelText(/device code/i);
      expect(input).toHaveValue('WXYZ-9876');
    });

    it('should auto-verify when code is provided in URL', async () => {
      render(<ActivateDevicePage />, {
        wrapperOptions: {
          route: '/activate-device?code=ABCD-1234',
        },
      });

      await waitFor(() => {
        expect(screen.getByText(/a device is requesting access/i)).toBeInTheDocument();
      });
    });

    it('should disable verify button when code is incomplete', async () => {
      const user = userEvent.setup({ delay: null });
      render(<ActivateDevicePage />);

      const input = screen.getByLabelText(/device code/i);
      await user.type(input, 'ABC');

      const verifyButton = screen.getByRole('button', { name: /verify code/i });
      expect(verifyButton).toBeDisabled();
    });

    it('should enable verify button when code is complete', async () => {
      const user = userEvent.setup({ delay: null });
      render(<ActivateDevicePage />);

      const input = screen.getByLabelText(/device code/i);
      await user.type(input, 'ABCD1234');

      const verifyButton = screen.getByRole('button', { name: /verify code/i });
      expect(verifyButton).toBeEnabled();
    });
  });

  describe('Code Verification Flow', () => {
    it('should verify code and transition to review step', async () => {
      const user = userEvent.setup({ delay: null });

      render(<ActivateDevicePage />);

      const input = screen.getByLabelText(/device code/i);
      await user.type(input, 'ABCD1234');

      const verifyButton = screen.getByRole('button', { name: /verify code/i });
      await user.click(verifyButton);

      await waitFor(() => {
        expect(screen.getByText(/a device is requesting access/i)).toBeInTheDocument();
      });
    });

    it('should display device information after verification', async () => {
      const user = userEvent.setup({ delay: null });

      render(<ActivateDevicePage />);

      const input = screen.getByLabelText(/device code/i);
      await user.type(input, 'ABCD1234');

      const verifyButton = screen.getByRole('button', { name: /verify code/i });
      await user.click(verifyButton);

      await waitFor(() => {
        expect(screen.getByText('My Smart TV')).toBeInTheDocument();
        expect(screen.getByText('192.168.1.100')).toBeInTheDocument();
        expect(screen.getByText(/Mozilla.*Android/)).toBeInTheDocument();
      });
    });

    it('should show loading state while verifying', async () => {
      const user = userEvent.setup({ delay: null });

      // Mock a delayed response
      server.use(
        http.get(`${API_BASE}/auth/device/activate`, async () => {
          await new Promise(resolve => setTimeout(resolve, 100));
          return HttpResponse.json({
            data: mockDeviceInfo,
          });
        })
      );

      render(<ActivateDevicePage />);

      const input = screen.getByLabelText(/device code/i);
      await user.type(input, 'ABCD1234');

      const verifyButton = screen.getByRole('button', { name: /verify code/i });
      await user.click(verifyButton);

      expect(screen.getByText(/verifying/i)).toBeInTheDocument();
      expect(verifyButton).toBeDisabled();

      await waitFor(() => {
        expect(screen.getByText(/a device is requesting access/i)).toBeInTheDocument();
      });
    });
  });

  describe('Error Handling', () => {
    it('should display error for invalid code (404)', async () => {
      const user = userEvent.setup({ delay: null });

      server.use(
        http.get(`${API_BASE}/auth/device/activate`, () => {
          return createErrorResponse('Not found', 404, 'DEVICE_CODE_NOT_FOUND');
        })
      );

      render(<ActivateDevicePage />);

      const input = screen.getByLabelText(/device code/i);
      await user.type(input, 'INVALID1');

      const verifyButton = screen.getByRole('button', { name: /verify code/i });
      await user.click(verifyButton);

      await waitFor(() => {
        expect(screen.getByText(/invalid code.*please check and try again/i)).toBeInTheDocument();
      });
    });

    it('should display error for expired code (410)', async () => {
      const user = userEvent.setup({ delay: null });

      server.use(
        http.get(`${API_BASE}/auth/device/activate`, () => {
          return createErrorResponse('Code expired', 410, 'DEVICE_CODE_EXPIRED');
        })
      );

      render(<ActivateDevicePage />);

      const input = screen.getByLabelText(/device code/i);
      await user.type(input, 'EXPIRED1');

      const verifyButton = screen.getByRole('button', { name: /verify code/i });
      await user.click(verifyButton);

      await waitFor(() => {
        expect(screen.getByText(/this code has expired.*please request a new one/i)).toBeInTheDocument();
      });
    });

    it('should display error for bad request (400)', async () => {
      const user = userEvent.setup({ delay: null });

      server.use(
        http.get(`${API_BASE}/auth/device/activate`, () => {
          return createErrorResponse('Bad request', 400);
        })
      );

      render(<ActivateDevicePage />);

      const input = screen.getByLabelText(/device code/i);
      await user.type(input, 'BADREQ01');

      const verifyButton = screen.getByRole('button', { name: /verify code/i });
      await user.click(verifyButton);

      await waitFor(() => {
        expect(screen.getByText(/invalid code.*please check and try again/i)).toBeInTheDocument();
      });
    });

    it('should display generic error for other API errors', async () => {
      const user = userEvent.setup({ delay: null });

      server.use(
        http.get(`${API_BASE}/auth/device/activate`, () => {
          return createErrorResponse('Internal server error', 500);
        })
      );

      render(<ActivateDevicePage />);

      const input = screen.getByLabelText(/device code/i);
      await user.type(input, 'ERROR500');

      const verifyButton = screen.getByRole('button', { name: /verify code/i });
      await user.click(verifyButton);

      await waitFor(() => {
        expect(screen.getByText(/internal server error/i)).toBeInTheDocument();
      });
    });

    it('should display network error for non-API errors', async () => {
      const user = userEvent.setup({ delay: null });

      server.use(
        http.get(`${API_BASE}/auth/device/activate`, () => {
          return HttpResponse.error();
        })
      );

      render(<ActivateDevicePage />);

      const input = screen.getByLabelText(/device code/i);
      await user.type(input, 'NETWORK1');

      const verifyButton = screen.getByRole('button', { name: /verify code/i });
      await user.click(verifyButton);

      await waitFor(() => {
        expect(screen.getByText(/network error.*please check your connection/i)).toBeInTheDocument();
      });
    });

    it('should clear previous errors when verifying again', async () => {
      const user = userEvent.setup({ delay: null });

      // First attempt fails
      server.use(
        http.get(`${API_BASE}/auth/device/activate`, () => {
          return createErrorResponse('Not found', 404);
        })
      );

      render(<ActivateDevicePage />);

      const input = screen.getByLabelText(/device code/i);
      await user.clear(input);
      await user.type(input, 'INVALID1');

      let verifyButton = screen.getByRole('button', { name: /verify code/i });
      await user.click(verifyButton);

      await waitFor(() => {
        expect(screen.getByText(/invalid code/i)).toBeInTheDocument();
      });

      // Second attempt succeeds - reset to default handler
      server.resetHandlers();

      await user.clear(input);
      await user.type(input, 'VALID123');

      verifyButton = screen.getByRole('button', { name: /verify code/i });
      await user.click(verifyButton);

      await waitFor(() => {
        expect(screen.queryByText(/invalid code/i)).not.toBeInTheDocument();
        expect(screen.getByText(/a device is requesting access/i)).toBeInTheDocument();
      });
    });
  });

  describe('Device Approval Flow', () => {
    it('should approve device successfully', async () => {
      const user = userEvent.setup({ delay: null });

      render(<ActivateDevicePage />, {
        wrapperOptions: {
          route: '/activate-device?code=ABCD-1234',
        },
      });

      // Wait for auto-verification
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
      });

      const approveButton = screen.getByRole('button', { name: /approve/i });
      await user.click(approveButton);

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /authorization complete/i })).toBeInTheDocument();
        expect(screen.getByText(/device authorized successfully!/i)).toBeInTheDocument();
      });
    });

    it('should show loading state while approving', async () => {
      const user = userEvent.setup({ delay: null });

      // Mock a delayed response
      server.use(
        http.post(`${API_BASE}/auth/device/authorize`, async () => {
          await new Promise(resolve => setTimeout(resolve, 100));
          return HttpResponse.json({
            data: { success: true, message: 'Success' },
          });
        })
      );

      render(<ActivateDevicePage />, {
        wrapperOptions: {
          route: '/activate-device?code=ABCD-1234',
        },
      });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
      });

      const approveButton = screen.getByRole('button', { name: /approve/i });
      await user.click(approveButton);

      expect(screen.getByText(/approving/i)).toBeInTheDocument();
      expect(approveButton).toBeDisabled();

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /authorization complete/i })).toBeInTheDocument();
      });
    });

    it('should display error when approval fails', async () => {
      const user = userEvent.setup({ delay: null });

      server.use(
        http.post(`${API_BASE}/auth/device/authorize`, () => {
          return createErrorResponse('Failed to authorize', 500);
        })
      );

      render(<ActivateDevicePage />, {
        wrapperOptions: {
          route: '/activate-device?code=ABCD-1234',
        },
      });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
      });

      const approveButton = screen.getByRole('button', { name: /approve/i });
      await user.click(approveButton);

      await waitFor(() => {
        expect(screen.getByText(/failed to authorize/i)).toBeInTheDocument();
      });

      // Should still be on review step
      expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
    });

    it('should handle network error during approval', async () => {
      const user = userEvent.setup({ delay: null });

      server.use(
        http.post(`${API_BASE}/auth/device/authorize`, () => {
          return HttpResponse.error();
        })
      );

      render(<ActivateDevicePage />, {
        wrapperOptions: {
          route: '/activate-device?code=ABCD-1234',
        },
      });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
      });

      const approveButton = screen.getByRole('button', { name: /approve/i });
      await user.click(approveButton);

      await waitFor(() => {
        expect(screen.getByText(/network error.*please check your connection/i)).toBeInTheDocument();
      });
    });
  });

  describe('Device Denial Flow', () => {
    it('should deny device successfully', async () => {
      const user = userEvent.setup({ delay: null });

      render(<ActivateDevicePage />, {
        wrapperOptions: {
          route: '/activate-device?code=ABCD-1234',
        },
      });

      // Wait for auto-verification
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /deny/i })).toBeInTheDocument();
      });

      const denyButton = screen.getByRole('button', { name: /deny/i });
      await user.click(denyButton);

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /authorization complete/i })).toBeInTheDocument();
      });

      expect(screen.getByRole('heading', { name: /device access denied/i })).toBeInTheDocument();
    });

    it('should show loading state while denying', async () => {
      const user = userEvent.setup({ delay: null });

      // Mock a delayed response
      server.use(
        http.post(`${API_BASE}/auth/device/authorize`, async () => {
          await new Promise(resolve => setTimeout(resolve, 100));
          return HttpResponse.json({
            data: { success: false, message: 'Denied' },
          });
        })
      );

      render(<ActivateDevicePage />, {
        wrapperOptions: {
          route: '/activate-device?code=ABCD-1234',
        },
      });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /deny/i })).toBeInTheDocument();
      });

      const denyButton = screen.getByRole('button', { name: /deny/i });
      await user.click(denyButton);

      expect(screen.getByText(/denying/i)).toBeInTheDocument();
      expect(denyButton).toBeDisabled();

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /authorization complete/i })).toBeInTheDocument();
      });
    });

    it('should display error when denial fails', async () => {
      const user = userEvent.setup({ delay: null });

      server.use(
        http.post(`${API_BASE}/auth/device/authorize`, () => {
          return createErrorResponse('Failed to process', 500);
        })
      );

      render(<ActivateDevicePage />, {
        wrapperOptions: {
          route: '/activate-device?code=ABCD-1234',
        },
      });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /deny/i })).toBeInTheDocument();
      });

      const denyButton = screen.getByRole('button', { name: /deny/i });
      await user.click(denyButton);

      await waitFor(() => {
        expect(screen.getByText(/failed to process/i)).toBeInTheDocument();
      });

      // Should still be on review step
      expect(screen.getByRole('button', { name: /deny/i })).toBeInTheDocument();
    });
  });

  describe('Success/Completion Step', () => {
    it('should display success message and icon for approved device', async () => {
      const user = userEvent.setup({ delay: null });

      render(<ActivateDevicePage />, {
        wrapperOptions: {
          route: '/activate-device?code=ABCD-1234',
        },
      });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
      });

      const approveButton = screen.getByRole('button', { name: /approve/i });
      await user.click(approveButton);

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /device authorized!/i })).toBeInTheDocument();
        expect(screen.getByText(/device authorized successfully!/i)).toBeInTheDocument();
      });
    });

    it('should display denial message for denied device', async () => {
      const user = userEvent.setup({ delay: null });

      render(<ActivateDevicePage />, {
        wrapperOptions: {
          route: '/activate-device?code=ABCD-1234',
        },
      });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /deny/i })).toBeInTheDocument();
      });

      const denyButton = screen.getByRole('button', { name: /deny/i });
      await user.click(denyButton);

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /device access denied/i })).toBeInTheDocument();
      });
    });

    it('should show "Go to Home" button after completion', async () => {
      const user = userEvent.setup({ delay: null });

      render(<ActivateDevicePage />, {
        wrapperOptions: {
          route: '/activate-device?code=ABCD-1234',
        },
      });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
      });

      const approveButton = screen.getByRole('button', { name: /approve/i });
      await user.click(approveButton);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /go to home/i })).toBeInTheDocument();
      });
    });

    it('should show "Try Another Code" button after denial', async () => {
      const user = userEvent.setup({ delay: null });

      render(<ActivateDevicePage />, {
        wrapperOptions: {
          route: '/activate-device?code=ABCD-1234',
        },
      });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /deny/i })).toBeInTheDocument();
      });

      const denyButton = screen.getByRole('button', { name: /deny/i });
      await user.click(denyButton);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /try another code/i })).toBeInTheDocument();
      });
    });

    it('should display custom success message from API', async () => {
      const user = userEvent.setup({ delay: null });
      const customMessage = 'Your Smart TV has been connected to your account.';

      server.use(
        http.post(`${API_BASE}/auth/device/authorize`, () => {
          return HttpResponse.json({
            data: {
              success: true,
              message: customMessage,
            },
          });
        })
      );

      render(<ActivateDevicePage />, {
        wrapperOptions: {
          route: '/activate-device?code=ABCD-1234',
        },
      });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
      });

      const approveButton = screen.getByRole('button', { name: /approve/i });
      await user.click(approveButton);

      await waitFor(() => {
        expect(screen.getByText(customMessage)).toBeInTheDocument();
      });
    });
  });

  describe('Step Transitions', () => {
    it('should transition through all steps for approval flow', async () => {
      const user = userEvent.setup({ delay: null });

      render(<ActivateDevicePage />);

      // Step 1: Input
      expect(screen.getByLabelText(/device code/i)).toBeInTheDocument();

      const input = screen.getByLabelText(/device code/i);
      await user.type(input, 'ABCD1234');

      const verifyButton = screen.getByRole('button', { name: /verify code/i });
      await user.click(verifyButton);

      // Step 2: Review
      await waitFor(() => {
        expect(screen.getByText(/a device is requesting access/i)).toBeInTheDocument();
      });

      const approveButton = screen.getByRole('button', { name: /approve/i });
      await user.click(approveButton);

      // Step 3: Complete
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /authorization complete/i })).toBeInTheDocument();
      });
    });

    it('should change header text on completion step', async () => {
      const user = userEvent.setup({ delay: null });

      render(<ActivateDevicePage />, {
        wrapperOptions: {
          route: '/activate-device?code=ABCD-1234',
        },
      });

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /authorize device/i })).toBeInTheDocument();
      });

      const approveButton = screen.getByRole('button', { name: /approve/i });
      await user.click(approveButton);

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /authorization complete/i })).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: /authorize device/i })).not.toBeInTheDocument();
      });
    });

    it('should not show description on completion step', async () => {
      const user = userEvent.setup({ delay: null });

      render(<ActivateDevicePage />, {
        wrapperOptions: {
          route: '/activate-device?code=ABCD-1234',
        },
      });

      await waitFor(() => {
        expect(screen.getByText(/link a device to your account/i)).toBeInTheDocument();
      });

      const approveButton = screen.getByRole('button', { name: /approve/i });
      await user.click(approveButton);

      await waitFor(() => {
        expect(screen.queryByText(/link a device to your account/i)).not.toBeInTheDocument();
      });
    });
  });

  describe('UI State Management', () => {
    it('should disable buttons while processing', async () => {
      const user = userEvent.setup({ delay: null });

      // Mock a never-resolving response
      server.use(
        http.post(`${API_BASE}/auth/device/authorize`, () => {
          return new Promise(() => {}); // Never resolves
        })
      );

      render(<ActivateDevicePage />, {
        wrapperOptions: {
          route: '/activate-device?code=ABCD-1234',
        },
      });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
      });

      const approveButton = screen.getByRole('button', { name: /approve/i });
      const denyButton = screen.getByRole('button', { name: /deny/i });

      await user.click(approveButton);

      await waitFor(() => {
        expect(approveButton).toBeDisabled();
        expect(denyButton).toBeDisabled();
      });
    });

    it('should clear errors before new authorization attempt', async () => {
      const user = userEvent.setup({ delay: null });

      // First approval fails
      server.use(
        http.post(`${API_BASE}/auth/device/authorize`, () => {
          return createErrorResponse('Failed', 500);
        })
      );

      render(<ActivateDevicePage />, {
        wrapperOptions: {
          route: '/activate-device?code=ABCD-1234',
        },
      });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
      });

      let approveButton = screen.getByRole('button', { name: /approve/i });
      await user.click(approveButton);

      await waitFor(() => {
        expect(screen.getByText(/failed/i)).toBeInTheDocument();
      });

      // Second approval succeeds - reset to default handler
      server.resetHandlers();

      approveButton = screen.getByRole('button', { name: /approve/i });
      await user.click(approveButton);

      // Error should be cleared before the new request
      await waitFor(() => {
        expect(screen.queryByText(/failed/i)).not.toBeInTheDocument();
      });
    });
  });
});
