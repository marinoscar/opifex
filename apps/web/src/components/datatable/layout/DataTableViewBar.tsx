/**
 * DataTable — the layout surface: column visibility + density (issue #255).
 *
 * Drawn by `DataTable` itself, next to the filter bar and for exactly the same
 * reason (§7.4): the SHAPE of these controls is decided by the layout, not by
 * how rows are presented, and a renderer owning the menu's open state would
 * throw it away on every resize.
 *
 * | layout    | surface                                                        |
 * | --------- | -------------------------------------------------------------- |
 * | `desktop` | inline density toggle + a "Columns" button opening a **menu**   |
 * | `tablet`  | the same, unchanged — a menu still fits and still reads well    |
 * | `mobile`  | one "View" button opening a full-screen **sheet** holding both  |
 *
 * The phone case mirrors the filter sheet rather than squeezing a menu onto a
 * 360px screen: a checkbox list inside a `Menu` on a phone is a scrolling
 * popover with no focus trap and 32px rows. MUI's `Dialog fullScreen` supplies
 * the trap, the Escape handling and the `aria-modal` semantics for free.
 *
 * Touch rules (§8.5) apply to every control here: ≥44px in both axes, and
 * nothing is hidden with `opacity: 0` while staying hit-testable — the menu and
 * the sheet are mounted only while open, so an invisible-but-tappable control
 * cannot exist in the first place.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  AppBar,
  Badge,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  Divider,
  FormControlLabel,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Toolbar,
  Tooltip,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import DensityLargeIcon from '@mui/icons-material/DensityLarge';
import DensityMediumIcon from '@mui/icons-material/DensityMedium';
import DensitySmallIcon from '@mui/icons-material/DensitySmall';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import TuneIcon from '@mui/icons-material/Tune';
import ViewColumnIcon from '@mui/icons-material/ViewColumn';
import type { DataTableColumn, DataTableDensity, DataTableLayout } from '../types';
import { DENSITY_LABELS, DENSITY_OPTIONS, pickerColumns } from './layoutModel';

/** Class on the hidden-column count badge, so the count is assertable. */
export const HIDDEN_COLUMN_COUNT_CLASS = 'datatable-hidden-column-count';

const DENSITY_ICONS: Record<DataTableDensity, typeof DensitySmallIcon> = {
  compact: DensitySmallIcon,
  standard: DensityMediumIcon,
  comfortable: DensityLargeIcon,
};

/** Every control in this surface clears the 44px touch floor. */
const TOUCH_TARGET = { minWidth: 44, minHeight: 44 } as const;

export interface DataTableViewBarProps<Row> {
  columns: DataTableColumn<Row>[];
  layout: DataTableLayout;
  /** The user's own visibility choice — layout folding is applied elsewhere. */
  visibleColumnIds: ReadonlySet<string>;
  density: DataTableDensity;
  onToggleColumn: (columnId: string, visible: boolean) => void;
  onDensityChange: (density: DataTableDensity) => void;
  onReset: () => void;
  /**
   * Trailing slot, currently the CSV export control (#256).
   *
   * A node rather than a config object: the bar owns *placement* (this is the
   * table's chrome row, and export belongs beside the column picker), while what
   * export means — which rows, which columns, which fetch — belongs to
   * `DataTableExportControl` and is none of this component's business.
   */
  trailing?: ReactNode;
}

