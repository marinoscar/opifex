import {
  AppBar as MuiAppBar,
  Toolbar,
  Typography,
  Box,
  IconButton,
  useTheme,
} from '@mui/material';
import {
  Brightness4 as DarkModeIcon,
  Brightness7 as LightModeIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useThemeContext } from '../../contexts/ThemeContext';
import { UserMenu } from './UserMenu';

/**
 * The top bar.
 *
 * Takes NO props as of issue #55: the `onMenuClick` hamburger callback went
 * away with the drawer it opened. It is removed from the props interface
 * entirely rather than left as an unused optional — a dangling optional handler
 * is exactly how a dead affordance survives a refactor and gets quietly rewired
 * later. Navigation below `sm` is the bottom bar, and at `sm` and up it is the
 * permanent rail; neither needs anything from here.
 */
export function AppBar() {
  const theme = useTheme();
  const navigate = useNavigate();
  const { isDarkMode, toggleMode } = useThemeContext();

  return (
    <MuiAppBar
      position="sticky"
      color="default"
      elevation={0}
      sx={{
        backgroundColor: theme.palette.background.paper,
      }}
    >
      <Toolbar>
        {/* Brand. `edge="start"` alignment now belongs to the title: the
            hamburger that used to hold this slot was deleted with the drawer. */}
        <Typography
          variant="h6"
          component="div"
          sx={{
            cursor: 'pointer',
            fontWeight: 600,
            flexShrink: 0,
          }}
          onClick={() => navigate('/')}
        >
          OPIFEX
        </Typography>

        {/* The flexible spacer. Removing it without a replacement packs the
            trailing icon cluster to the LEFT with dead space on the right,
            because nothing else in this row grows — the regression documented
            in MemoriaHub's `docs/audits/mobile-topbar-audit.md` for issue #95.
            It is the only growable item here, which is also what guarantees the
            toolbar can never push the app shell sideways. */}
        <Box aria-hidden sx={{ flexGrow: 1, minWidth: 0 }} />

        {/* Theme Toggle */}
        <IconButton
          onClick={toggleMode}
          color="inherit"
          aria-label="toggle theme"
          sx={{ mr: 1, flexShrink: 0 }}
        >
          {isDarkMode ? <LightModeIcon /> : <DarkModeIcon />}
        </IconButton>

        {/* User Menu */}
        <Box sx={{ flexShrink: 0 }}>
          <UserMenu />
        </Box>
      </Toolbar>
    </MuiAppBar>
  );
}
