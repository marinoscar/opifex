import { Card, CardContent, Typography, Grid, Button, Box } from '@mui/material';
import { Palette as ThemeIcon } from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';
import { DESTINATIONS } from '../../config/destinations';
import type { DestinationKey } from '../../config/destinations';

/**
 * Home-page shortcuts.
 *
 * PATHS, LABELS, ICONS AND GATES COME FROM `config/destinations.ts`. This file
 * used to carry its own copy of `/settings` and `/admin/settings` plus a hybrid
 * gate — a `permission` field alongside a dead `adminOnly` field that no entry
 * ever set. The `adminOnly` field is gone: it was one of three inconsistent
 * gating idioms (role here, role in the sidebar, permission in the user menu)
 * whose disagreement is the bug this epic closes.
 *
 * The DESCRIPTION prose stays local. It is the one thing genuinely specific to
 * this surface — a rail row and a bottom-bar tab have no room for a sentence,
 * so pushing it into the shared table would give every other surface a field it
 * cannot use.
 */

/** Prose keyed by destination. A destination with no entry is not shown here. */
const ACTION_DESCRIPTIONS: Partial<Record<DestinationKey, string>> = {
  settings: 'Manage your profile and preferences',
  users: 'Manage users and email allowlist',
  system: 'Configure application settings',
};

export function QuickActions() {
  const navigate = useNavigate();
  const { hasPermission } = usePermissions();

  const visibleActions = DESTINATIONS.filter(
    (destination) =>
      ACTION_DESCRIPTIONS[destination.key] !== undefined &&
      (!destination.permission || hasPermission(destination.permission)),
  ).flatMap((destination) => [
    {
      title: destination.label,
      description: ACTION_DESCRIPTIONS[destination.key]!,
      icon: <destination.Icon />,
      path: destination.path,
    },
    // Theme is NOT a destination — it is a deep link INTO one, with no rail row
    // and no bottom-bar tab, so it has no place in the destination table. It is
    // emitted right behind its parent so the two stay adjacent, and it inherits
    // that parent's visibility for free: a user who cannot see User Settings has
    // nothing to deep-link into.
    ...(destination.key === 'settings'
      ? [
          {
            title: 'Theme',
            description: 'Customize your display preferences',
            icon: <ThemeIcon />,
            path: '/settings#theme',
          },
        ]
      : []),
  ]);

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Quick Actions
        </Typography>

        <Grid container spacing={2}>
          {visibleActions.map((action) => (
            <Grid size={{ xs: 12, sm: 6 }} key={action.path}>
              <Button
                fullWidth
                variant="outlined"
                onClick={() => navigate(action.path)}
                sx={{
                  justifyContent: 'flex-start',
                  textAlign: 'left',
                  py: 2,
                  px: 2,
                }}
              >
                <Box sx={{ mr: 2, display: 'flex', color: 'primary.main' }}>
                  {action.icon}
                </Box>
                <Box>
                  <Typography variant="subtitle2">{action.title}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {action.description}
                  </Typography>
                </Box>
              </Button>
            </Grid>
          ))}
        </Grid>
      </CardContent>
    </Card>
  );
}
