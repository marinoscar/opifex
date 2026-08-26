/**
 * Interface policy — `ui.allowUserThemeOverride` (#347, epic #332).
 *
 * ## Why this one setting survived a page being replaced from scratch
 *
 * #347 deletes the old System Settings page and everything on it. The feature
 * flags went because the `features` record had zero non-test consumers, and
 * the Advanced JSON editor went because an editor that bypasses per-field
 * validation is a foot-gun once secrets and spend ceilings live here. This
 * setting stayed because it is the ONE system setting that genuinely changes
 * behaviour today — and because of how it got that way. It existed
 * server-side, had an admin UI, and **nothing read it**: an administrator
 * could pin the theme and every user kept their toggle (#79, #211). Dropping
 * it while "scrapping the UI" would recreate exactly that bug, on purpose this
 * time.
 *
 * ## It does not claim the change took effect
 *
 * Epic #332's second rule. The value on the left is what the API RETURNED,
 * with the document version beside it; the switch is a draft until saved. On a
 * successful save the page re-reads `/auth/me` rather than assuming — that
 * request is the delivery channel for this flag (`GET /api/system-settings`
 * 403s for the non-admins the flag constrains, so it could never be the
 * channel), and every other user picks it up when their own session next
 * refreshes. The text says that instead of implying the change is live
 * everywhere the moment the button is pressed.
 */

import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  FormControlLabel,
  Paper,
  Stack,
  Switch,
  Typography,
} from '@mui/material';

import type { SystemSettings } from '../../types';

export interface InterfaceSectionProps {
  settings: SystemSettings;
  /** Resolves when the API has answered. Rejects to the caller's handler. */
  onSave: (allowUserThemeOverride: boolean) => Promise<void>;
  /** No `system_settings:write`, or a save is in flight. */
  disabled: boolean;
  /** Distinguishes the two: a read-only user gets an explanation, not a dead switch. */
  canWrite: boolean;
}

export function InterfaceSection({
  settings,
  onSave,
  disabled,
  canWrite,
}: InterfaceSectionProps) {
  const stored = settings.ui.allowUserThemeOverride;
  const [draft, setDraft] = useState(stored);

  // Re-seed the draft when a fresh `settings` object arrives (a save landing,
  // a refetch). Adjusted during render rather than in an effect: React
  // re-renders with the new draft before committing, so the switch never
  // paints the stale position for a frame, and there is no second commit.
  // See "You might not need an Effect" — react-hooks/set-state-in-effect.
  const [seededFrom, setSeededFrom] = useState(settings);
  if (settings !== seededFrom) {
    setSeededFrom(settings);
    setDraft(settings.ui.allowUserThemeOverride);
  }

  const hasChanges = draft !== stored;

  return (
    <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
      <Typography variant="h6" component="h3" gutterBottom>
        Theme override
      </Typography>

      <Stack
        direction={{ xs: 'column', md: 'row' }}
        spacing={2}
        sx={{ mb: 2, alignItems: 'flex-start' }}
      >
        <Box sx={{ flex: 1, p: 1.5, borderRadius: 1, bgcolor: 'action.hover' }}>
          <Typography variant="overline" color="text.secondary" component="p">
            Stored
          </Typography>
          <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
            allowUserThemeOverride: {String(stored)}
          </Typography>
          <Typography
            variant="caption"
            component="p"
            color="text.secondary"
            sx={{ mt: 0.5 }}
          >
            GET /api/system-settings — document version {settings.version}
          </Typography>
        </Box>
        <Box sx={{ flex: 1, p: 1.5, borderRadius: 1, bgcolor: 'action.hover' }}>
          <Typography variant="overline" color="text.secondary" component="p">
            How it reaches users
          </Typography>
          <Typography variant="body2">
            Each user receives it on their next <code>/auth/me</code>. Sessions
            already open keep the old value until they refresh — this screen
            does not claim otherwise.
          </Typography>
        </Box>
      </Stack>

      <FormControlLabel
        control={
          <Switch
            checked={draft}
            onChange={(event) => setDraft(event.target.checked)}
            disabled={disabled}
            slotProps={{
              input: {
                'aria-label': 'Allow users to choose their own theme',
              },
            }}
          />
        }
        label="Allow users to choose their own theme"
      />
      <Typography variant="body2" color="text.secondary" sx={{ ml: 4 }}>
        When this is off, every user follows the system-defined theme and the
        theme control disappears from their settings.
      </Typography>

      {!canWrite && (
        <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
          Changing this needs <code>system_settings:write</code>, which this
          account does not hold.
        </Alert>
      )}

      <Box sx={{ mt: 3 }}>
        <Button
          variant="contained"
          onClick={() => onSave(draft)}
          disabled={disabled || !hasChanges}
        >
          Save
        </Button>
      </Box>
    </Paper>
  );
}

export default InterfaceSection;
