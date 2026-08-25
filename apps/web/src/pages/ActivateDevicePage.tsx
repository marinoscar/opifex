import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Box, Card, CardContent, Typography, useTheme } from '@mui/material';
import { ApiError } from '../services/api';
import { getDeviceActivationInfo, authorizeDevice } from '../services/api';
import { DeviceCodeInput } from '../components/device-activation/DeviceCodeInput';
import { DeviceInfoCard } from '../components/device-activation/DeviceInfoCard';
import { ActivationSuccess } from '../components/device-activation/ActivationSuccess';
import type { DeviceActivationInfo } from '../types';

type PageState =
  | { step: 'input' }
  | { step: 'review'; deviceInfo: DeviceActivationInfo }
  | { step: 'complete'; success: boolean; message: string };

export default function ActivateDevicePage() {
  const [searchParams] = useSearchParams();
  const theme = useTheme();
  const [state, setState] = useState<PageState>({ step: 'input' });
  const [error, setError] = useState<string | null>(null);

  // Pre-fill code from URL query parameter
  const codeFromUrl = searchParams.get('code') || '';

  const handleVerifyCode = async (code: string) => {
    setError(null);
    try {
      const deviceInfo = await getDeviceActivationInfo(code);
      setState({ step: 'review', deviceInfo });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 404 || err.status === 400) {
          setError('Invalid code. Please check and try again.');
        } else if (err.status === 410) {
          setError('This code has expired. Please request a new one.');
        } else {
          setError(err.message || 'Failed to verify code. Please try again.');
        }
      } else {
        setError('Network error. Please check your connection and try again.');
      }
    }
  };

  // Auto-verify a code arriving in the URL, once, on mount. Declared after
  // handleVerifyCode so the effect does not close over a binding that is
  // still in its temporal dead zone at the point the effect is created
  // (react-hooks/immutability).
  // Kicks off a request on mount; `handleVerifyCode` clears `error` before its
  // first `await`, which on mount is a no-op — `error` starts `null`. The state
  // that matters is set from the response, well past the effect body.
  useEffect(() => {
    if (codeFromUrl && state.step === 'input') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount, see above
      handleVerifyCode(codeFromUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleApprove = async () => {
    if (state.step !== 'review') return;

    setError(null);
    try {
      const response = await authorizeDevice(state.deviceInfo.userCode, true);
      setState({
        step: 'complete',
        success: response.success,
        message: response.message || 'Device authorized successfully!',
      });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(
          err.message || 'Failed to authorize device. Please try again.',
        );
      } else {
        setError('Network error. Please check your connection and try again.');
      }
    }
  };

  const handleDeny = async () => {
    if (state.step !== 'review') return;

    setError(null);
    try {
      const response = await authorizeDevice(state.deviceInfo.userCode, false);
      setState({
        step: 'complete',
        success: false,
        message: response.message || 'Device access denied.',
      });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message || 'Failed to process request. Please try again.');
      } else {
        setError('Network error. Please check your connection and try again.');
      }
    }
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.palette.background.default,
        p: 2,
      }}
    >
      <Card
        sx={{
          maxWidth: 500,
          width: '100%',
          boxShadow: theme.shadows[10],
        }}
      >
        <CardContent sx={{ p: { xs: 3, sm: 4 } }}>
          {/* Header */}
          <Box sx={{ textAlign: 'center', mb: 4 }}>
            <Typography variant="h4" component="h1" sx={{ fontWeight: 'bold' }}>
              {state.step === 'complete'
                ? 'Authorization Complete'
                : 'Authorize Device'}
            </Typography>
            {state.step !== 'complete' && (
              <Typography color="text.secondary" sx={{ mt: 1 }}>
                Link a device to your account
              </Typography>
            )}
          </Box>

          {/* Content based on state */}
          {state.step === 'input' && (
            <DeviceCodeInput
              initialCode={codeFromUrl}
              onVerify={handleVerifyCode}
              error={error}
            />
          )}

          {state.step === 'review' && (
            <DeviceInfoCard
              deviceInfo={state.deviceInfo}
              onApprove={handleApprove}
              onDeny={handleDeny}
              error={error}
            />
          )}

          {state.step === 'complete' && (
            <ActivationSuccess
              success={state.success}
              message={state.message}
            />
          )}
        </CardContent>
      </Card>
    </Box>
  );
}
