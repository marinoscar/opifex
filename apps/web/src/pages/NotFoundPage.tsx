/**
 * The 404 page.
 *
 * Issue #78, epic #19. Until now `App.tsx` ended with
 * `<Route path="*" element={<Navigate to="/" replace />} />`: every mistyped or
 * dead URL silently became the dashboard. That is worse than it sounds — a
 * bookmark to a route that has been renamed, a link from an old notification,
 * and a genuine typo all produce the same screen, and none of them tells the
 * operator that the address was wrong. The user concludes the app is
 * misbehaving, because from where they are standing it is.
 *
 * The catch-all now lives INSIDE the `Layout` route so this page keeps the
 * shell: the rail and the bottom bar are the fastest way out of a wrong URL,
 * and a chrome-less 404 would strand the user on the one screen that has no
 * navigation of its own. It also sits inside `ProtectedRoute`, which loses
 * nothing — an anonymous visitor to a bad URL is redirected to `/login` with
 * `state.from` preserved, so signing in still lands them here rather than
 * swallowing the address.
 *
 * The destination list is generated from `DESTINATIONS` + `usePermissions`, so
 * it offers only what THIS user can actually reach. A 404 that suggests
 * `/admin/users` to a Viewer produces a second dead end from the first one.
 */

import { Box, Button, Container, List, ListItem, ListItemButton, ListItemIcon, ListItemText, Typography } from '@mui/material';
import HomeIcon from '@mui/icons-material/Home';
import { Link as RouterLink, useLocation } from 'react-router-dom';
import { usePermissions } from '../hooks/usePermissions';
import { DESTINATIONS } from '../config/destinations';

export default function NotFoundPage() {
  const { pathname } = useLocation();
  const { hasPermission } = usePermissions();

  const reachable = DESTINATIONS.filter(
    (destination) => !destination.permission || hasPermission(destination.permission),
  );

  return (
    <Container maxWidth="sm">
      <Box sx={{ py: { xs: 4, sm: 8 } }}>
        <Typography variant="overline" color="text.secondary">
          404
        </Typography>
        <Typography variant="h4" component="h1" gutterBottom>
          Page not found
        </Typography>

        <Typography color="text.secondary" sx={{ mb: 2 }}>
          Nothing is routed at this address.
        </Typography>

        {/*
          The attempted path, verbatim, in the mono token. Echoing it is the
          entire diagnostic value of a 404: it is what turns "the app is broken"
          into "I typed `/setttings`". `wordBreak` because a deep path must wrap
          rather than widen the shell — see the `minWidth: 0` chain in
          `Layout.tsx`.
        */}
        <Typography
          className="opifex-mono"
          variant="body2"
          sx={{
            display: 'block',
            mb: 4,
            p: 1.5,
            borderRadius: 1,
            border: '1px dashed',
            borderColor: 'divider',
            color: 'text.secondary',
            wordBreak: 'break-all',
          }}
        >
          {pathname}
        </Typography>

        <Button
          component={RouterLink}
          to="/"
          variant="contained"
          startIcon={<HomeIcon />}
          sx={{ mb: 4 }}
        >
          Back to the cockpit
        </Button>

        <Typography variant="subtitle2" component="h2" id="not-found-destinations">
          Where you can go
        </Typography>
        <List dense aria-labelledby="not-found-destinations">
          {reachable.map((destination) => (
            <ListItem key={destination.key} disablePadding>
              <ListItemButton component={RouterLink} to={destination.path}>
                <ListItemIcon sx={{ minWidth: 40 }}>
                  <destination.Icon fontSize="small" />
                </ListItemIcon>
                {/* The full label and the real path: on a 404 the operator is
                    already unsure where they are, and the URL is the thing they
                    were getting wrong. */}
                <ListItemText primary={destination.label} secondary={destination.path} />
              </ListItemButton>
            </ListItem>
          ))}
        </List>
      </Box>
    </Container>
  );
}
