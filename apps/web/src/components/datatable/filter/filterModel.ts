/**
 * DataTable — normalized filter model helpers.
 *
 * Pure functions over `DataTableFilterModel`. No React, no MUI: the model is
 * data a page owns, and everything that reads or writes it — the panel, the
 * chips, the URL helper, and a calling page mapping filters onto query params —
 * shares these primitives so "what counts as a complete filter" has exactly one
 * definition.
 */

import type {
  DataTableColumn,
  DataTableFilter,
  DataTableFilterModel,
  DataTableFilterValue,
} from '../types';
import {
  defaultOperatorForColumn,
  filterTypeOf,
  operatorArity,
  operatorLabel,
} from './operators';

/** Find the column a filter targets, if the table still declares it. */
export function columnForFilter<Row>(
  columns: DataTableColumn<Row>[],
  filter: DataTableFilter,
): DataTableColumn<Row> | undefined {
  return columns.find((column) => column.id === filter.columnId);
}

/**
 * The blank operand for a fresh filter: `null` for a 0-arity operator, an empty
 * pair for `between`, an empty set for `isAnyOf`, `''` otherwise.
 *
 * `between` starts as `['', '']` rather than `null` so the two inputs stay
 * controlled from the first render (a React input that switches from
 * uncontrolled to controlled warns, and worse, drops the first keystroke).
 */
export function blankValueFor(arity: ReturnType<typeof operatorArity>): DataTableFilterValue {
  if (arity === 0) return null;
  if (arity === 2) return ['', ''];
  if (arity === 'many') return [];
  return '';
}

/** A fresh, not-yet-complete filter targeting `column`. */
export function draftFilterFor<Row>(column: DataTableColumn<Row>): DataTableFilter {
  const operator = defaultOperatorForColumn(column);
  const filterType = filterTypeOf(column);
  const arity = operatorArity(operator);
  // A boolean filter has exactly two meaningful operands and no "empty" state
  // worth making the user pick, so it opens on `true`.
  const value =
    filterType === 'boolean' && arity === 1 ? true : blankValueFor(arity);
  return { columnId: column.id, operator, value };
}

/**
 * Whether a filter carries enough information to be sent to the server.
 *
 * The panel keeps an incomplete filter as a LOCAL draft and never emits it —
 * emitting `{ columnId: 'status', operator: 'is', value: '' }` would make the
 * page refetch with a meaningless param on the first click of "Add filter".
 */
export function isFilterComplete(filter: DataTableFilter): boolean {
  const arity = operatorArity(filter.operator);
  if (arity === 0) return true;
  if (arity === 2) {
    return (
      Array.isArray(filter.value) &&
      filter.value.length === 2 &&
      filter.value.every((entry) => entry !== '' && entry !== null && entry !== undefined)
    );
  }
  if (arity === 'many') return Array.isArray(filter.value) && filter.value.length > 0;
  if (typeof filter.value === 'boolean') return true;
  if (typeof filter.value === 'number') return Number.isFinite(filter.value);
  return typeof filter.value === 'string' && filter.value.trim() !== '';
}

/** Structural identity, used to key React lists and to reject exact duplicates. */
export function filterKey(filter: DataTableFilter): string {
  return `${filter.columnId}|${filter.operator}|${JSON.stringify(filter.value ?? null)}`;
}

export function sameFilter(a: DataTableFilter, b: DataTableFilter): boolean {
  return filterKey(a) === filterKey(b);
}

/** Whether `model` already contains an identical filter. */
export function containsFilter(model: DataTableFilterModel, filter: DataTableFilter): boolean {
  return model.some((entry) => sameFilter(entry, filter));
}

/** Human-readable operand, used in chip labels. */
export function describeFilterValue<Row>(
  filter: DataTableFilter,
  column: DataTableColumn<Row> | undefined,
): string {
  const arity = operatorArity(filter.operator);
  if (arity === 0) return '';

  const labelOf = (raw: string | number | boolean): string => {
    if (typeof raw === 'boolean') return raw ? 'Yes' : 'No';
    if (column?.enumValues) {
      const match = column.enumValues.find((option) => option.value === String(raw));
      if (match) return match.label;
    }
    return String(raw);
  };

  if (arity === 2 && Array.isArray(filter.value)) {
    return `${labelOf(filter.value[0])} and ${labelOf(filter.value[1])}`;
  }
  if (Array.isArray(filter.value)) return filter.value.map(labelOf).join(', ');
  if (filter.value === null) return '';
  return labelOf(filter.value);
}

/**
 * The chip label: `"Status is Failed"`.
 *
 * Falls back to the raw `columnId` when the table no longer declares that
 * column — a filter restored from a URL after a column was renamed should read
 * as something removable, not crash the chip strip.
 */
export function filterChipLabel<Row>(
  filter: DataTableFilter,
  columns: DataTableColumn<Row>[],
): string {
  const column = columnForFilter(columns, filter);
  const label = column?.label ?? filter.columnId;
  const operator = operatorLabel(
    filter.operator,
    column ? filterTypeOf(column) : undefined,
  );
  const value = describeFilterValue(filter, column);
  return value ? `${label} ${operator} ${value}` : `${label} ${operator}`;
}

// ---------------------------------------------------------------------------
// Model transitions — every one returns a NEW array
// ---------------------------------------------------------------------------

export function addFilter(
  model: DataTableFilterModel,
  filter: DataTableFilter,
): DataTableFilterModel {
  if (containsFilter(model, filter)) return model;
  return [...model, filter];
}

export function removeFilterAt(
  model: DataTableFilterModel,
  index: number,
): DataTableFilterModel {
  return model.filter((_, position) => position !== index);
}

export function replaceFilterAt(
  model: DataTableFilterModel,
  index: number,
  filter: DataTableFilter,
): DataTableFilterModel {
  return model.map((entry, position) => (position === index ? filter : entry));
}
