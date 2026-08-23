/**
 * DataTable — layout persistence model (issue #255, epic #238).
 *
 * The PURE half of per-user layout persistence: the stored shape, the encoding
 * that survives a round trip through `user_settings.dataTables`, and the
 * resolution rules that turn a stored blob plus the CURRENT column list into
 * "which columns does this table draw right now".
 *
 * Nothing here touches React or the network — `useDataTableLayoutPrefs`
 * (state + writes) and `DataTableViewBar` (the controls) build on top of it.
 *
 * ## The two rules that make this safe
 *
 * 1. **Absent means "use the contract default", never "empty".** An absent
 *    `dataTables` entry, or an absent field inside one, resolves to the
 *    priority-derived baseline. The API deliberately never materialises these
 *    keys (see docs/specs/datatable.md §14.3); neither do we.
 *
 * 2. **A stored list is resolved against the CURRENT columns at render time.**
 *    A stored id for a column that no longer exists is ignored, not an error;
 *    a column that did not exist when the layout was stored resolves to its
 *    default rather than being silently hidden.
 *
 * Rule 2 is the reason for the encoding below.
 */

import type {
  DataTableColumn,
  DataTableDensity,
  DataTableLayout,
} from '../types';
import type { DataTableSettings, UserSettings } from '../../../types';

// ---------------------------------------------------------------------------
// Constants (mirroring the API bounds — apps/api/src/common/schemas/settings.schema.ts)
// ---------------------------------------------------------------------------

/** Max entries the API accepts in a `visibleColumns` list. */
export const DATA_TABLE_MAX_VISIBLE_COLUMNS = 60;
/** Max length of any string inside `visibleColumns`. */
export const DATA_TABLE_MAX_ID_LENGTH = 64;
/** Debounce window before an in-session layout change is written to the server. */
export const DATA_TABLE_PERSIST_DEBOUNCE_MS = 500;
/** Density used when neither the user nor the page has chosen one. */
export const DEFAULT_DENSITY: DataTableDensity = 'standard';

/**
 * Marker prefix for a column the user EXPLICITLY hid.
 *
 * `visibleColumns` is a `string[]` in the API contract, which can express "these
 * ids are visible" but not "…and these other ids existed and were deliberately
 * hidden". Without that second bit, a column added to a table AFTER a user
 * stored a layout is indistinguishable from one they unchecked, and would be
 * silently hidden from that user forever — the exact failure mode §14.3 of the
 * spec exists to prevent, just relocated from the server to the client.
 *
 * So the list carries every column known at write time: visible ones as bare
 * ids, hidden ones prefixed with `-`. A current column mentioned by NEITHER is
 * new, and falls back to its priority-derived default.
 *
 * This degrades correctly for any naive consumer that reads the field as a
 * plain list of visible ids: `-lastError` matches no column id, so it is
 * ignored and the remaining bare ids are exactly the visible set.
 */
export const HIDDEN_COLUMN_PREFIX = '-';

// ---------------------------------------------------------------------------
// Stored shape
// ---------------------------------------------------------------------------

/**
 * One table's persisted layout — the exact entry shape
 * `user_settings.dataTables[tableId]` accepts.
 *
 * The API validates this with `.strict()`: an unknown key is a 400, so nothing
 * beyond these four fields may ever be sent.
 *
 * This is deliberately an ALIAS of the repo-wide `DataTableSettings`
 * (`src/types/index.ts`) rather than a second declaration of the same four
 * fields. That type is the client's mirror of the API's `dataTablesSchema`, and
 * a structurally-identical local copy would compile happily right up until the
 * server contract gained a field — at which point the two would drift silently
 * and the `.strict()` 400 would only show up at runtime. Keeping the local NAME
 * (which the rest of this module reads as "the thing we store") while binding it
 * to the shared TYPE gets both.
 */
export type DataTableStoredLayout = DataTableSettings;

/** The active sort, as persisted. Mirrors {@link DataTableSortState}. */
export type DataTableStoredSort = NonNullable<DataTableStoredLayout['sort']>;

/** The whole namespace, keyed by `tableId`. Mirrors `UserSettings['dataTables']`. */
export type DataTablesSettings = NonNullable<UserSettings['dataTables']>;

const DENSITIES: readonly DataTableDensity[] = [
  'compact',
  'standard',
  'comfortable',
];

/** Whether a value is one of the three densities. */
export function isDensity(value: unknown): value is DataTableDensity {
  return (
    typeof value === 'string' &&
    (DENSITIES as readonly string[]).includes(value)
  );
}

/**
 * Defensively narrow a server payload to the four fields the contract allows.
 *
 * The stored blob is user-writable JSON: another client, an older build, or a
 * hand-edited settings row can put anything in it. Dropping what we do not
 * understand keeps a malformed entry from crashing a render — and keeps us from
 * echoing an unknown key back on the next PATCH, which the API would reject
 * with a 400 and take the whole write down with it.
 */
