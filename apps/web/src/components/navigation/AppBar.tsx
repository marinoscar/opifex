import {
  AppBar as MuiAppBar,
  Toolbar,
  Box,
  IconButton,
  Link,
  useTheme,
} from '@mui/material';
import {
  Brightness4 as DarkModeIcon,
  Brightness7 as LightModeIcon,
} from '@mui/icons-material';
import { Link as RouterLink } from 'react-router-dom';
import { useThemeContext } from '../../contexts/ThemeContext';
import { OpifexWordmark } from '../brand/OpifexWordmark';
import { UserMenu } from './UserMenu';

/**
 * The top bar.
 *
 * Takes NO props: the `onMenuClick` hamburger callback went away with the
 * drawer it opened. It is removed from the props interface entirely rather than
 * left as an unused optional — a dangling optional handler is exactly how a
 * dead affordance survives a refactor and gets quietly rewired later.
 * Navigation below `sm` is the bottom bar, and at `sm` and up it is the
 * permanent rail; neither needs anything from here.
 */
export function AppBar() {
  const theme = useTheme();
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
        {/*
          Brand, and the app's home affordance.

          This was a `<Typography onClick={() => navigate('/')}>` — an
          accessibility bug rather than a style choice. A clickable text node is
          not in the tab order, does not respond to Enter or Space, does not
          announce as a link, and cannot be opened in a new tab. It is now a
          real anchor (issue #78 found it in passing while fixing the 404).

          NO `aria-label` here on purpose. The accessible name is computed from
          the wordmark's own `role="img"` / `aria-label="Opifex"`, so there is
          exactly one place the brand's name is written down. Labelling the link
          as well would produce two names for one control and the outer one
          would silently win.
        */}
        <Link
          component={RouterLink}
          to="/"
          color="inherit"
          underline="none"
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            flexShrink: 0,
            borderRadius: 1,
            // The focus ring cannot come from `MuiListItemButton` or
            // `MuiIconButton` here, and an unfocusable-looking brand link is
            // the first thing a keyboard user tabs into on every page.
            '&:focus-visible': {
              outline: `2px solid ${theme.palette.primary.main}`,
              outlineOffset: 2,
            },
          }}
        >
          <OpifexWordmark height={22} />
        </Link>

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
