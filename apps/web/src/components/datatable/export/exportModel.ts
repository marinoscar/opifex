/**
 * DataTable — export model (issue #256, epic #238).
 *
 * Turns "this table, as the user is currently looking at it" into a CSV file.
 * Built entirely against the COLUMN CONTRACT (`types.ts`), never against
 * DataGrid: `GridToolbarExport` would serialize the grid's own rows, which
 * exist in one renderer out of two and would silently produce a different file
 * on a phone. One code path serves all three layouts.
 *
 * ## The three rules that make an export trustworthy
 *
 * 1. **`value`, never `render`.** A column whose cell is a `<Chip>` exports the
 *    scalar behind the chip. Serializing a ReactNode is either impossible or
 *    (worse) accidentally lossy — `[object Object]`, or the chip's label
 *    without its meaning. This is the whole reason `render` and `value` are two
 *    fields in the contract (§4).
 * 2. **Only what is on screen.** The columns are the ones the user currently has
 *    visible (#255), minus any column declaring `exportable: false`.
 * 3. **Only what the API already returned.** The export never re-queries with
 *    elevated access, and never reaches for a field the table was not handed.
 *    "Current page" serializes the loaded rows; "all matching rows" replays the
 *    page's OWN fetch callback, so it is subject to exactly the same
 *    authorization and the same active filters as the table itself.
 */

import type { DataTableColumn, DataTableExportFetchPage } from '../types';
import { extractColumnValue } from '../desktop/columnAdapter';
import { toCsvFile } from './csv';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on an "all matching rows" export.
 *
 * A bound, not a preference: without one, a single click against a 150 000-item
 * library issues 1 500 requests and builds a ~100 MB string in a tab that then
 * dies. 10 000 rows is far past any spreadsheet anyone actually reads and still
 * finishes in seconds.
 */
export const DATA_TABLE_EXPORT_MAX_ROWS = 10_000;

/**
 * Page size used when replaying the page's fetch callback.
 *
 * Deliberately larger than any UI page size (the fetch is headless, so the MIT
 * DataGrid's 100-row page cap does not apply here) and small enough that the
 * progress indicator moves and a cancel lands promptly.
 */
export const DATA_TABLE_EXPORT_FETCH_PAGE_SIZE = 250;

/** Guard against a callback that keeps returning rows forever. */
const MAX_FETCH_PAGES = 200;

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/**
 * Whether a column may appear in an export at all.
 *
 * Defaults to `true`: most columns carry a scalar and a table that silently
 * dropped columns from its CSV would be worse than one that exports an empty
 * cell. `exportable: false` is the opt-out, and it is what #259/#260 will set on
 * share tokens and PAT material so a credential can never leave through this
 * door.
 */
export function isExportableColumn<Row>(column: DataTableColumn<Row>): boolean {
  return column.exportable !== false;
}

/**
 * The columns an export writes, in declaration order.
 *
 * `visibleColumnIds` is the USER's resolved visibility (#255) — deliberately
 * layout-independent. A `detail` column folded into the tablet row expander is
 * still shown to the user, just somewhere else, so the CSV must not change
 * because the window happens to be 900px wide today and 1400px tomorrow. A
 * column the user actually unchecked is a different thing, and is excluded.
 *
 * Omitting `visibleColumnIds` means "nothing is hidden" — what a caller outside
 * `DataTable` gets.
 */
export function exportColumns<Row>(
  columns: DataTableColumn<Row>[],
  visibleColumnIds?: ReadonlySet<string>,
): DataTableColumn<Row>[] {
  return columns.filter(
    (column) =>
      isExportableColumn(column) &&
      (!visibleColumnIds || visibleColumnIds.has(column.id)),
  );
}

// ---------------------------------------------------------------------------
// Rows → matrix → file
// ---------------------------------------------------------------------------

/** A header row plus one array of scalars per row, ready for serialization. */
export interface ExportMatrix {
  header: string[];
  body: (string | number | null)[][];
}

/**
 * Build the scalar matrix for a set of rows.
 *
 * `extractColumnValue` is the same extractor the grid's `valueGetter` and the
 * card's field text use, so a CSV cell can never disagree with what the table
 * sorted or displayed for that column.
 */
export function buildExportMatrix<Row>(
  columns: DataTableColumn<Row>[],
  rows: readonly Row[],
): ExportMatrix {
  return {
    header: columns.map((column) => column.label),
    body: rows.map((row) =>
      columns.map((column) => extractColumnValue(column, row)),
    ),
  };
}

