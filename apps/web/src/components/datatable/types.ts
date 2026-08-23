/**
 * DataTable — shared column contract.
 *
 * This module is the single public API every table in the app is built
 * against. It is deliberately renderer-agnostic: the SAME `DataTableColumn[]`
 * feeds the desktop DataGrid renderer (issue #252, this file's sibling
 * `desktop/`) and the mobile card-list renderer (issue #253), and will feed
 * filtering (#254), column visibility / saved views (#255), and
 * virtualization / export (#256) without any column definition changing.
 *
 * See docs/specs/datatable.md for the full contract documentation.
 */

import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Column-level primitives
// ---------------------------------------------------------------------------

/**
 * Comparison operators a filterable column can advertise.
 *
 * ONE union covering every value type. Which subset a given column offers is
 * decided by its {@link DataTableFilterType} (see `filter/operators.ts`), or
 * pinned explicitly by declaring `filterable: ['equals', 'contains']`.
 *
 * The `endsWith` / `gte` / `lte` / `in` / `isNotEmpty` members are not in any
 * type's DEFAULT set but remain part of the union: a column may pin them, and
 * they were published by #252 before this issue narrowed the defaults.
 */
export type FilterOperator =
  // text
  | 'equals'
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  // number
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  // date
  | 'before'
  | 'after'
  // enum / boolean
  | 'is'
  | 'isNot'
  | 'isAnyOf'
  | 'in'
  // emptiness (any type)
  | 'isEmpty'
  | 'isNotEmpty';

/**
 * The kind of value behind a column, which decides BOTH the operator set the
 * filter UI offers and the input control it draws for the operand.
 *
 * Deliberately a declared field rather than something inferred from the first
 * row: inference would flip a column's operator set when a page happens to be
 * empty, or when a nullable column's first page is all nulls.
 *
 * Default `'text'`.
 */
export type DataTableFilterType =
  'text' | 'number' | 'date' | 'enum' | 'boolean';

/** One selectable option for an `enum` filter column. */
export interface DataTableEnumValue {
  value: string;
  label: string;
}

/**
 * The pivot that drives BOTH renderers from one declaration.
 *
 * - `primary`   — card headline + always-visible desktop column.
 * - `secondary` — card body + visible desktop column.
 * - `detail`    — card expandable region + hidden-by-default on narrow desktop.
 *
 * A column author never writes "show this on mobile" or "hide below 1200px";
 * they state how important the column is and each renderer decides.
 */
export type DataTableColumnPriority = 'primary' | 'secondary' | 'detail';

/** Horizontal alignment of a cell's content (and its header). */
export type DataTableAlign = 'left' | 'center' | 'right';

/** Sort direction used by the controlled server-side sort contract. */
export type DataTableSortDirection = 'asc' | 'desc';

/**
 * Row-height / padding preset.
 *
 * Applies to BOTH renderers: the grid maps it onto DataGrid's own density, the
 * card list onto its padding and inter-card gap (`layout/layoutModel.ts`).
 * A density that only worked on the grid would silently stop working exactly
 * where vertical space is scarcest.
 */
export type DataTableDensity = 'compact' | 'standard' | 'comfortable';

/**
 * One column of a DataTable.
 *
 * `render` and `value` are intentionally separate concerns:
 *   - `render` produces the *visual* cell (chips, avatars, links, thumbnails).
 *   - `value` produces the *scalar* behind the cell — the thing sorting,
 *     filtering and CSV export operate on.
 * A column with only `value` renders that value as text. A column with only
 * `render` has no scalar and therefore cannot be sorted or exported
 * meaningfully; declare `value` too whenever a sensible scalar exists.
 */
export interface DataTableColumn<Row> {
  /**
   * Stable identifier, unique within the table. Doubles as the DataGrid
   * `field` and as the sort field sent to the server, so it should match the
   * API's sort key when the column is sortable.
   */
  id: string;

  /** Human-readable header text (desktop) / field label (mobile card). */
  label: string;

  /** Rich cell renderer. Falls back to the `value` scalar when omitted. */
  render?: (row: Row) => ReactNode;

  /**
   * Scalar extractor — the source of truth for sorting, filtering and export.
   * When omitted, the adapter falls back to `row[id]` if that key exists.
   */
  value?: (row: Row) => string | number | null;