export function sanitizeStoredLayout(raw: unknown): DataTableStoredLayout {
  if (!raw || typeof raw !== 'object') return {};
  const record = raw as Record<string, unknown>;
  const out: DataTableStoredLayout = {};

  if (Array.isArray(record.visibleColumns)) {
    const ids = record.visibleColumns
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .slice(0, DATA_TABLE_MAX_VISIBLE_COLUMNS);
    out.visibleColumns = ids;
  }
  if (isDensity(record.density)) out.density = record.density;

  const sort = record.sort as Record<string, unknown> | undefined;
  if (
    sort &&
    typeof sort === 'object' &&
    typeof sort.field === 'string' &&
    sort.field.length > 0 &&
    (sort.direction === 'asc' || sort.direction === 'desc')
  ) {
    out.sort = { field: sort.field, direction: sort.direction };
  }

  if (
    typeof record.pageSize === 'number' &&
    Number.isInteger(record.pageSize)
  ) {
    out.pageSize = record.pageSize;
  }

  return out;
}

/** `true` when an entry carries nothing — i.e. "reset to contract defaults". */
export function isEmptyStoredLayout(entry: DataTableStoredLayout): boolean {
  return (
    entry.visibleColumns === undefined &&
    entry.density === undefined &&
    entry.sort === undefined &&
    entry.pageSize === undefined
  );
}

// ---------------------------------------------------------------------------
// Column helpers
// ---------------------------------------------------------------------------

/** `hideable` defaults to `true`; `false` pins a column permanently visible. */
export function isHideable<Row>(column: DataTableColumn<Row>): boolean {
  return column.hideable !== false;
}

/**
 * Whether the LAYOUT itself folds a column away, independent of user choice.
 *
 * Only the tablet grid does: `detail` columns are hidden there and reached via
 * the row expander (§9). This is a presentation decision, so it composes with —
 * rather than being overridden by — the user's stored choice.
 */
export function layoutHidesColumn<Row>(
  column: DataTableColumn<Row>,
  layout: DataTableLayout,
): boolean {
  return layout === 'tablet' && column.priority === 'detail';
}

/**
 * The columns the visibility picker offers for the current layout.
 *
 * Two exclusions, for the same reason: a control that cannot change anything is
 * worse than no control. `hideable: false` columns are pinned; `detail` columns
 * on a tablet are already folded into the row expander, so a checkbox for them
 * would claim an effect it does not have.
 */
export function pickerColumns<Row>(
  columns: DataTableColumn<Row>[],
  layout: DataTableLayout,
): DataTableColumn<Row>[] {
  return columns.filter(
    (column) => isHideable(column) && !layoutHidesColumn(column, layout),
  );
}

// ---------------------------------------------------------------------------
// Visibility encoding / resolution
// ---------------------------------------------------------------------------

/** The two explicit sets carried by a stored `visibleColumns` list. */
export interface DecodedVisibility {
  /** Ids stored as visible (bare). */
  visible: ReadonlySet<string>;
  /** Ids stored as explicitly hidden (`-`-prefixed). */
  hidden: ReadonlySet<string>;
}

/** Split a stored `visibleColumns` list into its explicit visible/hidden sets. */
export function decodeVisibility(stored: readonly string[]): DecodedVisibility {
  const visible = new Set<string>();
  const hidden = new Set<string>();
  for (const entry of stored) {
    if (entry.startsWith(HIDDEN_COLUMN_PREFIX)) {
      const id = entry.slice(HIDDEN_COLUMN_PREFIX.length);
      if (id) hidden.add(id);
    } else if (entry) {
      visible.add(entry);
    }
  }
  return { visible, hidden };
}

/**
 * Encode a user's visibility choice against the columns known right now.
 *
 * Visible columns are written as bare ids, hidden ones with the `-` marker, in
 * declaration order. Two bounds are respected so the write can never be
 * rejected by the API: at most {@link DATA_TABLE_MAX_VISIBLE_COLUMNS} entries
 * (visible ids first, since losing a hidden marker only costs the new-column
 * protection while losing a visible id would hide a column), and no entry
 * longer than {@link DATA_TABLE_MAX_ID_LENGTH}.
 */
export function encodeVisibility<Row>(
  columns: DataTableColumn<Row>[],
  visibleIds: ReadonlySet<string>,
): string[] {
  const visible: string[] = [];
  const hidden: string[] = [];

  for (const column of columns) {
    if (column.id.length > DATA_TABLE_MAX_ID_LENGTH) continue;
    if (visibleIds.has(column.id)) {
      visible.push(column.id);
    } else if (
      column.id.length + HIDDEN_COLUMN_PREFIX.length <=
      DATA_TABLE_MAX_ID_LENGTH
    ) {
      hidden.push(`${HIDDEN_COLUMN_PREFIX}${column.id}`);
    }
  }

  return [...visible, ...hidden].slice(0, DATA_TABLE_MAX_VISIBLE_COLUMNS);
}