/** The complete CSV file text (BOM included) for a set of rows. */
export function buildCsvForRows<Row>(
  columns: DataTableColumn<Row>[],
  rows: readonly Row[],
  visibleColumnIds?: ReadonlySet<string>,
): string {
  const cols = exportColumns(columns, visibleColumnIds);
  const { header, body } = buildExportMatrix(cols, rows);
  return toCsvFile(header, body);
}

// ---------------------------------------------------------------------------
// Filename
// ---------------------------------------------------------------------------

/** `Enrichment jobs` → `enrichment-jobs`. Empty input falls back to `export`. */
export function slugifyExportName(name: string | undefined | null): string {
  const slug = (name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug.length > 0 ? slug : 'export';
}

/**
 * `jobs-2026-08-05.csv`.
 *
 * Dated because an export is a snapshot: two files downloaded a week apart must
 * not collide in a Downloads folder, and `jobs (3).csv` tells nobody anything.
 */
export function exportFilename(
  base: string | undefined | null,
  now: Date = new Date(),
): string {
  const iso = Number.isNaN(now.getTime())
    ? ''
    : `-${now.toISOString().slice(0, 10)}`;
  return `${slugifyExportName(base)}${iso}.csv`;
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/**
 * Hand a CSV string to the browser as a file download.
 *
 * A Blob + object URL + synthetic anchor click, which is the only approach that
 * works without a server round trip and without `data:` URI length limits.
 * Returns `false` when the environment cannot do it (jsdom without a
 * `createObjectURL` stub, an ancient browser) rather than throwing — a failed
 * download must not take a render down with it.
 */
export function downloadCsv(content: string, filename: string): boolean {
  if (typeof document === 'undefined' || typeof URL === 'undefined')
    return false;
  if (typeof URL.createObjectURL !== 'function') return false;

  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return true;
  } finally {
    // Deferred: revoking synchronously can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

// ---------------------------------------------------------------------------
// "All matching rows" — replaying the page's own fetch
// ---------------------------------------------------------------------------

export interface CollectAllRowsOptions<Row> {
  /** The page's own fetch callback. The component cannot know the endpoint. */
  fetchPage: DataTableExportFetchPage<Row>;
  /** Rows per request. Default {@link DATA_TABLE_EXPORT_FETCH_PAGE_SIZE}. */
  pageSize?: number;
  /** Hard ceiling. Default {@link DATA_TABLE_EXPORT_MAX_ROWS}. */
  maxRows?: number;
  /** Called after every page with the running total. */
  onProgress?: (fetched: number) => void;
  signal?: AbortSignal;
}

export interface CollectAllRowsResult<Row> {
  rows: Row[];
  /** `true` when the ceiling stopped the walk before the server ran out. */
  capped: boolean;
}

/** Thrown when an in-flight export is cancelled by the user. */
export class ExportCancelledError extends Error {
  constructor() {
    super('Export cancelled');
    this.name = 'ExportCancelledError';
  }
}

/**
 * Walk the page's fetch callback until it runs dry or the ceiling is reached.
 *
 * Page numbers are ZERO-BASED, matching `DataTablePaginationConfig` — the owning
 * page already converts at its own fetch boundary, and handing it a second
 * convention here would guarantee an off-by-one nobody notices until row 251 is
 * missing.
 *
 * Termination is defensive on purpose: a short page, an empty page, the row
 * ceiling, or {@link MAX_FETCH_PAGES}, whichever comes first. A callback that
 * ignores `page` and keeps returning the same full page would otherwise loop
 * until the tab dies.
 */
export async function collectAllRows<Row>({
  fetchPage,
  pageSize = DATA_TABLE_EXPORT_FETCH_PAGE_SIZE,
  maxRows = DATA_TABLE_EXPORT_MAX_ROWS,
  onProgress,
  signal,
}: CollectAllRowsOptions<Row>): Promise<CollectAllRowsResult<Row>> {
  const collected: Row[] = [];
  let page = 0;
  let capped = false;

  while (page < MAX_FETCH_PAGES) {
    if (signal?.aborted) throw new ExportCancelledError();

    const batch = await fetchPage({ page, pageSize, signal });
    if (signal?.aborted) throw new ExportCancelledError();

    const rows = Array.isArray(batch) ? batch : [];
    if (rows.length === 0) break;

    for (const row of rows) {
      if (collected.length >= maxRows) {
        capped = true;
        break;
      }
      collected.push(row);
    }

    onProgress?.(collected.length);

    if (capped || rows.length < pageSize) break;
    page += 1;
  }

  return { rows: collected, capped };
}
