import { useState } from 'react';
import {
  IconButton,
  Avatar,
  Menu,
  MenuItem,
  Divider,
  ListItemIcon,
  ListItemText,
  Typography,
  Box,
} from '@mui/material';
import { Logout as LogoutIcon } from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { usePermissions } from '../../hooks/usePermissions';
import { DESTINATIONS } from '../../config/destinations';

export function UserMenu() {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const { user, logout } = useAuth();
  const { hasPermission } = usePermissions();
  const navigate = useNavigate();

  const open = Boolean(anchorEl);

  const handleOpen = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorEl(null);
  };

  const handleNavigate = (path: string) => {
    navigate(path);
    handleClose();
  };

  const handleLogout = async () => {
    handleClose();
    await logout();
  };

  if (!user) return null;

  // Paths, labels, icons and gates all come from the destination table rather
  // than being spelled out again here. This menu used to hardcode `/settings`
  // and `/admin/settings` and gate the latter on `system_settings:read` while
  // the sidebar gated the same page on the `admin` ROLE — the two disagreed for
  // any Contributor granted that permission. There is now one answer.
  //
  // The filter is the SECTION, not a list of excluded keys (issue #70). This
  // menu used to drop `home` by name, which meant every destination added
  // anywhere in the app arrived here by default — four planned cockpit pages
  // would have landed in the avatar menu without anyone deciding they should.
  // Now the menu owns exactly one section, and the rail's Administration group
  // plus the phone's More sheet cover the rest on every surface.
  //
  // The practical result is a fixed three-row menu — identity, User Settings,
  // Logout — which is what an avatar menu is for: the ACCOUNT, not the app.
  const menuDestinations = DESTINATIONS.filter(
    (destination) =>
      destination.section === 'account' &&
      (!destination.permission || hasPermission(destination.permission)),
  );

  const initials =
    user.displayName
      ?.split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2) || user.email[0].toUpperCase();

  return (
    <>
      <IconButton
        onClick={handleOpen}
        size="small"
        aria-controls={open ? 'user-menu' : undefined}
        aria-haspopup="true"
        aria-expanded={open ? 'true' : undefined}
      >
        <Avatar
          src={user.profileImageUrl || undefined}
          alt={user.displayName || user.email}
          sx={{ width: 32, height: 32, fontSize: '0.875rem' }}
        >
          {initials}
        </Avatar>
      </IconButton>

      <Menu
        id="user-menu"
        anchorEl={anchorEl}
        open={open}
        onClose={handleClose}
        onClick={handleClose}
        transformOrigin={{ horizontal: 'right', vertical: 'top' }}
        anchorOrigin={{ horizontal: 'right', vertical: 'bottom' }}
        slotProps={{
          paper: { sx: { minWidth: 200, mt: 1 } },
        }}
      >
        {/* User Info Header */}
        <Box sx={{ px: 2, py: 1.5 }}>
          <Typography variant="subtitle2" noWrap>
            {user.displayName || 'No name set'}
          </Typography>
          <Typography variant="body2" color="text.secondary" noWrap>
            {user.email}
          </Typography>
        </Box>

        <Divider />

        {/* Navigation Items */}
        {menuDestinations.map((destination) => (
          <MenuItem
            key={destination.key}
            onClick={() => handleNavigate(destination.path)}
          >
            <ListItemIcon>
              <destination.Icon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{destination.label}</ListItemText>
          </MenuItem>
        ))}

        <Divider />

        {/* Logout */}
        <MenuItem onClick={handleLogout}>
          <ListItemIcon>
            <LogoutIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Logout</ListItemText>
        </MenuItem>
      </Menu>
    </>
  );
}
