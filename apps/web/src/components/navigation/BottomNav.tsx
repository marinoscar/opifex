/**
 * The phone bottom bar — the ONLY navigation chrome below `sm`.
 *
 * Issue #72 (bottom-bar overflow), epic #19. The temporary drawer that used to
 * be the sole way into every page is gone, and there is no hamburger in the top
 * bar either: Material 3 acknowledges it has no recommended drawer replacement
 * at this size, which is why the answer is a bottom bar and nothing else.
 *
 * FOUR ACTIONS IS THE CEILING and the app has eight destinations, so the bar
 * holds at most THREE real ones plus a synthetic **More** action that opens
 * `BottomNavMoreSheet`. The ceiling is what keeps `showLabels` on — see the
 * reasoning on `BOTTOM_NAV_MAX_ACTIONS` in `config/destinations.ts`. The split
 * itself lives there too, as a pure function, so it can be tested against
 * permission shapes this component would need a whole React tree to reach.
 *
 * `'more'` is deliberately NOT a `DestinationKey`. It is a control, not a
 * place: it has no route, nothing can be active on it, and adding it to the
 * key union would force every consumer of the destination model to handle a
 * member that has no path. It appears only in this component's selected-value
 * type, `DestinationKey | 'more' | false`.
 *
 * ACTIVE STATE COMES FROM THE DESTINATION MODEL, NOT A PATH PREFIX
 * (`config/destinations.ts`). The `startsWith` chain this replaces would have
 * matched `/settingsfoo` against Settings.
 */

import { useState } from 'react';
import {
  BottomNavigation,
  BottomNavigationAction,
  Paper,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import { useNavigate, useLocation } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';
import {
  bottomNavSplit,
  resolveActiveDestination,
} from '../../config/destinations';
import type { DestinationKey } from '../../config/destinations';
import { BottomNavMoreSheet } from './BottomNavMoreSheet';

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
  // Declared before the width gate below, because a hook cannot live behind a
  // conditional return. `Layout` unmounts this component above `sm` anyway, so
  // an open sheet cannot survive a resize past the boundary.
  const [moreOpen, setMoreOpen] = useState(false);

  if (!isCompactWindow) return null;

  const { primary, overflow } = bottomNavSplit(
    (destination) =>
      !destination.permission || hasPermission(destination.permission),
  );

  // No overflow, no More action: a trigger that opens an empty sheet is a
  // control that does nothing. No permission shape reaches this today — User
  // Settings, Projects and Cost are visible to every authenticated user, so
  // the overflow is never empty — but the bar must not depend on that. It is a
  // property of the CURRENT table, and the table is meant to change; the
  // condition is what stops the day it does from shipping a dead button.
  // `bottomNavSplit`'s own suite covers the empty case directly.
  const showMore = overflow.length > 0;

  const resolved = resolveActiveDestination(location.pathname);
  // `false` — NOT `null` — is what MUI's BottomNavigation wants for "nothing
  // selected", which is the correct rendering on the routes `destinations.ts`
  // leaves deliberately unowned. Passing `null` leaves the component thinking a
  // value was supplied and matching nothing, which is the same picture by
  // accident rather than by contract.
  //
  // A destination the user cannot see also resolves to "nothing selected"
  // rather than to a phantom highlighted tab.
  //
  // An OVERFLOW destination selects More. The operator is somewhere, and the
  // bar's job is to say so — "nothing selected" while standing on /projects
  // would be a lie about location, not a tasteful absence.
  let active: DestinationKey | 'more' | false = false;
  if (resolved !== null) {
    if (primary.some((destination) => destination.key === resolved)) {
      active = resolved;
    } else if (
      showMore &&
      overflow.some((destination) => destination.key === resolved)
    ) {
      active = 'more';
    }
  }

  const handleChange = (
    _: React.SyntheticEvent,
    value: DestinationKey | 'more',
  ) => {
    if (value === 'more') {
      setMoreOpen(true);
      return;
    }
    const destination = primary.find((d) => d.key === value);
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
        {[
          ...primary.map((destination) => (
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
          )),
          // Rendered inside the same children array rather than as a sibling
          // fragment: `BottomNavigation` reads `React.Children` to size and
          // index its actions, and a fragment in that list breaks the count it
          // derives them from.
          ...(showMore
            ? [
                <BottomNavigationAction
                  key="more"
                  value="more"
                  label="More"
                  aria-label="More destinations"
                  aria-haspopup="dialog"
                  aria-expanded={moreOpen}
                  icon={<MoreHorizIcon />}
                />,
              ]
            : []),
        ]}
      </BottomNavigation>

      {showMore && (
        <BottomNavMoreSheet
          open={moreOpen}
          onClose={() => setMoreOpen(false)}
          destinations={overflow}
          activeKey={resolved}
        />
      )}
    </Paper>
  );
}

export default BottomNav;
