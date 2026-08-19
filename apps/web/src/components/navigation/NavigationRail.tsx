/**
 * The navigation rail — tablet and desktop chrome for every destination.
 *
 * Issue #71 (rail sections), epic #19. This REPLACES `Sidebar`'s temporary
 * drawer at `sm` and up. The drawer it replaces was `variant="temporary"` at
 * EVERY breakpoint, which is why it needed hardcoded AppBar-height offsets,
 * `disablePortal`, and a `setTimeout(() => navigate(path), 0)` to let the close
 * animation finish before the route changed. A rail is always visible, so
 * navigating costs ZERO taps where a drawer costs one before navigation can
 * even begin — and with no drawer to close, that navigate-after-close race
 * cannot occur at all.
 *
 * TWO TREATMENTS, ONE COMPONENT
 * -----------------------------
 *   medium  (sm–lg)  →  collapsed, 56px, icon over a short caption
 *   expanded (≥ lg)  →  expanded, 220px, labelled rows + a collapse toggle
 *
 * A desktop user may collapse the rail to the tablet treatment; the choice
 * persists in `user_settings.navigation.railCollapsed`.
 *
 * The medium tier is ALWAYS collapsed regardless of that preference. Honouring
 * a stale `railCollapsed: false` below `lg` would render a 220px rail on a
 * 600px screen — a third of the viewport spent on chrome.
 *
 * SECTIONS, AND WHY THEY LOOK DIFFERENT IN EACH TREATMENT
 * ------------------------------------------------------
 * Eight destinations in one undifferentiated column is a list to be read
 * rather than a map to be scanned. `SECTIONS` groups them, and each group is
 * its own `<ul>` with the section name as its accessible name — so a screen
 * reader user gets the grouping that a sighted user gets from the header,
 * which is the whole point of grouping at all.
 *
 * The header itself is EXPANDED-ONLY. 56px does not hold "Administration" at
 * any legible size, and an abbreviation ("Admin", "Ops") would be a second
 * vocabulary for the same thing. Collapsed, the grouping is carried by a
 * `<Divider>` between groups instead — same information, no text.
 *
 * A section with zero visible destinations renders NOTHING: no orphan header,
 * no orphan divider. That is not a cosmetic detail — a Viewer sees no
 * Administration destinations at all, and a header with nothing under it reads
 * as a loading failure.
 */

