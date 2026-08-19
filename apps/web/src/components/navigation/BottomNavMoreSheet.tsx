/**
 * The phone's overflow sheet — every destination the bottom bar cannot hold.
 *
 * Issue #72 (bottom-bar overflow), epic #19.
 *
 * ## Why this component exists at all
 *
 * `BOTTOM_NAV_MAX_ACTIONS` is four and the app has eight destinations, so five
 * of them have no tab. The alternatives were both worse:
 *
 *   - Cap the app at four destinations. That does not make the other four go
 *     away; it makes them reachable only by typing a URL, on the device least
 *     able to type one.
 *   - Drop `showLabels` and fit five or six icon-only tabs. "Runs" and "Queue"
 *     and "Cost" are not distinguishable as glyphs, and Material 3 caps a
 *     label-less bar at five anyway — so this buys one slot and costs the
 *     labels on all of them.
 *
 * A sheet costs one extra tap for the less-frequent half of the app and zero
 * for the frequent half. That is the trade this makes deliberately.
 *
 * ## What the sheet must do, and where each behaviour comes from
 *
 *   - dismiss on Escape        → MUI `Drawer` (Modal), free
 *   - trap focus while open    → MUI `Drawer` (Modal), free
 *   - restore focus on close   → MUI `Drawer` (Modal), free
 *   - close when a destination is chosen → OURS, below. Without it the sheet
 *     stays open over the page it just navigated to, which on a phone reads as
 *     "the tap did nothing".
 *
 * Rows are real links (`component={RouterLink}`), for the same reasons the rail
 * rows are: middle-click, long-press-to-open, and a URL the browser can show.
 * The close happens in `onClick` ALONGSIDE the navigation rather than instead
 * of it — never `onClick={() => { close(); navigate(path); }}`, which is how
 * the deleted drawer ended up needing a `setTimeout` to sequence itself.
 */

import { useId } from 'react';
import {
  Box,
  Divider,
  Drawer,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Typography,
} from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { SECTIONS } from '../../config/destinations';
import type { Destination, DestinationKey } from '../../config/destinations';

export interface BottomNavMoreSheetProps {
  open: boolean;
  onClose: () => void;
  /**
   * The overflow set, already permission-filtered by the caller. This
   * component does no gating of its own: `BottomNav` computes the split once
   * and both halves must come from that same computation, or the bar and the
   * sheet can disagree about which destinations exist.
   */
  destinations: readonly Destination[];
  /** The destination owning the current route, or `null` on an unowned route. */
  activeKey: DestinationKey | null;
}

export function BottomNavMoreSheet({
  open,
  onClose,
  destinations,
  activeKey,
}: BottomNavMoreSheetProps) {
  const titleId = useId();

  // Same rule as the rail: group after filtering, then drop the empty groups.
  // A Viewer has no Administration destinations, and a header with nothing
  // under it reads as a failure to load rather than as an absence.
  const populatedSections = SECTIONS.map((section) => ({
    ...section,
    destinations: destinations.filter((destination) => destination.section === section.key),
  })).filter((section) => section.destinations.length > 0);

  return (
    <Drawer
      anchor="bottom"
      open={open}
      onClose={onClose}
      slotProps={{
        paper: {
          // The paper, not the modal root, is the dialog: naming it here is
          // what gives the sheet an accessible name instead of announcing as
          // an unlabelled group of links.
          role: 'dialog',
          'aria-modal': true,
          'aria-labelledby': titleId,
          sx: {
            borderTopLeftRadius: 12,
            borderTopRightRadius: 12,
            // The sheet must never grow into a full-screen takeover; at that
            // point it is a page and should have been a page.
            maxHeight: '75vh',
          },
        },
      }}
    >
      <Box sx={{ pt: 2, pb: 1 }}>
        {/* A visible title, not just an `aria-label`. The sheet slides up over
            the page the operator was reading, and a sighted user needs the same
            "what is this" answer the accessible name gives. */}
        <Typography id={titleId} variant="subtitle2" sx={{ px: 2, pb: 1 }}>
          More destinations
        </Typography>

        {populatedSections.map((section, index) => (
          <Box key={section.key}>
            {index > 0 && <Divider sx={{ my: 0.5 }} />}
            <List
              disablePadding
              component="ul"
              aria-label={section.label}
              subheader={
                <Typography
                  component="li"
                  variant="overline"
                  color="text.secondary"
                  sx={{ display: 'block', px: 2, lineHeight: 2 }}
                >
                  {section.label}
                </Typography>
              }
            >
              {section.destinations.map((destination) => (
                <ListItem key={destination.key} disablePadding>
                  <ListItemButton
                    component={RouterLink}
                    to={destination.path}
                    onClick={onClose}
                    selected={activeKey === destination.key}
                    aria-current={activeKey === destination.key ? 'page' : undefined}
                  >
                    <ListItemIcon sx={{ minWidth: 40 }}>
                      <destination.Icon />
                    </ListItemIcon>
                    {/* The FULL label here, never the compact one. The compact
                        label exists to fit a 90px tab; a full-width sheet row
                        has no such constraint, and "Users" is a worse answer
                        than "User Management" when there is room for both. */}
                    <ListItemText primary={destination.label} />
                  </ListItemButton>
                </ListItem>
              ))}
            </List>
          </Box>
        ))}
      </Box>
    </Drawer>
  );
}

export default BottomNavMoreSheet;
