/**
 * The signed-in user's identity, as a card.
 *
 * Epic #19, issue #75. This component used to be the left-hand column of the
 * old `HomePage`. It survived the dashboard rewrite — it is a tested, useful
 * component — but the MOUNT moved: identity is not cockpit content, and
 * `/settings` had no identity header at all, so it now opens the settings page.
 */

import {
  Card,
  CardContent,
  Avatar,
  Typography,
  Box,
  Chip,
  Stack,
  Button,
  Divider,
} from '@mui/material';
import { Settings as SettingsIcon } from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';

export interface UserProfileCardProps {
  /**
   * Show the "Account Settings" button.
   *
   * Defaults to `true` — every existing caller wants it. `UserSettingsPage`
   * passes `false`, because a button navigating to the page you are already on
   * is a dead control, and a dead control on the identity header of the page it
   * points at is the most conspicuous place to leave one.
   */
  showSettingsAction?: boolean;
}

export function UserProfileCard({
  showSettingsAction = true,
}: UserProfileCardProps = {}) {
  const { user } = useAuth();
  const navigate = useNavigate();

  if (!user) return null;

  // Get initials for avatar fallback
  const initials =
    user.displayName
      ?.split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2) || user.email[0].toUpperCase();

  return (
    <Card>
      <CardContent>
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            textAlign: 'center',
          }}
        >
          {/* Profile Image */}
          <Avatar
            src={user.profileImageUrl || undefined}
            alt={user.displayName || user.email}
            sx={{
              width: 80,
              height: 80,
              mb: 2,
              fontSize: '1.5rem',
              bgcolor: 'primary.main',
            }}
          >
            {initials}
          </Avatar>

          {/* Name & Email */}
          <Typography variant="h6" gutterBottom>
            {user.displayName || 'No name set'}
          </Typography>
          <Typography variant="body2" color="text.secondary" gutterBottom>
            {user.email}
          </Typography>

          {/* Roles */}
          <Stack
            direction="row"
            spacing={1}
            sx={{ mt: 1, mb: 2, flexWrap: 'wrap', justifyContent: 'center' }}
          >
            {user.roles.map((role) => (
              <Chip
                key={role.name}
                label={role.name}
                size="small"
                color={
                  role.name.toLowerCase() === 'admin' ? 'primary' : 'default'
                }
                variant={
                  role.name.toLowerCase() === 'admin' ? 'filled' : 'outlined'
                }
              />
            ))}
          </Stack>

          <Divider sx={{ width: '100%', my: 2 }} />

          {/* Account Info */}
          <Box sx={{ width: '100%', textAlign: 'left' }}>
            <Typography variant="body2" color="text.secondary">
              Member since
            </Typography>
            <Typography variant="body1" gutterBottom>
              {new Date(user.createdAt).toLocaleDateString()}
            </Typography>
          </Box>

          {/* Settings Button */}
          {showSettingsAction && (
            <Button
              fullWidth
              variant="outlined"
              startIcon={<SettingsIcon />}
              onClick={() => navigate('/settings')}
              sx={{ mt: 2 }}
            >
              Account Settings
            </Button>
          )}
        </Box>
      </CardContent>
    </Card>
  );
}
