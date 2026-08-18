/**
 * The phone bottom bar — the ONLY navigation chrome below `sm`.
 *
 * Issue #55, epic #51. The temporary drawer that used to be the sole way into
 * every page is gone, and there is no hamburger in the top bar either:
 * Material 3 acknowledges it has no recommended drawer replacement at this
 * size, which is why the answer is a bottom bar and nothing else.
 *
 * FOUR ACTIONS IS THE CEILING, and this app has exactly four destinations —
 * which is what lets `showLabels` stay on. Five labelled tabs do not fit at
 * 360px, so a fifth destination would force a choice between labels and the
 * tab; do not add one here without resolving that first.
 *
 * ACTIVE STATE COMES FROM THE DESTINATION MODEL, NOT A PATH PREFIX
 * (`config/destinations.ts`). The `startsWith` chain this replaces would have
 * matched `/settingsfoo` against Settings.
 */

import {
  BottomNavigation,
  BottomNavigationAction,
  Paper,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { useNavigate, useLocation } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';
import { DESTINATIONS, resolveActiveDestination } from '../../config/destinations';
import type { DestinationKey } from '../../config/destinations';

export function BottomNav() {
  const theme = useTheme();
  // The EXACT complement of `Layout`'s `showRail` (`up('sm')`), and it must
  // stay that way: any drift opens a band with two navigation surfaces or none.
  // 600px is Material 3's compact/medium boundary — see the coupled-gate list
  // in `common/Layout.tsx`.
  const isCompactWindow = useMediaQuery(theme.breakpoints.down('sm'));
  const navigate = useNavigate();
  const location = useLocation();
  const { hasPermission } = usePermissions();

  if (!isCompactWindow) return null;

  const visibleDestinations = DESTINATIONS.filter(
    (destination) => !destination.permission || hasPermission(destination.permission),
  );

  const resolved = resolveActiveDestination(location.pathname);
  // `false` — NOT `null` — is what MUI's BottomNavigation wants for "nothing
  // selected", which is the correct rendering on the routes `destinations.ts`
  // leaves deliberately unowned. Passing `null` leaves the component thinking a
  // value was supplied and matching nothing, which is the same picture by
  // accident rather than by contract.
  //
  // A destination the user cannot see also resolves to "nothing selected"
  // rather than to a phantom highlighted tab.
  const active: DestinationKey | false =
    resolved !== null && visibleDestinations.some((d) => d.key === resolved)
      ? resolved
      : false;

  const handleChange = (_: React.SyntheticEvent, value: DestinationKey) => {
    const destination = DESTINATIONS.find((d) => d.key === value);
    if (destination) navigate(destination.path);
  };

  return (
    <Paper
      elevation={3}
      sx={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: theme.zIndex.appBar,
      }}
    >
      <BottomNavigation value={active} onChange={handleChange} showLabels>
        {visibleDestinations.map((destination) => (
          <BottomNavigationAction
            key={destination.key}
            value={destination.key}
            // The COMPACT label: a 4-up bar at 360px gives each tab ~90px, and
            // "User Management" does not fit in it. The full label is the
            // accessible name, so nothing is lost to assistive technology.
            label={destination.compactLabel}
            aria-label={destination.label}
            icon={<destination.Icon />}
          />
        ))}
      </BottomNavigation>
    </Paper>
  );
}

export default BottomNav;