import { Fragment } from 'react';
import {
  Box,
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import type { SvgIconComponent } from '@mui/icons-material';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { Link as RouterLink, useLocation } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';
import { useNavigationPrefs } from '../../hooks/useNavigationPrefs';
import { DESTINATIONS, SECTIONS, resolveActiveDestination } from '../../config/destinations';
import type { Destination } from '../../config/destinations';

/**
 * 56px so a 24px icon clears 16px of horizontal padding without the caption
 * below it wrapping.
 */
export const RAIL_WIDTH_COLLAPSED = 56;
export const RAIL_WIDTH_EXPANDED = 220;

/**
 * The AppBar's `Toolbar` height at `sm` and up (MUI's default Toolbar steps to
 * 64px at exactly that breakpoint), which is the only place the rail renders.
 */
const APPBAR_HEIGHT = 64;

interface RailRowProps {
  to: string;
  Icon: SvgIconComponent;
  /** Shown when expanded. */
  label: string;
  /**
   * Shown when collapsed, where 56px will not hold "System Settings". The
   * visible text is `aria-hidden` and the FULL label travels in `aria-label`,
   * so the label reaches assistive technology in both treatments.
   */
  compactLabel: string;
  active: boolean;
  expanded: boolean;
}

function RailRow({ to, Icon, label, compactLabel, active, expanded }: RailRowProps) {
  const theme = useTheme();

  const button = (
    // A real link: focusable, middle-clickable, and it survives a keyboard user
    // tabbing the rail. The `onClick` handler this replaces gave up all three,
    // and needed a `setTimeout` to sequence itself against the drawer close.
    //
    // The focus-visible ring that used to be spelled out in this `sx` now lives
    // in the theme's `MuiListItemButton` override. It was hand-rolled here
    // twice — once on this row and once on the collapse toggle — which is one
    // copy per call site and therefore one chance per call site to be missed.
    <ListItemButton
      component={RouterLink}
      to={to}
      selected={active}
      // `selected` is a VISUAL state only; assistive technology needs the
      // explicit landmark.
      aria-current={active ? 'page' : undefined}
      aria-label={label}
      sx={{
        borderRadius: 1,
        mx: 0.5,
        // `min-width: auto` on a flex item is a hard floor at its min-content
        // width, so one long label would widen the rail — and through it the
        // whole app shell.
        minWidth: 0,
        ...(expanded
          ? { py: 0.75 }
          : {
              flexDirection: 'column',
              alignItems: 'center',
              gap: 0.25,
              px: 0.5,
              py: 0.75,
            }),
      }}
    >
      <ListItemIcon
        sx={{
          color: active ? theme.palette.primary.main : theme.palette.text.secondary,
          minWidth: expanded ? 40 : 'auto',
          justifyContent: 'center',
        }}
      >
        <Icon fontSize={expanded ? 'medium' : 'small'} />
      </ListItemIcon>

      {expanded ? (
        <ListItemText
          primary={label}
          slotProps={{ primary: { variant: 'body2', noWrap: true } }}
          sx={{ minWidth: 0, my: 0 }}
        />
      ) : (
        <Typography
          aria-hidden
          variant="caption"
          noWrap
          sx={{
            fontSize: '0.625rem',
            lineHeight: 1.2,
            maxWidth: '100%',
            color: active ? theme.palette.primary.main : theme.palette.text.secondary,
          }}
        >
          {compactLabel}
        </Typography>
      )}
    </ListItemButton>
  );

  return (
    <ListItem disablePadding sx={{ minWidth: 0 }}>
      {/* A tooltip only where the visible text is abbreviated. It sits on top of
          the accessible name above, never as a substitute for it — a tooltip is
          a pointer affordance and reaches neither a screen reader reliably nor
          a keyboard-only user at all. */}
      {expanded ? button : <Tooltip title={label} placement="right">{button}</Tooltip>}
    </ListItem>
  );
}

export function NavigationRail() {
  const theme = useTheme();
  const { pathname } = useLocation();
  const { hasPermission } = usePermissions();
  const { railCollapsed, toggleRailCollapsed } = useNavigationPrefs();

  // The rail is MOUNTED by `Layout` only at `sm` and up, so this distinguishes
  // the two rail treatments — not "is there a rail at all".
  const isDesktop = useMediaQuery(theme.breakpoints.up('lg'));

  const expanded = isDesktop && !railCollapsed;

  // Active state comes from the destination model, never from a path prefix
  // compared against the row's own `path` — see `config/destinations.ts`.
  const activeDestination = resolveActiveDestination(pathname);

  // `usePermissions`' predicates are memoized, so keying on `hasPermission` is
  // safe: this recomputes when the user's permission set changes, not per render.
  const visibleDestinations = DESTINATIONS.filter(
    (destination) => !destination.permission || hasPermission(destination.permission),
  );

  // Sections are built AFTER the permission filter and then emptied ones are
  // dropped, in that order. Doing it the other way round is how an orphan
  // "Administration" header ends up above nothing on a Viewer's screen.
  const populatedSections = SECTIONS.map((section) => ({
    ...section,
    destinations: visibleDestinations.filter(
      (destination: Destination) => destination.section === section.key,
    ),
  })).filter((section) => section.destinations.length > 0);

  return (
    <Box
      component="nav"
      aria-label="Main navigation"
      sx={{
        width: expanded ? RAIL_WIDTH_EXPANDED : RAIL_WIDTH_COLLAPSED,
        flexShrink: 0,
        // Load-bearing, not cosmetic: without it a long label inside the rail
        // sets a min-content floor that widens the shell past the viewport.
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: theme.palette.background.paper,
        borderRight: `1px solid ${theme.palette.divider}`,
        // Sticky rather than fixed, so the rail participates in the shell's flex
        // row and `main` does not need a hard-coded left offset that would drift
        // from the width above. The old drawer's hardcoded top/height offsets
        // are exactly the drift this avoids.
        position: 'sticky',
        top: APPBAR_HEIGHT,
        alignSelf: 'flex-start',
        height: `calc(100vh - ${APPBAR_HEIGHT}px)`,
        '@supports (height: 100dvh)': {
          height: `calc(100dvh - ${APPBAR_HEIGHT}px)`,
        },
        overflowY: 'auto',
        overflowX: 'hidden',
        transition: theme.transitions.create('width', {
          duration: theme.transitions.duration.shorter,
        }),
        // A 164px width animation is exactly the kind of motion that triggers
        // vestibular discomfort, and the toggle works identically without it.
        '@media (prefers-reduced-motion: reduce)': {
          transition: 'none',
        },
      }}
    >
      <Box sx={{ flexGrow: 1, py: 1, minWidth: 0 }}>
        {populatedSections.map((section, index) => (
          <Fragment key={section.key}>
            {/* The separator goes BETWEEN groups, never before the first one,
                and only in the treatment that has no header to do the job. */}
            {!expanded && index > 0 && <Divider sx={{ mx: 1, my: 0.5 }} />}

            <List
              dense
              disablePadding
              component="ul"
              // Names the group for assistive technology in BOTH treatments,
              // including the collapsed one where the visible header is absent.
              // The divider above is a purely visual cue and announces nothing.
              aria-label={section.label}
              sx={{ minWidth: 0 }}
            >
              {expanded && (
                <Typography
                  component="li"
                  variant="overline"
                  color="text.secondary"
                  sx={{ display: 'block', px: 2, pt: index > 0 ? 1.5 : 0.5, lineHeight: 2 }}
                >
                  {section.label}
                </Typography>
              )}

              {section.destinations.map((destination) => (
                <RailRow
                  key={destination.key}
                  to={destination.path}
                  Icon={destination.Icon}
                  label={destination.label}
                  compactLabel={destination.compactLabel}
                  active={activeDestination === destination.key}
                  expanded={expanded}
                />
              ))}
            </List>
          </Fragment>
        ))}
      </Box>

      {/* The collapse toggle is DESKTOP-ONLY: the medium tier is forced
          collapsed, so a toggle there would either do nothing or produce a
          220px rail on a 600px screen. A real <button> with `aria-expanded` —
          not an icon-shaped div, and not a link. Its focus ring comes from the
          theme's `MuiIconButton` override, alongside the rail rows'. */}
      {isDesktop && (
        <>
          <Divider />
          <Box
            sx={{
              display: 'flex',
              justifyContent: expanded ? 'flex-end' : 'center',
              px: 0.5,
              py: 0.5,
            }}
          >
            <IconButton
              size="small"
              onClick={toggleRailCollapsed}
              aria-expanded={expanded}
              aria-label={expanded ? 'Collapse navigation' : 'Expand navigation'}
            >
              {expanded ? (
                <ChevronLeftIcon fontSize="small" />
              ) : (
                <ChevronRightIcon fontSize="small" />
              )}
            </IconButton>
          </Box>
        </>
      )}
    </Box>
  );
}

export default NavigationRail;