  /** Cell + header alignment. Default `'left'`. */
  align?: DataTableAlign;

  /** Layout importance. Drives both renderers — see {@link DataTableColumnPriority}. */
  priority: DataTableColumnPriority;

  /**
   * Whether the column can be sorted. Default `false`.
   *
   * Sorting is ALWAYS server-side: enabling this only makes the header
   * interactive; the owning page must handle `sort.onSortChange` and refetch.
   * Opt-in (rather than opt-out) because a sortable header that silently does
   * nothing is worse than no header affordance at all.
   */
  sortable?: boolean;

  /**
   * Whether the column can be filtered. Default `false`.
   *
   * `true` enables the default operator set for the column's
   * {@link DataTableFilterType}; an explicit array pins exactly which operators
   * are offered, in the order given.
   *
   * Like sorting, filtering is ALWAYS server-side: the table emits a normalized
   * filter model and NEVER filters `rows` itself. The owning page maps that
   * model onto its endpoint's query params and refetches.
   */
  filterable?: boolean | FilterOperator[];

  /**
   * The value type behind this column, for filtering purposes. Decides which
   * operators are offered and which input control collects the operand.
   * Default `'text'`. Ignored unless `filterable` is set.
   */
  filterType?: DataTableFilterType;

  /**
   * Options for a `filterType: 'enum'` column. Required for enum filtering —
   * an enum column with no `enumValues` has nothing to pick from and is treated
   * as un-filterable by the filter UI.
   */
  enumValues?: DataTableEnumValue[];

  /**
   * A filter that has no cell. The column contributes to the filter surface
   * (and to the URL helper's coercion) and to NOTHING else: it is never drawn
   * as a grid column or a card field, never offered in the column picker, and
   * never written to a CSV export.
   *
   * This exists because a real endpoint's query parameters are not always a
   * subset of its response's columns. In this app, `GET /api/allowlist` accepts
   * `status=pending|claimed` — which is a nullness predicate over `claimedById`
   * (`allowlist.service.ts`), not a field any row carries — and `GET /api/users`
   * accepts `role`, a filter over a relation rather than a scalar. Both are
   * first-class, documented filters; neither has a scalar worth printing once
   * per row. Before this flag the only ways to express them were a bespoke
   * control beside the table (which is what the shared filter bar exists to
   * delete) or a decorative column whose cells say nothing (`pending`, on all
   * 25 rows).
   *
   * `priority`, `align`, `truncate` and the sizing hints are ignored on a
   * `filterOnly` column — declare `priority: 'detail'` and move on.
   *
   * Discovered by the #258 pilot migration; see docs/specs/datatable.md §18.1.
   */
  filterOnly?: boolean;

  /**
   * Whether this column participates in the global quick search.
   *
   * Purely declarative: the search term is a single free-text value sent to the
   * server, so this field documents (and lets the UI describe) which columns the
   * endpoint's free-text param actually covers. The table does not search rows.
   */
  searchable?: boolean;

  /**
   * Whether this column appears in a CSV export (#256). Default `true`.
   *
   * Export always writes the `value` scalar, never the rendered node, so a
   * column with no usable scalar exports empty cells — declare `value`, or set
   * this to `false`. `false` is also how a column carrying material that must
   * never leave the app (a share token, personal-access-token material) is kept
   * out of the file entirely.
   */
  exportable?: boolean;

  /**
   * Whether the user may hide this column from the column picker (#255).
   * `false` pins it permanently visible and keeps it out of the picker
   * entirely — an unchangeable checkbox is worse than no checkbox.
   * Default `true`.
   */
  hideable?: boolean;

  /**
   * Long values are clipped with an ellipsis and reveal the full text on
   * hover/focus (tooltip) rather than wrapping and blowing up row height.
   */
  truncate?: boolean;

