/**
 * DataTable — public entry point.
 *
 * Consumers should import from `components/datatable` only; the `desktop/`,
 * `mobile/` and `shared/` subfolders are implementation detail.
 *
 * ## A note on the issue numbers in this module's comments
 *
 * This component was ported wholesale from an existing implementation, along
 * with its design rationale. Comments throughout cite issues in the `#237`–`#261`
 * range (`#252` the foundation, `#253` the mobile/tablet layouts, `#254`
 * filtering, `#255` persistence, `#256` virtualization + export, `#257`
 * accessibility, `#243` the "invisible but tappable" bug the touch rules exist
 * to prevent). Those numbers belong to the ORIGIN project's tracker, not this
 * one — they are retained because they make the comments a coherent decision
 * record, and because `docs/specs/datatable.md` in that project indexes by them.
 *
 * In THIS repo the port is upstream template issue #54, epic #51. Nothing here should be read as
 * referring to a local issue of the same number.
 */

export {
  DataTable,
  useDataTableRenderer,
  rendererForLayout,
  drawableColumns,
  shouldRenderViewBar,
} from './DataTable';
export type { ViewBarVisibilityInput } from './DataTable';
export { BulkActionBar } from './BulkActionBar';
export type { BulkActionBarProps } from './BulkActionBar';

// --- Layout resolution -------------------------------------------------------
export {
  useDataTableLayout,
  useContainerWidth,
  useViewportLayout,
  layoutForWidth,
  DEFAULT_BREAKPOINTS,
  DEFAULT_MOBILE_BREAKPOINT,
  DEFAULT_TABLET_BREAKPOINT,
} from './useContainerLayout';
export type { DataTableBreakpoints } from './useContainerLayout';

// --- Desktop / tablet renderer ----------------------------------------------
export { DesktopGridRenderer, ACTIONS_FIELD } from './desktop/DesktopGridRenderer';
export type { DesktopGridRendererProps } from './desktop/DesktopGridRenderer';
export {
  toGridColDef,
  toGridColumns,
  extractColumnValue,
  formatColumnValue,
  buildColumnVisibilityModel,
  rowAccessibleName,
  DEFAULT_COLUMN_MIN_WIDTH,
} from './desktop/columnAdapter';
export { TruncatedCell, DataTableEmptyOverlay, DataTableLoadingOverlay } from './desktop/cells';
export { RowActionsCell } from './desktop/RowActionsCell';
export type { RowActionsCellProps } from './desktop/RowActionsCell';
export {
  DetailRowPanel,
  EXPANDER_FIELD,
  detailRowHeight,
  detailRowId,
  isDetailRow,
} from './desktop/detailRow';

// --- Mobile renderer ---------------------------------------------------------
export { CardListRenderer } from './mobile/CardListRenderer';
export { DataCard } from './mobile/DataCard';
export type { DataCardProps } from './mobile/DataCard';
export { CardField, ExpandableValue, columnContent, columnText } from './mobile/CardField';
export { CompactPagination } from './mobile/CompactPagination';
export { CardSortControl } from './mobile/CardSortControl';

// --- Filtering + quick search (#254) ----------------------------------------
export { DataTableFilterBar, FILTER_COUNT_CLASS } from './filter/DataTableFilterBar';
export type { DataTableFilterBarProps } from './filter/DataTableFilterBar';
export { FilterEditor } from './filter/FilterEditor';
export type { FilterEditorProps } from './filter/FilterEditor';
export { FilterChips } from './filter/FilterChips';
export type { FilterChipsProps } from './filter/FilterChips';
export { QuickSearchField, DEFAULT_QUICK_SEARCH_DEBOUNCE_MS } from './filter/QuickSearchField';
export type { QuickSearchFieldProps } from './filter/QuickSearchField';
export {
  OPERATORS_BY_FILTER_TYPE,
  DEFAULT_FILTER_TYPE,
  operatorLabel,
  operatorArity,
  operatorsForColumn,
  defaultOperatorForColumn,
  filterTypeOf,
  isFilterableColumn,
  filterableColumns,
  searchableColumns,
} from './filter/operators';
export type { OperatorArity } from './filter/operators';
export {
  addFilter,
  removeFilterAt,
  replaceFilterAt,
  containsFilter,
  sameFilter,
  filterKey,
  filterChipLabel,
  describeFilterValue,
  isFilterComplete,
  draftFilterFor,
  blankValueFor,
  columnForFilter,
} from './filter/filterModel';
export {
  readDataTableUrlState,
  writeDataTableUrlState,
  encodeFilter,
  decodeFilter,
  DATATABLE_FILTER_PARAM,
  DATATABLE_SEARCH_PARAM,
} from './filter/filterUrl';
export type { DataTableUrlState, DataTableUrlOptions } from './filter/filterUrl';

