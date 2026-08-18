/**
 * DataTable — card field primitives.
 *
 * A "field" is one column's contribution to one card: its `label` and whatever
 * the column's `render`/`value` produces. The two rules that matter:
 *
 *  1. A column's `render` is used **verbatim**. A job's `succeeded` chip and a
 *     share's preview thumbnail must look the same in a card as in a grid cell;
 *     the card is a different *layout*, not a different *vocabulary*.
 *  2. `truncate: true` clamps to two lines and becomes tap-to-expand. The grid
 *     reveals a truncated value in a hover tooltip, which does not exist on a
 *     touch device — so on a card the value itself is the control.
 */

import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Box, ButtonBase, Typography } from '@mui/material';
import type { DataTableColumn } from '../types';
import { extractColumnValue, formatColumnValue } from '../desktop/columnAdapter';

/** Lines shown before a `truncate` value is clamped. */
const CLAMP_LINES = 2;

// ---------------------------------------------------------------------------
// Expandable (truncated) value
// ---------------------------------------------------------------------------

export interface ExpandableValueProps {
  /**
   * Name of the thing being expanded — the column's `label`, not its value.
   * Produces `"Expand Last error"` / `"Collapse Last error"`; announcing the
   * whole (potentially 500-character) value as the button's name would be
   * unusable.
   */
  text: string;
  children: ReactNode;
}

/**
 * A clamped value that expands in place on tap, Enter or Space.
 *
 * `ButtonBase` is deliberate: it gives real button semantics (focusable,
 * Enter/Space activation, `aria-expanded`) with no button chrome, so the value
 * still reads as text. The 44px floor is the touch-target rule — a two-line
 * clamp of a short string can otherwise be ~34px tall.
 */
export function ExpandableValue({ text, children }: ExpandableValueProps) {
  const [expanded, setExpanded] = useState(false);
  const regionId = useId();

  return (
    <ButtonBase
      data-testid="datatable-card-expandable-value"
      data-expanded={expanded ? 'true' : 'false'}
      aria-expanded={expanded}
      aria-controls={regionId}
      aria-label={expanded ? `Collapse ${text}` : `Expand ${text}`}
      onClick={() => setExpanded((value) => !value)}
      sx={{
        display: 'block',
        width: '100%',
        minWidth: 0,
        minHeight: 44,
        px: 0.5,
        mx: -0.5,
        py: 0.5,
        borderRadius: 1,
        // A `button` element's UA default is centred text, so this override is
        // required to keep the value reading as text. `start`, not `left`: the
        // card's alignment is always the reading direction's start edge, so it
        // stays under its label in an RTL locale too (#438).
        textAlign: 'start',
        justifyContent: 'flex-start',
      }}
    >
      <Box
        id={regionId}
        sx={{
          width: '100%',
          minWidth: 0,
          // Collapsed: a two-line clamp. Expanded: wrap freely and break long
          // unbroken tokens (ids, URLs, stack frames) rather than overflow.
          ...(expanded
            ? { overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }
            : {
                display: '-webkit-box',
                WebkitBoxOrient: 'vertical',
                WebkitLineClamp: CLAMP_LINES,
                overflow: 'hidden',
                overflowWrap: 'anywhere',
              }),
        }}
      >
        {children}
      </Box>
    </ButtonBase>
  );
}

// ---------------------------------------------------------------------------
// Field content
// ---------------------------------------------------------------------------

/** The visual content of one column's cell — `render` wins, `value` is the fallback. */
export function columnContent<Row>(column: DataTableColumn<Row>, row: Row): ReactNode {
  if (column.render) return column.render(row);
  return formatColumnValue(extractColumnValue(column, row));
}

/** The plain-text form of a column's cell, for aria labels and clamp toggles. */
export function columnText<Row>(column: DataTableColumn<Row>, row: Row): string {
  return formatColumnValue(extractColumnValue(column, row));
}

// ---------------------------------------------------------------------------
// Label / value pair
// ---------------------------------------------------------------------------

export interface CardFieldProps<Row> {
  column: DataTableColumn<Row>;
  row: Row;
}

/**
 * One label/value pair in a card body or detail region.
 *
 * Stacked (label above value) rather than side-by-side: at 320px a two-column
 * layout gives the value ~150px, which re-creates on a card exactly the
 * truncation problem cards exist to solve.
 *
 * ## `column.align` is a GRID concern and does not cross into a card (#438)
 *
 * `align` exists so a column of numbers reads as a column — the cells and the
 * header share an edge to scan down (`desktop/columnAdapter.ts` sets both
 * `align` and `headerAlign` from it). A card has no column: the label sits
 * ABOVE its value, and the only thing either one can align against is the other.
 * Honouring `align: 'center'` here centred a value across the whole card width
 * while its label stayed at the start, so the pair stopped reading as a pair
 * (a pair of numeric status counts declared `align: 'center'` did exactly
 * this).
 *
 * So the value is always start-aligned, and by INHERITING rather than declaring
 * an alignment — which is also what keeps it correct under RTL. (The one
 * explicit `textAlign` left in this module is on `ExpandableValue`, and only
 * because a `button` element's UA default is centred; it sets `start` for the
 * same reason.) Do not re-add a `textAlign` derived from `column.align`: a
 * column declaring one is describing the grid, and a card is a different LAYOUT
 * of the same column contract, not a narrow grid.
 */
export function CardField<Row>({ column, row }: CardFieldProps<Row>) {
  const content = columnContent(column, row);

  return (
    <Box data-testid={`datatable-card-field-${column.id}`} sx={{ minWidth: 0 }}>
      <Typography
        variant="caption"
        component="div"
        color="text.secondary"
        sx={{ fontWeight: 600, letterSpacing: 0.2, lineHeight: 1.4 }}
      >
        {column.label}
      </Typography>
      <Typography
        variant="body2"
        component="div"
        sx={{
          minWidth: 0,
          // Never let a long unbroken token push the card past the viewport.
          overflowWrap: 'anywhere',
        }}
      >
        {column.truncate ? (
          <ExpandableValue text={column.label}>{content}</ExpandableValue>
        ) : (
          content
        )}
      </Typography>
    </Box>
  );
}
