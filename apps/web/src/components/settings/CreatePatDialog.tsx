import { useState, FormEvent } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
  Alert,
  Box,
  MenuItem,
  Typography,
} from '@mui/material';
import type { PatCreatedResponse, PatDurationUnit } from '../../types';

interface CreatePatDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (response: PatCreatedResponse) => void;
  onCreate: (data: {
    name: string;
    durationValue: number;
    durationUnit: PatDurationUnit;
  }) => Promise<PatCreatedResponse>;
}

const DURATION_UNITS: { value: PatDurationUnit; label: string }[] = [
  { value: 'minutes', label: 'Minutes' },
  { value: 'days', label: 'Days' },
  { value: 'months', label: 'Months' },
];

function computeExpiresAt(durationValue: number, durationUnit: PatDurationUnit): Date {
  const now = new Date();
  switch (durationUnit) {
    case 'minutes':
      return new Date(now.getTime() + durationValue * 60 * 1000);
    case 'days':
      return new Date(now.getTime() + durationValue * 24 * 60 * 60 * 1000);
    case 'months': {
      const d = new Date(now);
      d.setMonth(d.getMonth() + durationValue);
      return d;
    }
  }
}

export function CreatePatDialog({ open, onClose, onCreated, onCreate }: CreatePatDialogProps) {
  const [name, setName] = useState('');
  const [durationValue, setDurationValue] = useState('30');
  const [durationUnit, setDurationUnit] = useState<PatDurationUnit>('days');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const parsedDurationValue = parseInt(durationValue, 10);
  const isDurationValid =
    !isNaN(parsedDurationValue) &&
    Number.isInteger(parsedDurationValue) &&
    parsedDurationValue >= 1 &&
    parsedDurationValue <= 999;

  const expiresAt =
    isDurationValid ? computeExpiresAt(parsedDurationValue, durationUnit) : null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError('Name is required');
      return;
    }

    if (name.trim().length > 100) {
      setError('Name must be at most 100 characters');
      return;
    }

    if (!isDurationValid) {
      setError('Duration must be an integer between 1 and 999');
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await onCreate({
        name: name.trim(),
        durationValue: parsedDurationValue,
        durationUnit,
      });
      // Reset form
      setName('');
      setDurationValue('30');
      setDurationUnit('days');
      setError(null);
      onCreated(response);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create token');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    if (!isSubmitting) {
      setName('');
      setDurationValue('30');
      setDurationUnit('days');
      setError(null);
      onClose();
    }
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <form onSubmit={handleSubmit}>
        <DialogTitle>Create Personal Access Token</DialogTitle>
        <DialogContent>
          <Box sx={{ pt: 1 }}>
            {error && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {error}
              </Alert>
            )}
            <TextField
              label="Token Name"
              fullWidth
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isSubmitting}
              slotProps={{ htmlInput: { maxLength: 100 } }}
              sx={{ mb: 2 }}
              autoFocus
              placeholder="e.g. CI/CD Pipeline, Local Dev"
            />
            <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
              <TextField
                label="Duration"
                type="number"
                value={durationValue}
                onChange={(e) => setDurationValue(e.target.value)}
                disabled={isSubmitting}
                slotProps={{ htmlInput: { min: 1, max: 999, step: 1 } }}
                sx={{ flex: 1 }}
              />
              <TextField
                select
                label="Unit"
                value={durationUnit}
                onChange={(e) => setDurationUnit(e.target.value as PatDurationUnit)}
                disabled={isSubmitting}
                sx={{ flex: 1 }}
              >
                {DURATION_UNITS.map((u) => (
                  <MenuItem key={u.value} value={u.value}>
                    {u.label}
                  </MenuItem>
                ))}
              </TextField>
            </Box>
            {expiresAt && (
              <Typography variant="body2" color="text.secondary">
                Token will expire on {expiresAt.toLocaleDateString()} at{' '}
                {expiresAt.toLocaleTimeString()}
              </Typography>
            )}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" variant="contained" disabled={isSubmitting}>
            {isSubmitting ? 'Creating...' : 'Create Token'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
