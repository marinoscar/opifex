import { Box, Typography, Alert, Button, Stack } from '@mui/material';
import {
  CheckCircle as CheckCircleIcon,
  Cancel as CancelIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';

interface ActivationSuccessProps {
  success: boolean;
  message: string;
}

export function ActivationSuccess({ success, message }: ActivationSuccessProps) {
  const navigate = useNavigate();

  return (
    <Box sx={{ textAlign: 'center' }}>
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          mb: 3,
        }}
      >
        {success ? (
          <CheckCircleIcon
            sx={{
              fontSize: 80,
              color: 'success.main',
            }}
          />
        ) : (
          <CancelIcon
            sx={{
              fontSize: 80,
              color: 'error.main',
            }}
          />
        )}
      </Box>

      <Typography variant="h5" sx={{ fontWeight: 'bold' }} gutterBottom>
        {success ? 'Device Authorized!' : 'Device Access Denied'}
      </Typography>

      <Alert severity={success ? 'success' : 'info'} sx={{ mb: 3, textAlign: 'left' }}>
        {message}
      </Alert>

      {success && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          You can now close this page and return to your device.
        </Typography>
      )}

      <Stack direction="row" spacing={2} sx={{ justifyContent: 'center' }}>
        <Button variant="outlined" onClick={() => navigate('/')}>
          Go to Home
        </Button>
        {!success && (
          <Button variant="contained" onClick={() => window.location.reload()}>
            Try Another Code
          </Button>
        )}
      </Stack>
    </Box>
  );
}
