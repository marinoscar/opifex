/**
 * DataTable — URL serialization for the filter model and quick search.
 *
 * Offered as a HELPER, never wired in automatically. A page that already owns a
 * `useSearchParams` (the admin users and allowlist pages) opts in with two
 * calls;
 * a page that doesn't isn't forced to grow a router dependency to render a
 * table. That is the same posture the rest of the contract takes with
 * pagination and sort.
 *
 * ## Wire format
 *
 * One repeated `filter` param per filter:
 *
 * ```
 * ?filter=status:is:failed
 * &filter=lastError:contains:rate%2520limited
 * &filter=attempts:between:1,5
 * &filter=lastError:isEmpty
 * &q=tagging
 * ```
 *
 * `columnId:operator[:value]`, with each value segment `encodeURIComponent`-ed
 * so a value containing `:` or `,` survives, and multi-value operands joined
 * with `,`. The double-encoding you see above (`%2520`) is
 * `URLSearchParams.toString()` re-encoding our `%20`; it is symmetric, so a
 * `toString()` → `new URLSearchParams()` round trip is lossless.
 *
 * ## Why arity, not a type tag, decides the shape on the way back
 *
 * Nothing in the wire format says "this is an array". It doesn't need to: the
 * operator already determines the operand's shape (`between` → a pair,
 * `isAnyOf` → a set, everything else → a scalar), so the encoding stays short
 * and human-editable in an address bar.
 *
 * Scalar TYPE is a different question, and the one thing a URL genuinely cannot
 * carry: `attempts:equals:3` is indistinguishable from a text `'3'`. Pass the
 * table's `columns` to {@link readDataTableUrlState} and each value is coerced
 * by its column's `filterType`; omit them and every scalar comes back a string.
 * Always pass them when you have them.
 */

import type {
  DataTableColumn,
  DataTableFilter,
  DataTableFilterModel,
  DataTableFilterValue,
  FilterOperator,
} from '../types';
import { filterTypeOf, operatorArity } from './operators';

/** Repeated param carrying one encoded filter each. */
export const DATATABLE_FILTER_PARAM = 'filter';
/** Param carrying the global quick-search term. */
export const DATATABLE_SEARCH_PARAM = 'q';

export interface DataTableUrlState {
  filters: DataTableFilterModel;
  search: string;
}

export interface DataTableUrlOptions<Row = unknown> {
  /** Override the repeated filter param name. Default `'filter'`. */
  filterParam?: string;
  /** Override the quick-search param name. Default `'q'`. */
  searchParam?: string;
  /**
   * The table's columns. Supplying them lets scalar operands be coerced back to
   * `number` / `boolean` by each column's `filterType`. Without them every
   * scalar decodes as a `string`.
   */
  columns?: DataTableColumn<Row>[];
}

// ---------------------------------------------------------------------------
// One filter <-> one param value
// ---------------------------------------------------------------------------

function encodeSegment(raw: string | number | boolean): string {
  return encodeURIComponent(String(raw));
}

/** Encode a single filter as a `columnId:operator[:value]` param value. */
export function encodeFilter(filter: DataTableFilter): string {
  const head = `${encodeSegment(filter.columnId)}:${encodeSegment(filter.operator)}`;
  const arity = operatorArity(filter.operator);
  if (arity === 0 || filter.value === null) return head;
  const body = Array.isArray(filter.value)
    ? filter.value.map(encodeSegment).join(',')
    : encodeSegment(filter.value);
  return `${head}:${body}`;
}

function coerceScalar(raw: string, filterType: string | undefined): string | number | boolean {
  if (filterType === 'number') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : raw;
  }
  if (filterType === 'boolean') return raw === 'true';
  return raw;
}

/**
 * Decode one param value. Returns `null` for anything malformed — a hand-edited
 * or stale URL should drop the offending filter, never throw on render.
 */
export function decodeFilter<Row>(
  encoded: string,
  columns?: DataTableColumn<Row>[],
): DataTableFilter | null {
  // Only the FIRST two colons are delimiters; the value segment may itself be
  // an encoded string, and splitting greedily would truncate it.
  const first = encoded.indexOf(':');
  if (first <= 0) return null;
  const second = encoded.indexOf(':', first + 1);

  const columnId = safeDecode(encoded.slice(0, first));
  const operator = safeDecode(
    second === -1 ? encoded.slice(first + 1) : encoded.slice(first + 1, second),
  ) as FilterOperator;
  if (!columnId || !operator) return null;

  const rawValue = second === -1 ? null : encoded.slice(second + 1);
  const arity = operatorArity(operator);
  const filterType = columns
    ? (() => {
        const column = columns.find((entry) => entry.id === columnId);
        return column ? filterTypeOf(column) : undefined;
      })()
    : undefined;

  let value: DataTableFilterValue;
  if (arity === 0 || rawValue === null) {
    value = null;
  } else if (arity === 2 || arity === 'many') {
    const parts = rawValue === '' ? [] : rawValue.split(',');
    value = parts.map((part) => coerceScalar(safeDecode(part), filterType)) as (
      | string
      | number
    )[];
  } else {
    value = coerceScalar(safeDecode(rawValue), filterType);
  }

  return { columnId, operator, value };
}

function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    // A stray `%` in a hand-typed URL throws in decodeURIComponent; the literal
    // text is a better answer than losing the whole filter.
    return raw;
  }
}

// ---------------------------------------------------------------------------
// Whole-state read / write
// ---------------------------------------------------------------------------

/**
 * Read the filter model and quick-search term out of a `URLSearchParams`.
 * Unknown / malformed filter params are dropped silently.
 */
export function readDataTableUrlState<Row>(
  params: URLSearchParams,
  options: DataTableUrlOptions<Row> = {},
): DataTableUrlState {
  const filterParam = options.filterParam ?? DATATABLE_FILTER_PARAM;
  const searchParam = options.searchParam ?? DATATABLE_SEARCH_PARAM;

  const filters = params
    .getAll(filterParam)
    .map((encoded) => decodeFilter(encoded, options.columns))
    .filter((filter): filter is DataTableFilter => filter !== null);

  return { filters, search: params.get(searchParam) ?? '' };
}

/**
 * Write the filter model and quick-search term into a COPY of `params`, leaving
 * every unrelated param (page, sort, tab, …) untouched. Returns the copy — the
 * caller decides whether that becomes a push or a replace.
 *
 * An empty model / empty search removes its param entirely rather than leaving
 * `?filter=&q=` behind, so a cleared table produces a clean URL.
 */
export function writeDataTableUrlState<Row>(
  params: URLSearchParams,
  state: Partial<DataTableUrlState>,
  options: DataTableUrlOptions<Row> = {},
): URLSearchParams {
  const filterParam = options.filterParam ?? DATATABLE_FILTER_PARAM;
  const searchParam = options.searchParam ?? DATATABLE_SEARCH_PARAM;
  const next = new URLSearchParams(params);

  if (state.filters !== undefined) {
    next.delete(filterParam);
    for (const filter of state.filters) next.append(filterParam, encodeFilter(filter));
  }

  if (state.search !== undefined) {
    if (state.search.trim() === '') next.delete(searchParam);
    else next.set(searchParam, state.search);
  }

  return next;
}
