/**
 * DataTable — per-row actions cell.
 *
 * One action renders as a bare icon button (with a tooltip carrying the label);
 * two or more collapse into an overflow menu, mirroring the hand-rolled
 * `MoreVert` menus in UserList / PersonalAccessTokens that this component
 * replaces.
 *
 * Shared by BOTH renderers — the card layout reuses it with `alwaysMenu` (a
 * card header has room for one trailing control) and `touchTarget` (>=44px).
 * That is why it lives next to the grid but is not grid-specific: reimplementing
 * an action menu for cards would guarantee the two drift.
 *
 * The cell never executes an action itself — it hands the descriptor back to
 * the renderer, which owns the (single, shared) confirmation dialog.
 */

import { useState } from 'react';
import type { MouseEvent } from 'react';
import {
  IconButton,
  Tooltip,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Stack,
} from '@mui/material';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import type { DataTableRowAction } from '../types';

export interface RowActionsCellProps<Row> {
  row: Row;
  actions: DataTableRowAction<Row>[];
  /** Label used to disambiguate the menu button for screen readers. */
  rowLabel?: string;
  onRun: (action: DataTableRowAction<Row>, row: Row) => void;
  /**
   * Collapse into the overflow menu even for a single action.
   *
   * The card renderer sets this: a card header has room for exactly one
   * trailing control, and a header whose affordance changes shape depending on
   * how many actions a page happened to declare is worse than one that is
   * always the same button.
   */
  alwaysMenu?: boolean;
  /**
   * Enforce a >=44px hit area (WCAG 2.5.8 / the review-queue touch rule).
   * Off by default so the desktop grid keeps its compact cell density.
   */
  touchTarget?: boolean;
}

/** >=44px in both axes, per the touch-target rule this component must honour. */
const TOUCH_TARGET_SX = { minWidth: 44, minHeight: 44 } as const;

export function RowActionsCell<Row>({
  row,
  actions,
  rowLabel,
  onRun,
  alwaysMenu = false,
  touchTarget = false,
}: RowActionsCellProps<Row>) {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);

  if (actions.length === 0) return null;

  const suffix = rowLabel ? ` for ${rowLabel}` : '';
  const sizing = touchTarget ? TOUCH_TARGET_SX : undefined;
  const menuItemSx = touchTarget ? { minHeight: 44 } : undefined;

  // In a grid cell the wrapper fills the cell and right-aligns its button. In a
  // card header it is a flex sibling of a `flexGrow: 1` headline, where
  // `width: 100%` would fight that headline for space — so it sizes to content
  // and refuses to shrink instead.
  const wrapperSx = alwaysMenu
    ? { width: 'auto', flexShrink: 0, justifyContent: 'flex-end' }
    : { width: '100%', justifyContent: 'flex-end' };

  // --- Single action: a plain icon button -----------------------------------
  if (actions.length === 1 && !alwaysMenu) {
    const action = actions[0];
    const disabled = action.disabled?.(row) ?? false;
    return (
      <Stack direction="row" sx={wrapperSx}>
        <Tooltip title={action.label}>
          {/* span keeps the tooltip working while the button is disabled */}
          <span>
            <IconButton
              size="small"
              aria-label={`${action.label}${suffix}`}
              disabled={disabled}
              color={action.destructive ? 'error' : 'default'}
              sx={sizing}
              onClick={(event: MouseEvent<HTMLElement>) => {
                event.stopPropagation();
                onRun(action, row);
              }}
            >
              {action.icon ?? <MoreVertIcon fontSize="small" />}
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
    );
  }

  // --- Multiple actions: overflow menu --------------------------------------
  const open = Boolean(anchorEl);
  return (
    <Stack direction="row" sx={wrapperSx}>
      <IconButton
        size="small"
        aria-label={`Row actions${suffix}`}
        aria-haspopup="menu"
        aria-expanded={open ? true : undefined}
        sx={sizing}
        onClick={(event: MouseEvent<HTMLElement>) => {
          event.stopPropagation();
          setAnchorEl(event.currentTarget);
        }}
      >
        <MoreVertIcon fontSize="small" />
      </IconButton>
      <Menu anchorEl={anchorEl} open={open} onClose={() => setAnchorEl(null)}>
        {actions.map((action) => (
          <MenuItem
            key={action.id}
            disabled={action.disabled?.(row) ?? false}
            sx={{
              ...menuItemSx,
              ...(action.destructive ? { color: 'error.main' } : {}),
            }}
            onClick={(event: MouseEvent<HTMLElement>) => {
              event.stopPropagation();
              setAnchorEl(null);
              onRun(action, row);
            }}
          >
            {action.icon && (
              <ListItemIcon sx={action.destructive ? { color: 'error.main' } : undefined}>
                {action.icon}
              </ListItemIcon>
            )}
            <ListItemText primary={action.label} />
          </MenuItem>
        ))}
      </Menu>
    </Stack>
  );
}
