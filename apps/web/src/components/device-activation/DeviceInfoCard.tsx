import { useState, useEffect } from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Stack,
  Chip,
  Divider,
  Alert,
  Button,
  CircularProgress,
} from '@mui/material';
import {
  Devices as DevicesIcon,
  Computer as ComputerIcon,
  AccessTime as AccessTimeIcon,
  LocationOn as LocationIcon,
} from '@mui/icons-material';
import type { DeviceActivationInfo } from '../../types';

interface DeviceInfoCardProps {
  deviceInfo: DeviceActivationInfo;
  onApprove: () => Promise<void>;
  onDeny: () => Promise<void>;
  error: string | null;
}

export function DeviceInfoCard({
  deviceInfo,
  onApprove,
  onDeny,
  error,
}: DeviceInfoCardProps) {
  const [isApproving, setIsApproving] = useState(false);
  const [isDenying, setIsDenying] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState<string>('');

  // Calculate time remaining until expiration
  useEffect(() => {
    const updateTimeRemaining = () => {
      const now = new Date().getTime();
      const expires = new Date(deviceInfo.expiresAt).getTime();
      const diff = expires - now;

      if (diff <= 0) {
        setTimeRemaining('Expired');
        return;
      }

      const minutes = Math.floor(diff / 60000);
      const seconds = Math.floor((diff % 60000) / 1000);

      if (minutes > 0) {
        setTimeRemaining(`${minutes}m ${seconds}s`);
      } else {
        setTimeRemaining(`${seconds}s`);
      }
    };

    updateTimeRemaining();
    const interval = setInterval(updateTimeRemaining, 1000);

    return () => clearInterval(interval);
  }, [deviceInfo.expiresAt]);

  const handleApprove = async () => {
    setIsApproving(true);
    try {
      await onApprove();
    } finally {
      setIsApproving(false);
    }
  };

  const handleDeny = async () => {
    setIsDenying(true);
    try {
      await onDeny();
    } finally {
      setIsDenying(false);
    }
  };

  const isExpired = timeRemaining === 'Expired';

  return (
    <Box>
      <Alert severity="info" sx={{ mb: 3 }}>
        A device is requesting access to your account. Review the details below
        and choose whether to approve or deny this request.
      </Alert>

      <Card variant="outlined" sx={{ mb: 3 }}>
        <CardContent>
          <Stack spacing={2.5}>
            {/* Device Name */}
            {deviceInfo.clientInfo.deviceName && (
              <Box sx={{ display: 'flex', alignItems: 'flex-start' }}>
                <DevicesIcon sx={{ mr: 1.5, mt: 0.5, color: 'text.secondary' }} />
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    Device Name
                  </Typography>
                  <Typography variant="body1" sx={{ fontWeight: 'medium' }}>
                    {deviceInfo.clientInfo.deviceName}
                  </Typography>
                </Box>
              </Box>
            )}

            {/* User Agent / Browser */}
            {deviceInfo.clientInfo.userAgent && (
              <Box sx={{ display: 'flex', alignItems: 'flex-start' }}>
                <ComputerIcon sx={{ mr: 1.5, mt: 0.5, color: 'text.secondary' }} />
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    Browser / Device
                  </Typography>
                  <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
                    {deviceInfo.clientInfo.userAgent}
                  </Typography>
                </Box>
              </Box>
            )}

            {/* IP Address */}
            {deviceInfo.clientInfo.ipAddress && (
              <Box sx={{ display: 'flex', alignItems: 'flex-start' }}>
                <LocationIcon sx={{ mr: 1.5, mt: 0.5, color: 'text.secondary' }} />
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    IP Address
                  </Typography>
                  <Typography variant="body2">
                    {deviceInfo.clientInfo.ipAddress}
                  </Typography>
                </Box>
              </Box>
            )}

            <Divider />

            {/* Expiration Time */}
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Box sx={{ display: 'flex', alignItems: 'center' }}>
                <AccessTimeIcon sx={{ mr: 1.5, color: 'text.secondary' }} />
                <Typography variant="body2" color="text.secondary">
                  Time remaining
                </Typography>
              </Box>
              <Chip
                label={timeRemaining}
                size="small"
                color={isExpired ? 'error' : 'primary'}
                variant="outlined"
              />
            </Box>
          </Stack>
        </CardContent>
      </Card>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {/* Action Buttons */}
      <Stack direction="row" spacing={2}>
        <Button
          fullWidth
          variant="outlined"
          color="error"
          size="large"
          onClick={handleDeny}
          disabled={isApproving || isDenying || isExpired}
          startIcon={isDenying ? <CircularProgress size={20} /> : undefined}
        >
          {isDenying ? 'Denying...' : 'Deny'}
        </Button>
        <Button
          fullWidth
          variant="contained"
          color="success"
          size="large"
          onClick={handleApprove}
          disabled={isDenying || isApproving || isExpired}
          startIcon={isApproving ? <CircularProgress size={20} /> : undefined}
        >
          {isApproving ? 'Approving...' : 'Approve'}
        </Button>
      </Stack>

      {isExpired && (
        <Alert severity="error" sx={{ mt: 2 }}>
          This code has expired. Please request a new one from your device.
        </Alert>
      )}
    </Box>
  );
}
