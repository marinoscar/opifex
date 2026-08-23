/**
 * DataTable — one row, as a card.
 *
 * Layout is driven entirely by `priority`, never by column order or by any
 * mobile-specific declaration on the column:
 *
 *   primary   → card headline (the thing you scan a list for)
 *   secondary → card body, as stacked label/value pairs
 *   detail    → collapsed behind "More details", CLOSED by default
 *
 * Visual language: an outlined `Card`, a checkbox at the leading edge, a single
 * trailing overflow control, and body text at `body2` / `text.secondary` — the
 * shape that reads well on a phone at 360px.
 *
 * Touch-target rule (issue #243): every control here is >=44px and none of them
 * is hidden with `opacity: 0` while staying clickable. There are no
 * hover-revealed affordances on a card at all — a card list is a touch surface
 * first, and an invisible-but-tappable control is the exact bug #243 filed.
 *
 * Render skipping (#256): a long list lets the browser skip layout and paint for
 * off-screen cards (`content-visibility: auto`) against a MEASURED placeholder
 * height — deliberately not a windowing virtualizer, since a wrong height
 * estimate makes scrolling jump (issue #237). See
 * `virtualization/cardVirtualization.ts`.
 */

import { useCallback, useId, useRef, useState } from 'react';
import {
  Box,
  Card,
  Checkbox,
  Collapse,
  Divider,
  Stack,
  Typography,
  ButtonBase,
  alpha,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import type {
  DataTableColumn,
  DataTableDensity,
  DataTableRowAction,
} from '../types';
import { RowActionsCell } from '../desktop/RowActionsCell';
import { CardField, columnContent, columnText } from './CardField';
import { cardDensityMetrics } from '../layout/layoutModel';
import {
  containIntrinsicSize,
  useLazyImages,
} from '../virtualization/cardVirtualization';

export interface DataCardProps<Row> {
  row: Row;
  id: string;
  primaryColumns: DataTableColumn<Row>[];
  secondaryColumns: DataTableColumn<Row>[];
  detailColumns: DataTableColumn<Row>[];
  selectable: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  rowActions?: DataTableRowAction<Row>[];
  onRunAction: (action: DataTableRowAction<Row>, row: Row) => void;
  /**
   * Row-density preset (#255). Drives the card's padding and field gap — the
   * card equivalent of DataGrid's row height. Touch targets are NOT scaled by
   * it: 44px is a floor, not a style.
   */
  density?: DataTableDensity;
  /**
   * Let the browser skip layout/paint for this card while it is off screen
   * (`content-visibility: auto`, #256). Never set on the measured card, and
   * automatically suspended while the card's detail region is open — a card
   * whose height is changing under the user's finger must stay fully rendered.
   */
  skipOffscreen?: boolean;
  /**
   * Placeholder height, in px, for a skipped card — MEASURED from a real card
   * in this list rather than estimated from a column count (issue #237).
   */
  intrinsicHeight?: number | null;
  /** Callback ref used by the card list to measure one representative card. */
  measureRef?: (node: HTMLElement | null) => void;
}

export function DataCard<Row>({
  row,
  id,
  primaryColumns,
  secondaryColumns,
  detailColumns,
  selectable,
  selected,
  onToggleSelect,
  rowActions,
  onRunAction,
  density,
  skipOffscreen = false,
  intrinsicHeight,
  measureRef,
}: DataCardProps<Row>) {
  const [expanded, setExpanded] = useState(false);
  const detailRegionId = useId();
  const metrics = cardDensityMetrics(density);

  // One ref, two jobs: annotating whatever a column's `render` produced with
  // `loading="lazy"`, and (for the one card the list measures) reporting height.
  const cardRef = useRef<HTMLElement | null>(null);
  const setCardRef = useCallback(
    (node: HTMLElement | null) => {
      cardRef.current = node;
      measureRef?.(node);
    },
    [measureRef],
  );
  useLazyImages(cardRef);

  // An expanding card is changing height right now; skipping its layout is how
  // a scroll position ends up somewhere the user did not put it.
  const skipping = skipOffscreen && !expanded;

  const hasDetail = detailColumns.length > 0;
  const hasActions = Boolean(rowActions && rowActions.length > 0);

  // The first `primary` column doubles as the card's accessible name and as the
  // disambiguator on the actions menu ("Row actions for face_detection").
  const headlineText =
    primaryColumns.length > 0 ? columnText(primaryColumns[0], row) : id;

  return (
    <Card
      ref={setCardRef}
      variant="outlined"
      component="li"
      // The card list is `role="list"` (`CardListRenderer.tsx`); each card is
      // one list item. Naming the item after the row's own headline is what
      // lets a screen reader user navigate the list by item name rather than
      // by reading every field of every card to tell them apart — the same
      // reason `RowActionsCell` disambiguates its menu ("Row actions for
      // {headline}") instead of announcing a bare "Row actions" on every card.
      aria-label={headlineText}
      data-testid="datatable-card"
      data-row-id={id}
      data-density={density ?? 'standard'}
      data-selected={selected ? 'true' : 'false'}
      // Published as data attributes because jsdom's CSS parser drops
      // `content-visibility` outright, so a computed-style assertion could not
      // see it. These are the test hooks for the decision, not the styling.
      data-skip-offscreen={skipping ? 'true' : 'false'}
      data-intrinsic-height={
        skipping ? containIntrinsicSize(intrinsicHeight) : undefined
      }
      sx={{
        listStyle: 'none',
        minWidth: 0,
        maxWidth: '100%',
        overflow: 'hidden',
        ...(skipping
          ? {
              contentVisibility: 'auto',
              containIntrinsicSize: containIntrinsicSize(intrinsicHeight),
            }
          : {}),
        ...(selected
          ? {
              borderColor: 'primary.main',
              // Derived from the palette — see the note in BulkActionBar.
              bgcolor: (theme) =>
                alpha(
                  theme.palette.primary.main,
                  theme.palette.mode === 'dark' ? 0.16 : 0.08,
                ),
            }
          : {}),
      }}
    >
      {/* --- Header: selection, headline, actions ---------------------------- */}
      <Box
        data-testid="datatable-card-header"
        sx={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 1,
          px: metrics.px,
          py: metrics.py,
          minWidth: 0,
        }}
      >
        {selectable && (
          <Checkbox
            checked={selected}
            onChange={() => onToggleSelect(id)}
            // Named after the row it selects, never a bare "Select row" — with
            // several cards on screen at once a generic label is indistinguishable
            // between them to a screen reader (issue #257).
            slotProps={{ input: { 'aria-label': `Select ${headlineText}` } }}
            sx={{ minWidth: 44, minHeight: 44, mt: -0.5, ml: -0.5 }}
          />
        )}

        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          {primaryColumns.map((column, index) => (
            <Typography
              key={column.id}
              data-testid={`datatable-card-headline-${column.id}`}
              variant={index === 0 ? 'subtitle2' : 'body2'}
              component="div"
              color={index === 0 ? 'text.primary' : 'text.secondary'}
              sx={{
                fontWeight: index === 0 ? 700 : 400,
                minWidth: 0,
                overflowWrap: 'anywhere',
              }}
            >
              {columnContent(column, row)}
            </Typography>
          ))}
        </Box>

        {hasActions && (
          <RowActionsCell
            row={row}
            actions={rowActions ?? []}
            rowLabel={headlineText}
            onRun={onRunAction}
            alwaysMenu
            touchTarget
          />
        )}
      </Box>

      {/* --- Body: secondary fields ----------------------------------------- */}
      {secondaryColumns.length > 0 && (
        <>
          <Divider />
          <Stack
            data-testid="datatable-card-body"
            spacing={metrics.fieldGap}
            sx={{ px: metrics.px, py: metrics.py, minWidth: 0 }}
          >
            {secondaryColumns.map((column) => (
              <CardField key={column.id} column={column} row={row} />
            ))}
          </Stack>
        </>
      )}

      {/* --- Detail: collapsed by default ------------------------------------ */}
      {hasDetail && (
        <>
          <Divider />
          <ButtonBase
            data-testid="datatable-card-detail-toggle"
            aria-expanded={expanded}
            aria-controls={detailRegionId}
            aria-label={`${expanded ? 'Hide' : 'More'} details for ${headlineText}`}
            onClick={() => setExpanded((value) => !value)}
            sx={{
              display: 'flex',
              width: '100%',
              minHeight: 44,
              px: metrics.px,
              py: metrics.py,
              gap: 0.5,
              justifyContent: 'flex-start',
              alignItems: 'center',
              color: 'primary.main',
              typography: 'body2',
              fontWeight: 600,
            }}
          >
            {expanded ? (
              <ExpandLessIcon fontSize="small" />
            ) : (
              <ExpandMoreIcon fontSize="small" />
            )}
            {expanded ? 'Fewer details' : 'More details'}
          </ButtonBase>

          <Collapse in={expanded} unmountOnExit>
            <Box
              id={detailRegionId}
              data-testid="datatable-card-detail-region"
              sx={{
                px: metrics.px,
                pb: metrics.px,
                minWidth: 0,
                bgcolor: (theme) =>
                  theme.palette.mode === 'dark'
                    ? 'rgba(255, 255, 255, 0.03)'
                    : 'rgba(0, 0, 0, 0.02)',
              }}
            >
              <Stack
                spacing={metrics.fieldGap}
                sx={{ pt: metrics.py, minWidth: 0 }}
              >
                {detailColumns.map((column) => (
                  <CardField key={column.id} column={column} row={row} />
                ))}
              </Stack>
            </Box>
          </Collapse>
        </>
      )}
    </Card>
  );
}