export function DataTableViewBar<Row>({
  columns,
  layout,
  visibleColumnIds,
  density,
  onToggleColumn,
  onDensityChange,
  onReset,
  trailing,
}: DataTableViewBarProps<Row>) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const hideable = pickerColumns(columns, layout);
  const hiddenCount = hideable.filter((column) => !visibleColumnIds.has(column.id)).length;

  const densityToggle = (
    <ToggleButtonGroup
      exclusive
      size="small"
      value={density}
      aria-label="Row density"
      data-testid="datatable-density-group"
      onChange={(_event, next: DataTableDensity | null) => {
        // `exclusive` emits null when the active button is re-pressed; a
        // density must always be one of the three, so ignore the deselect.
        if (next) onDensityChange(next);
      }}
      sx={{ flex: '0 0 auto' }}
    >
      {DENSITY_OPTIONS.map((option) => {
        const Icon = DENSITY_ICONS[option];
        return (
          <Tooltip key={option} title={`${DENSITY_LABELS[option]} rows`}>
            <ToggleButton
              value={option}
              // The visible affordance is an icon, so the accessible name is
              // the only name this control has — it must say both what it sets
              // and what it sets it on.
              aria-label={`${DENSITY_LABELS[option]} density`}
              data-testid={`datatable-density-${option}`}
              sx={TOUCH_TARGET}
            >
              <Icon fontSize="small" />
            </ToggleButton>
          </Tooltip>
        );
      })}
    </ToggleButtonGroup>
  );

  /** The column checkbox list — identical content in the menu and the sheet. */
  const columnList = (variant: 'menu' | 'sheet') =>
    hideable.map((column) => {
      const checked = visibleColumnIds.has(column.id);
      const toggle = () => onToggleColumn(column.id, !checked);

      if (variant === 'menu') {
        return (
          <MenuItem
            key={column.id}
            onClick={toggle}
            data-testid={`datatable-column-toggle-${column.id}`}
            sx={{ minHeight: 44 }}
          >
            <ListItemIcon sx={{ minWidth: 36 }}>
              <Checkbox
                edge="start"
                size="small"
                checked={checked}
                tabIndex={-1}
                disableRipple
                // The MenuItem is the control; the checkbox is its state, so it
                // is named by the item rather than announcing itself twice.
                slotProps={{ input: { 'aria-labelledby': `datatable-column-label-${column.id}` } }}
              />
            </ListItemIcon>
            <ListItemText id={`datatable-column-label-${column.id}`} primary={column.label} />
          </MenuItem>
        );
      }

      return (
        <FormControlLabel
          key={column.id}
          data-testid={`datatable-column-toggle-${column.id}`}
          sx={{ ml: 0, minHeight: 44 }}
          control={
            <Checkbox
              checked={checked}
              onChange={toggle}
              slotProps={{ input: { 'aria-label': `Show ${column.label}` } }}
              sx={TOUCH_TARGET}
            />
          }
          label={column.label}
        />
      );
    });

  const resetLabel = 'Reset to defaults';

  return (
    <Box
      data-testid="datatable-view-bar"
      data-view-surface={layout}
      sx={{
        display: 'flex',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: 1,
        flexWrap: 'wrap',
        width: '100%',
        maxWidth: '100%',
        minWidth: 0,
        mb: 1,
      }}
    >
      {layout === 'mobile' ? (
        <Button
          variant="outlined"
          size="small"
          startIcon={<TuneIcon />}
          onClick={() => setSheetOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          // Keeps the visible word "View" inside the accessible name
          // (WCAG 2.5.3) while spelling out a count no icon can convey.
          aria-label={hiddenCount > 0 ? `View options (${hiddenCount} columns hidden)` : 'View options'}
          data-testid="datatable-view-button"
          sx={{ minHeight: 44 }}
        >
          View
        </Button>
      ) : (
        <>
          {densityToggle}

          {/* Same shape as the filter bar's "Filters" button: a badge for the
              count, and the count spelled out in the accessible name — a
              superscript bubble is invisible to a screen reader, and putting
              it in the visible label instead would break WCAG 2.5.3 (the
              accessible name must contain the visible text). */}
          <Badge
            color="primary"
            badgeContent={hiddenCount}
            slotProps={{ badge: { className: HIDDEN_COLUMN_COUNT_CLASS } }}
            sx={{ flex: '0 0 auto' }}
          >
            <Button
              variant="outlined"
              size="small"
              startIcon={<ViewColumnIcon />}
              onClick={(event) => setAnchorEl(event.currentTarget)}
              aria-haspopup="menu"
              aria-expanded={Boolean(anchorEl)}
              aria-label={hiddenCount > 0 ? `Columns (${hiddenCount} hidden)` : 'Columns'}
              data-testid="datatable-columns-button"
              sx={{ minHeight: 44 }}
            >
              Columns
            </Button>
          </Badge>

          <Menu
            anchorEl={anchorEl}
            open={Boolean(anchorEl)}
            onClose={() => setAnchorEl(null)}
            slotProps={{ list: { 'aria-label': 'Column visibility', dense: false } }}
            data-testid="datatable-columns-menu"
          >
            {hideable.length === 0 && (
              <MenuItem disabled sx={{ minHeight: 44 }}>
                No hideable columns
              </MenuItem>
            )}
            {columnList('menu')}
            <Divider />
            {/* Always offered, even when nothing has been customized: it is the
                only route back from a layout stored by an earlier session (or
                by another device) that the user cannot otherwise explain. */}
            <MenuItem
              onClick={() => {
                onReset();
                setAnchorEl(null);
              }}
              data-testid="datatable-layout-reset"
              sx={{ minHeight: 44 }}
            >
              <ListItemIcon sx={{ minWidth: 36 }}>
                <RestartAltIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText primary={resetLabel} />
            </MenuItem>
          </Menu>
        </>
      )}

      {/* Trailing slot: the export control, last in the chrome row on every
          layout (a phone gets the overflow button next to "View"). */}
      {trailing}

      {/* Phone: a real sheet, mirroring the filter sheet. */}
      {layout === 'mobile' && (
        <Dialog
          fullScreen
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          aria-labelledby="datatable-view-sheet-title"
          data-testid="datatable-view-sheet"
        >
          <AppBar position="relative" color="default" elevation={0}>
            <Toolbar sx={{ gap: 1 }}>
              <Typography
                id="datatable-view-sheet-title"
                variant="h6"
                component="h2"
                sx={{ flexGrow: 1 }}
              >
                View options
              </Typography>
              <IconButton
                edge="end"
                aria-label="Close view options"
                onClick={() => setSheetOpen(false)}
                sx={TOUCH_TARGET}
              >
                <CloseIcon />
              </IconButton>
            </Toolbar>
          </AppBar>
          <Divider />

          <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <Box>
              <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                Density
              </Typography>
              {densityToggle}
            </Box>

            <Box sx={{ minWidth: 0 }}>
              <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                Columns
              </Typography>
              {hideable.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  No hideable columns
                </Typography>
              ) : (
                <Stack sx={{ minWidth: 0 }}>{columnList('sheet')}</Stack>
              )}
            </Box>

            <Box sx={{ flexGrow: 1 }} />

            <Button
              variant="outlined"
              fullWidth
              startIcon={<RestartAltIcon />}
              onClick={onReset}
              data-testid="datatable-layout-reset"
              sx={{ minHeight: 44 }}
            >
              {resetLabel}
            </Button>
            <Button
              variant="contained"
              fullWidth
              onClick={() => setSheetOpen(false)}
              sx={{ minHeight: 44 }}
            >
              Done
            </Button>
          </DialogContent>
        </Dialog>
      )}
    </Box>
  );
}