/**
 * The user's stored visibility choice, resolved against the CURRENT columns.
 *
 * Layout-independent: this answers "which columns has the user chosen to see",
 * not "which columns does this layout draw". Compose it with
 * {@link layoutHidesColumn} via {@link resolveVisibleColumnIds}.
 *
 * | stored state for a column   | result                                  |
 * | --------------------------- | --------------------------------------- |
 * | no `visibleColumns` at all  | default — visible                       |
 * | listed bare                 | visible                                 |
 * | listed with the `-` marker  | hidden                                  |
 * | not listed (added later)    | default — visible                       |
 * | `hideable: false`           | visible, whatever the list says         |
 *
 * A stored id matching no current column simply never matches, so a renamed or
 * deleted column is ignored rather than throwing.
 */
export function resolveUserVisibleColumnIds<Row>(
  columns: DataTableColumn<Row>[],
  stored: DataTableStoredLayout | null | undefined,
): Set<string> {
  const decoded = stored?.visibleColumns
    ? decodeVisibility(stored.visibleColumns)
    : null;
  const out = new Set<string>();

  for (const column of columns) {
    if (!isHideable(column)) {
      out.add(column.id);
      continue;
    }
    // No stored choice, or a column the stored choice never knew about: the
    // contract default wins, and the contract default is "the user can see it".
    if (!decoded || !decoded.hidden.has(column.id)) out.add(column.id);
  }

  return out;
}

/**
 * The columns this table actually draws: the layout baseline AND the user's
 * choice.
 *
 * Intersection, not override, because the two answer different questions. The
 * tablet grid folds `detail` columns into the row expander so nothing is lost
 * at 800px; a user's "show me `lastError`" cannot un-fold that without
 * reintroducing the horizontal scroll the fold exists to remove. Conversely a
 * user hiding a column must win at every width.
 */
export function resolveVisibleColumnIds<Row>(
  columns: DataTableColumn<Row>[],
  stored: DataTableStoredLayout | null | undefined,
  layout: DataTableLayout,
): Set<string> {
  const chosen = resolveUserVisibleColumnIds(columns, stored);
  const out = new Set<string>();
  for (const column of columns) {
    if (layoutHidesColumn(column, layout)) continue;
    if (chosen.has(column.id)) out.add(column.id);
  }
  return out;
}

/**
 * A stored sort, resolved against the current columns.
 *
 * Returns `null` when the stored field names a column that no longer exists or
 * is no longer `sortable` — restoring a sort the server would reject (or the
 * header cannot show) is worse than opening in the page's own default order.
 */
export function resolveStoredSort<Row>(
  columns: DataTableColumn<Row>[],
  stored: DataTableStoredLayout | null | undefined,
): DataTableStoredSort | null {
  const sort = stored?.sort;
  if (!sort) return null;
  const column = columns.find((candidate) => candidate.id === sort.field);
  if (!column || !column.sortable) return null;
  return sort;
}

// ---------------------------------------------------------------------------
// Density — the card renderer's response
// ---------------------------------------------------------------------------

/**
 * Card metrics per density.
 *
 * The grid gets density for free (DataGrid's own `density` prop drives row
 * height), but a card list has no such contract, and "density applies to the
 * grid only" would mean the setting silently stops working the moment the table
 * is narrow — on the layout where vertical space is scarcest. These are the
 * card equivalents: header/body padding, the gap between fields, and the gap
 * between cards, in MUI spacing units.
 */
export interface CardDensityMetrics {
  /** Horizontal padding of every card region. */
  px: number;
  /** Vertical padding of every card region. */
  py: number;
  /** Gap between stacked label/value fields inside a region. */
  fieldGap: number;
  /** Gap between cards in the list. */
  cardGap: number;
}

export const CARD_DENSITY: Record<DataTableDensity, CardDensityMetrics> = {
  compact: { px: 1, py: 0.75, fieldGap: 0.75, cardGap: 0.75 },
  standard: { px: 1.5, py: 1.25, fieldGap: 1.25, cardGap: 1.5 },
  comfortable: { px: 2, py: 1.75, fieldGap: 1.75, cardGap: 2.25 },
};

/** Card metrics for a density, falling back to `standard`. */
export function cardDensityMetrics(
  density: DataTableDensity | undefined,
): CardDensityMetrics {
  return (
    CARD_DENSITY[density ?? DEFAULT_DENSITY] ?? CARD_DENSITY[DEFAULT_DENSITY]
  );
}

/** Human label for a density, used by the picker and its accessible names. */
export const DENSITY_LABELS: Record<DataTableDensity, string> = {
  compact: 'Compact',
  standard: 'Standard',
  comfortable: 'Comfortable',
};

/** The three densities, in the order the toggle presents them. */
export const DENSITY_OPTIONS: readonly DataTableDensity[] = DENSITIES;