  /** Desktop sizing hint: fixed pixel width. */
  width?: number;
  /** Desktop sizing hint: minimum pixel width when flexing. */
  minWidth?: number;
  /** Desktop sizing hint: flex grow factor. Mutually exclusive with `width`. */
  flex?: number;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Confirmation copy for a destructive row action. */
export interface DataTableConfirmOptions<Row> {
  title?: string;
  /** Static description, or one derived from the row being acted upon. */
  description?: string | ((row: Row) => string);
  confirmLabel?: string;
  cancelLabel?: string;
}

/** A per-row action rendered in the trailing actions column. */
export interface DataTableRowAction<Row> {
  id: string;
  label: string;
  /** Optional icon element. Required in practice when >1 action (menu items). */
  icon?: ReactNode;
  onClick: (row: Row) => void;
  /** Per-row disabling, e.g. "can't retry a running job". */
  disabled?: (row: Row) => boolean;
  /** Renders in the error palette. Does NOT by itself add a confirmation step. */
  destructive?: boolean;
  /** `true` for default copy, or an object to customize the confirm dialog. */
  confirm?: boolean | DataTableConfirmOptions<Row>;
}

/** An action applied to the current selection, rendered in the bulk bar. */
export interface DataTableBulkAction {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Receives the selected row ids, in insertion order. */
  onClick: (ids: string[]) => void;
  destructive?: boolean;
  disabled?: boolean | ((ids: string[]) => boolean);
}

// ---------------------------------------------------------------------------
// Controlled state contracts (all server-side)
// ---------------------------------------------------------------------------

/**
 * Controlled, server-side pagination. `page` is ZERO-BASED (matching MUI);
 * APIs in this codebase are one-based, so callers convert at the fetch
 * boundary (`page: pagination.page + 1`).
 */
export interface DataTablePaginationConfig {
  page: number;
  pageSize: number;
  /** Total row count across all pages, from the server's `meta.totalItems`. */
  total: number;
  onPaginationChange: (next: { page: number; pageSize: number }) => void;
  /** Default `[10, 25, 50, 100]`. */
  pageSizeOptions?: number[];
}

/** The active sort, or `null` for "server default order". */
export interface DataTableSortState {
  field: string;
  direction: DataTableSortDirection;
}

/** Controlled, server-side sorting. */
export interface DataTableSortConfig {
  sort: DataTableSortState | null;
  onSortChange: (next: DataTableSortState | null) => void;
}

/**
 * The operand of a filter.
 *
 * Deliberately a small, JSON-and-URL-serializable set:
 *   - `string` / `number` / `boolean` — a single operand (most operators).
 *   - `(string | number)[]` — a two-element `[from, to]` tuple for `between`,
 *     or the candidate set for `isAnyOf` / `in`.
 *   - `null` — no operand at all (`isEmpty` / `isNotEmpty`), or "not filled in
 *     yet" for a draft the user is still composing.
 *
 * Dates are carried as `YYYY-MM-DD` strings rather than `Date` objects, so a
 * filter model survives `JSON.stringify`, a URL round-trip, and a page reload
 * without a revive step.
 */
export type DataTableFilterValue =
  string | number | boolean | (string | number)[] | null;

/**
 * One entry in the normalized filter model.
 *
 * `columnId` is a column `id` — the same identifier used as the sort field and
 * the DataGrid `field` — so a page maps it onto its endpoint's query param with
 * a lookup table it writes once.
 */
export interface DataTableFilter {
  columnId: string;
  operator: FilterOperator;
  value: DataTableFilterValue;
}

/**
 * The complete, normalized filter model: an ordered list of filters, AND-ed
 * together by convention. The table treats this as opaque controlled state and
 * hands it straight back out on every change; interpreting it is the page's job.
 */
export type DataTableFilterModel = DataTableFilter[];

/**
 * Controlled global quick search.
 *
 * The DEBOUNCE APPLIES TO THE EMISSION, NOT THE INPUT: the box updates on every
 * keystroke (so typing never feels laggy) while `onChange` fires once the user
 * has paused for `debounceMs`. A page can therefore refetch directly from
 * `onChange` without its own debounce.
 */
export interface DataTableQuickSearchConfig {
  /** The committed search term. */
  value: string;
  /** Called with the new term after the debounce window elapses. */
  onChange: (next: string) => void;
  /** Input placeholder. Defaults to a term naming the `searchable` columns. */
  placeholder?: string;
  /** Debounce window in ms. Default {@link DEFAULT_QUICK_SEARCH_DEBOUNCE_MS} (300). */
  debounceMs?: number;
  /** Accessible name for the field. Default `'Search'`. */
  ariaLabel?: string;
}

// ---------------------------------------------------------------------------
// CSV export (#256)
// ---------------------------------------------------------------------------

/**
 * The page's own fetch callback, replayed by the "all matching rows" export.
 *
 * The table cannot know the endpoint, the auth scheme, or how this page maps a
 * filter model onto query params — so the WHOLE query is the page's. That is
 * also the security property: an export can only ever return what this user's
 * own list request already returns, with the active filters applied.
 *
 * `page` is ZERO-BASED, matching {@link DataTablePaginationConfig}. Return fewer
 * rows than `pageSize` (or an empty array) to signal the end of the result set.
 */
export type DataTableExportFetchPage<Row> = (params: {
  page: number;
  pageSize: number;
  signal?: AbortSignal;
}) => Promise<Row[]>;

/**
 * Optional export configuration. Export itself needs no configuration: every
 * table can export its current page out of the box (turn it off entirely with
 * {@link DataTableProps.disableExport}).
 */
export interface DataTableExportConfig<Row> {
  /**
   * Filename stem, slugified and dated (`jobs` → `jobs-2026-08-05.csv`).
   * Defaults to `tableId`, then `ariaLabel`, then `export`.
   */
  filename?: string;
  /**
   * Supplying this adds an "Export all matching rows" option that re-queries
   * page by page with the active filters and sort. Omit it and the table offers
   * current-page export only.
   */
  fetchAllRows?: DataTableExportFetchPage<Row>;
  /** Hard row ceiling for an all-rows export. Default 10 000. */
  maxRows?: number;
  /** Rows per request while walking `fetchAllRows`. Default 250. */
  fetchPageSize?: number;
}

/**
 * Controlled selection.
 *
 * The value is a `Set<string>` of row ids. Selection is page-scoped: because
 * pagination is server-side the table only ever knows about the ids it has
 * loaded, so "select all" means "select every row on this page".
 */
export interface DataTableSelectionConfig {
  /** Default `true` when a selection config is supplied at all. */
  selectable?: boolean;
  selectedIds: Set<string>;
  onSelectionChange: (next: Set<string>) => void;
}

// ---------------------------------------------------------------------------
// Table props
// ---------------------------------------------------------------------------

/**
 * Which layout to use.
 *
 * `'auto'` (default) picks by the table's own **container** width — not the
 * viewport — so a table inside a 400px drawer on a 1440px desktop still gets
 * cards. The explicit values exist for tests, Storybook-style previews, and
 * pages that genuinely want one layout at every width.
 *
 * The three layouts map onto two renderer modules:
 *   - `'mobile'`  → `mobile/CardListRenderer`
 *   - `'tablet'`  → `desktop/DesktopGridRenderer` with `variant="tablet"`
 *     (the real grid, `detail` columns folded into an expandable row)
 *   - `'desktop'` → `desktop/DesktopGridRenderer` with `variant="desktop"`
 */
export type DataTableRendererMode = 'auto' | 'desktop' | 'tablet' | 'mobile';

/** The resolved layout. Reported as `data-layout` on the table wrapper. */
export type DataTableLayout = 'mobile' | 'tablet' | 'desktop';

/** The resolved renderer module. Reported as `data-renderer` on the wrapper. */
export type DataTableRendererKind = 'mobile' | 'desktop';

export interface DataTableProps<Row> {
  columns: DataTableColumn<Row>[];
  rows: Row[];
  /** Stable row identity. Must be unique within the page of rows. */
  rowId: (row: Row) => string;