// --- Layout persistence: visibility + density (#255) -------------------------
export { DataTableViewBar, HIDDEN_COLUMN_COUNT_CLASS } from './layout/DataTableViewBar';
export type { DataTableViewBarProps } from './layout/DataTableViewBar';
export { useDataTableLayoutPrefs } from './layout/useDataTableLayoutPrefs';
export type {
  DataTableLayoutPrefs,
  UseDataTableLayoutPrefsOptions,
} from './layout/useDataTableLayoutPrefs';
export {
  CARD_DENSITY,
  DATA_TABLE_MAX_ID_LENGTH,
  DATA_TABLE_MAX_VISIBLE_COLUMNS,
  DATA_TABLE_PERSIST_DEBOUNCE_MS,
  DEFAULT_DENSITY,
  DENSITY_LABELS,
  DENSITY_OPTIONS,
  HIDDEN_COLUMN_PREFIX,
  cardDensityMetrics,
  decodeVisibility,
  encodeVisibility,
  isDensity,
  isEmptyStoredLayout,
  isHideable,
  layoutHidesColumn,
  pickerColumns,
  resolveStoredSort,
  resolveUserVisibleColumnIds,
  resolveVisibleColumnIds,
  sanitizeStoredLayout,
} from './layout/layoutModel';
export type {
  CardDensityMetrics,
  DataTablesSettings,
  DataTableStoredLayout,
  DataTableStoredSort,
  DecodedVisibility,
} from './layout/layoutModel';

// --- CSV export (#256) -------------------------------------------------------
export { DataTableExportControl } from './export/DataTableExportControl';
export type { DataTableExportControlProps } from './export/DataTableExportControl';
export {
  CSV_BOM,
  CSV_FIELD_SEPARATOR,
  CSV_FORMULA_ESCAPE,
  CSV_FORMULA_PREFIXES,
  CSV_ROW_SEPARATOR,
  escapeCsvField,
  isFormulaText,
  neutralizeFormula,
  toCsv,
  toCsvFile,
  toCsvRow,
} from './export/csv';
export {
  DATA_TABLE_EXPORT_FETCH_PAGE_SIZE,
  DATA_TABLE_EXPORT_MAX_ROWS,
  ExportCancelledError,
  buildCsvForRows,
  buildExportMatrix,
  collectAllRows,
  downloadCsv,
  exportColumns,
  exportFilename,
  isExportableColumn,
  slugifyExportName,
} from './export/exportModel';
export type {
  CollectAllRowsOptions,
  CollectAllRowsResult,
  ExportMatrix,
} from './export/exportModel';

// --- Virtualization (#256) ---------------------------------------------------
export {
  GRID_CHROME_HEIGHT,
  GRID_ROW_HEIGHT,
  GRID_VIRTUALIZATION_ROW_THRESHOLD,
  GRID_VIRTUALIZED_VISIBLE_ROWS,
  planGridVirtualization,
  virtualizedViewportHeight,
} from './virtualization/gridVirtualization';
export type {
  GridVirtualizationInput,
  GridVirtualizationPlan,
} from './virtualization/gridVirtualization';
export {
  CARD_FALLBACK_INTRINSIC_HEIGHT,
  CARD_VIRTUALIZATION_MIN_ROWS,
  containIntrinsicSize,
  shouldVirtualizeCards,
  useLazyImages,
  useMeasuredCardHeight,
} from './virtualization/cardVirtualization';

// --- Shared ------------------------------------------------------------------
export { useRowActionConfirm, confirmCopy } from './shared/rowActionConfirm';

export type {
  DataTableColumn,
  DataTableColumnPriority,
  DataTableAlign,
  DataTableDensity,
  DataTableSortDirection,
  DataTableSortState,
  DataTableSortConfig,
  DataTablePaginationConfig,
  DataTableSelectionConfig,
  DataTableRowAction,
  DataTableBulkAction,
  DataTableConfirmOptions,
  DataTableProps,
  DataTableRendererProps,
  DataTableRendererMode,
  DataTableLayout,
  DataTableRendererKind,
  FilterOperator,
  DataTableFilterType,
  DataTableEnumValue,
  DataTableFilter,
  DataTableFilterModel,
  DataTableFilterValue,
  DataTableQuickSearchConfig,
  DataTableExportConfig,
  DataTableExportFetchPage,
} from './types';
