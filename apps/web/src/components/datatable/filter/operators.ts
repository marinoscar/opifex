/**
 * DataTable — the operator catalog.
 *
 * One table maps a column's {@link DataTableFilterType} onto the operators the
 * filter UI offers for it, and one function decides how many operands each
 * operator takes. Everything else in `filter/` reads from here, so adding an
 * operator is a single-file change.
 *
 * ## Why a declared type, not an inferred one
 *
 * The operator set could have been inferred from the first row's value. It
 * isn't, because inference is unstable in exactly the cases that matter: an
 * empty page has nothing to infer from, and a nullable column whose first page
 * happens to be all nulls would silently offer text operators for a number.
 * A column declares `filterType` once and the UI is deterministic forever.
 *
 * ## Why the defaults are narrow
 *
 * The default sets are the ones issue #254 specifies, and they are short on
 * purpose — six operators on a text column is a menu nobody reads. A column
 * that genuinely needs more pins them explicitly:
 * `filterable: ['contains', 'endsWith', 'isNotEmpty']`.
 */

import type {
  DataTableColumn,
  DataTableFilterType,
  FilterOperator,
} from '../types';

/** Assumed when a filterable column declares no `filterType`. */
export const DEFAULT_FILTER_TYPE: DataTableFilterType = 'text';

/**
 * The default operator set per value type — issue #254's catalog, verbatim.
 * Order is the order the operator picker lists them in, so the first entry is
 * also the default operator for a fresh filter on that type.
 */
export const OPERATORS_BY_FILTER_TYPE: Record<DataTableFilterType, FilterOperator[]> = {
  text: ['contains', 'equals', 'startsWith', 'isEmpty'],
  number: ['equals', 'gt', 'lt', 'between'],
  date: ['before', 'after', 'between'],
  enum: ['is', 'isNot', 'isAnyOf'],
  boolean: ['is'],
};

/**
 * Human labels. Number columns override a few so the picker reads `=`, `>`, `<`
 * rather than "equals / is greater than / is less than", which is how anyone
 * scanning a numeric filter actually thinks about it.
 */
const OPERATOR_LABELS: Record<FilterOperator, string> = {
  equals: 'equals',
  contains: 'contains',
  startsWith: 'starts with',
  endsWith: 'ends with',
  gt: 'is greater than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  between: 'is between',
  before: 'is before',
  after: 'is after',
  is: 'is',
  isNot: 'is not',
  isAnyOf: 'is any of',
  in: 'is any of',
  isEmpty: 'is empty',
  isNotEmpty: 'is not empty',
};

const NUMBER_OPERATOR_LABELS: Partial<Record<FilterOperator, string>> = {
  equals: '=',
  gt: '>',
  lt: '<',
  gte: '≥',
  lte: '≤',
};

/** Display label for an operator, in the context of a value type. */
export function operatorLabel(
  operator: FilterOperator,
  filterType: DataTableFilterType = DEFAULT_FILTER_TYPE,
): string {
  if (filterType === 'number') {
    return NUMBER_OPERATOR_LABELS[operator] ?? OPERATOR_LABELS[operator];
  }
  return OPERATOR_LABELS[operator];
}

/**
 * How many operands an operator takes.
 *
 *  - `0`      — `isEmpty` / `isNotEmpty`: the operator IS the whole predicate.
 *  - `1`      — one value.
 *  - `2`      — `between`: a `[from, to]` tuple.
 *  - `'many'` — `isAnyOf` / `in`: a set.
 */
export type OperatorArity = 0 | 1 | 2 | 'many';

export function operatorArity(operator: FilterOperator): OperatorArity {
  if (operator === 'isEmpty' || operator === 'isNotEmpty') return 0;
  if (operator === 'between') return 2;
  if (operator === 'isAnyOf' || operator === 'in') return 'many';
  return 1;
}

/** The value type a column filters as. */
export function filterTypeOf<Row>(column: DataTableColumn<Row>): DataTableFilterType {
  return column.filterType ?? DEFAULT_FILTER_TYPE;
}

/**
 * Whether a column offers filtering at all.
 *
 * An `enum` column with no `enumValues` is treated as NOT filterable: the
 * operand picker would have nothing to list, and an operator you cannot supply a
 * value for is exactly the "looks live, does nothing" affordance the contract
 * refuses elsewhere (see `sortable`'s opt-in rationale).
 */
export function isFilterableColumn<Row>(column: DataTableColumn<Row>): boolean {
  const declared =
    column.filterable === true ||
    (Array.isArray(column.filterable) && column.filterable.length > 0);
  if (!declared) return false;
  if (filterTypeOf(column) === 'enum') return (column.enumValues?.length ?? 0) > 0;
  return true;
}

/** Every filterable column, in declaration order. */
export function filterableColumns<Row>(
  columns: DataTableColumn<Row>[],
): DataTableColumn<Row>[] {
  return columns.filter(isFilterableColumn);
}

/**
 * The operators offered for a column: the explicit array when one is declared,
 * otherwise the default set for its value type.
 */
export function operatorsForColumn<Row>(column: DataTableColumn<Row>): FilterOperator[] {
  if (Array.isArray(column.filterable) && column.filterable.length > 0) {
    return column.filterable;
  }
  return OPERATORS_BY_FILTER_TYPE[filterTypeOf(column)];
}

/** The operator a fresh filter on this column starts with. */
export function defaultOperatorForColumn<Row>(column: DataTableColumn<Row>): FilterOperator {
  return operatorsForColumn(column)[0];
}

/** Every column marked `searchable`, in declaration order. */
export function searchableColumns<Row>(
  columns: DataTableColumn<Row>[],
): DataTableColumn<Row>[] {
  return columns.filter((column) => column.searchable === true);
}