  /** Shows the loading overlay. Rows already present stay visible beneath it. */
  loading?: boolean;
  /** Error message rendered in an Alert above the table. */
  error?: string | null;
  /** Rendered by the no-rows overlay. Defaults to a plain "No results" message. */
  emptyState?: ReactNode;

  pagination?: DataTablePaginationConfig;
  sort?: DataTableSortConfig;
  selection?: DataTableSelectionConfig;

  /**
   * The active filter model — controlled, exactly like `pagination` and `sort`.
   *
   * Supplying `filters` + `onFiltersChange` turns the filter surface on for
   * every layout (a row on desktop, a collapsible panel on tablet, a full-screen
   * sheet on a phone). The table NEVER filters `rows`: it emits a new model and
   * the page refetches.
   */
  filters?: DataTableFilterModel;
  /** Emits the whole next model on every add / edit / remove / clear. */
  onFiltersChange?: (next: DataTableFilterModel) => void;

  /** Controlled, debounced global quick search. Omit to hide the search box. */
  quickSearch?: DataTableQuickSearchConfig;

  rowActions?: DataTableRowAction<Row>[];
  bulkActions?: DataTableBulkAction[];

  /**
   * CSV export options (#256). Optional: every table can already export its
   * current page. Supply this to name the file, or to add the "all matching
   * rows" option by handing the table the page's own fetch callback.
   */
  csvExport?: DataTableExportConfig<Row>;

