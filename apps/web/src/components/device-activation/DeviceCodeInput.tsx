import { useState, ChangeEvent, FormEvent } from 'react';
import {
  Box,
  TextField,
  Button,
  Typography,
  Alert,
  CircularProgress,
} from '@mui/material';

interface DeviceCodeInputProps {
  initialCode?: string;
  onVerify: (code: string) => Promise<void>;
  error: string | null;
}

export function DeviceCodeInput({
  initialCode = '',
  onVerify,
  error,
}: DeviceCodeInputProps) {
  const [code, setCode] = useState(initialCode);
  const [isVerifying, setIsVerifying] = useState(false);

  const formatCode = (value: string): string => {
    // Remove all non-alphanumeric characters
    const cleaned = value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

    // Add dash after 4 characters
    if (cleaned.length <= 4) {
      return cleaned;
    }
    return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}`;
  };

  const handleCodeChange = (e: ChangeEvent<HTMLInputElement>) => {
    const formatted = formatCode(e.target.value);
    setCode(formatted);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (code.length !== 9) {
      return;
    }

    setIsVerifying(true);
    try {
      await onVerify(code);
    } finally {
      setIsVerifying(false);
    }
  };

  const isValidLength = code.length === 9; // XXXX-XXXX format

  return (
    <Box component="form" onSubmit={handleSubmit}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Enter the code shown on your device
      </Typography>

      <TextField
        fullWidth
        label="Device Code"
        placeholder="XXXX-XXXX"
        value={code}
        onChange={handleCodeChange}
        slotProps={{
          htmlInput: {
            maxLength: 9,
            style: { textTransform: 'uppercase', letterSpacing: '0.1em', fontSize: '1.2rem' },
          },
        }}
        sx={{ mb: 2 }}
        autoFocus
        error={!!error}
      />

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Button
        fullWidth
        type="submit"
        variant="contained"
        size="large"
        disabled={!isValidLength || isVerifying}
        startIcon={isVerifying ? <CircularProgress size={20} /> : undefined}
      >
        {isVerifying ? 'Verifying...' : 'Verify Code'}
      </Button>
    </Box>
  );
}