  /**
   * Removes the export control from every layout.
   *
   * For a table that owns a bespoke export/import of its own (the Tags page's
   * CSV vocabulary round trip, #259) — two export buttons offering different
   * files is worse than one.
   */
  disableExport?: boolean;

  /**
   * Stable identity of THIS table instance, e.g. `'jobs'`, `'admin-shares'`.
   *
   * Supplying it turns on per-user layout persistence: column visibility,
   * density, sort and page size are stored under
   * `user_settings.dataTables[tableId]` and restored on the next mount
   * (docs/specs/datatable.md §14 / §15). Omit it and every layout control still
   * works — the choices simply live for the session only.
   *
   * Chosen by the page and never derived from a route or a label: the id is the
   * storage key, so it must survive a rename or a URL change.
   */
  tableId?: string;

  /**
   * Row height / padding preset. Default `'standard'`.
   *
   * This is the page's DEFAULT, not a lock: a user's own choice (persisted when
   * `tableId` is set, in-session otherwise) takes precedence over it.
   */
  density?: DataTableDensity;
  /** Accessible name for the grid. Strongly recommended. */
  ariaLabel?: string;
  /**
   * Fixed table height. Omit for auto-height (the table grows with its rows and
   * the PAGE scrolls vertically); supply a height to get an internally
   * scrolling table body instead.
   */
  height?: number | string;
  /** Force a layout. Default `'auto'` (container-width driven). */
  renderer?: DataTableRendererMode;

  /**
   * Container width (px) below which the card list is used.
   * Default {@link DEFAULT_MOBILE_BREAKPOINT} (600).
   *
   * This is a **container** measurement, not a viewport one: overriding it is
   * how a host that knows something the table cannot measure (a chrome-heavy
   * panel, a table of unusually wide cells) shifts the pivot for one instance
   * without touching the global default.
   */
  mobileBreakpoint?: number;
  /**
   * Container width (px) below which the grid runs in its tablet variant
   * (`detail` columns hidden, reachable via row expansion) and at or above
   * which the full desktop grid is used.
   * Default {@link DEFAULT_TABLET_BREAKPOINT} (1200).
   */
  tabletBreakpoint?: number;

  /** Forwarded to the outermost wrapper for test targeting. */
  'data-testid'?: string;
}

/**
 * Props handed to a concrete renderer. {@link DataTableProps} minus the layout
 * switch itself and minus the filter surface — every renderer consumes the same
 * contract.
 *
 * Filtering is deliberately NOT a renderer concern. The filter bar is drawn
 * once by `DataTable`, above whichever renderer is active, because it is the
 * one control whose shape is decided by the layout rather than by the row
 * presentation — and because a renderer that owned filter state would lose it
 * on every layout switch (§7.4).
 */
export type DataTableRendererProps<Row> = Omit<
  DataTableProps<Row>,
  | 'renderer'
  | 'mobileBreakpoint'
  | 'tabletBreakpoint'
  | 'filters'
  | 'onFiltersChange'
  | 'quickSearch'
  | 'tableId'
  // Export is drawn once by `DataTable`, in the view bar, for the same reason
  // the filter bar is: its shape is a layout decision, not a row-presentation
  // one, and one code path must serve every renderer (#256).
  | 'csvExport'
  | 'disableExport'
> & {
  /**
   * The USER's resolved column-visibility choice (#255) — layout-independent,
   * and already reconciled against the current column list by
   * `layout/layoutModel.ts`, so a renderer never re-derives it and the two
   * renderers can never disagree about it.
   *
   * A renderer AND-s this with its own layout rules (the tablet grid still
   * folds `detail` columns into the row expander). Omit for "the user has
   * hidden nothing" — what a renderer used directly, outside `DataTable`, gets.
   */
  visibleColumnIds?: ReadonlySet<string>;
};
