/**
 * Component tests — DataTable per-column filtering & global quick search (#254).
 *
 * What this suite is actually asserting:
 *
 *  1. The **operator catalog** — the right operators per declared value type,
 *     both as a pure function and as the options a user is offered.
 *  2. The **debounce contract** — the quick-search box repaints per keystroke
 *     while `onChange` fires ONCE, after the pause. This is the one behaviour
 *     the component exists to provide; a naive debounce would fail it.
 *  3. **Server-side by construction** — adding, editing and removing a filter
 *     emits a normalized model, and the table never drops a row of its own
 *     accord. A test that only checked the emission would still pass if the
 *     component secretly filtered `rows`, so both halves are asserted.
 *  4. The **three filter surfaces**: an inline row on desktop, a collapsed panel
 *     with an active count on tablet, a full-screen focus-trapping sheet plus a
 *     scrollable chip strip on a phone.
 *  5. The **URL helper** round-trips, including the cases that break a naive
 *     `split(':')`: values containing the delimiter, multi-value operands, and
 *     operators with no operand at all.
 *  6. The issue **#243 guard**, extended to every control this issue adds.
 *
 * Test doubles mirror `ResponsiveDataTable.test.tsx`: a container width driven
 * by a controllable ResizeObserver, and a `matchMedia` pinned to a 1440px
 * viewport so a `mobile` result can only have come from the container.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { act, screen, within, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../../__tests__/utils/test-utils';
import { DataTable } from '../DataTable';
import { FILTER_COUNT_CLASS } from '../filter/DataTableFilterBar';
import {
  OPERATORS_BY_FILTER_TYPE,
  operatorArity,
  operatorLabel,
  operatorsForColumn,
  isFilterableColumn,
  filterableColumns,
  searchableColumns,
} from '../filter/operators';
import {
  addFilter,
  containsFilter,
  filterChipLabel,
  isFilterComplete,
  draftFilterFor,
  removeFilterAt,
} from '../filter/filterModel';
import {
  decodeFilter,
  encodeFilter,
  readDataTableUrlState,
  writeDataTableUrlState,
} from '../filter/filterUrl';
import type { DataTableColumn, DataTableFilterModel } from '../types';
import { assertNoInvisibleHitTargets, describeControl } from './testUtils/a11yGuards';

// ---------------------------------------------------------------------------
// Layout stubs (same recipe as the #253 suite)
// ---------------------------------------------------------------------------

const VIEWPORT_WIDTH = 1440;
const VIEWPORT_HEIGHT = 900;

let containerWidth = 1400;

interface FakeObserver {
  callback: ResizeObserverCallback;
  targets: Set<Element>;
  fire: () => void;
}

const observers = new Set<FakeObserver>();

function installLayoutStubs() {
  for (const prop of ['clientWidth', 'offsetWidth', 'scrollWidth'] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get: () => containerWidth,
    });
  }
  for (const prop of ['clientHeight', 'offsetHeight', 'scrollHeight'] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get: () => VIEWPORT_HEIGHT,
    });
  }

  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return {
      width: containerWidth,
      height: VIEWPORT_HEIGHT,
      top: 0,
      left: 0,
      right: containerWidth,
      bottom: VIEWPORT_HEIGHT,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };

  class ControllableResizeObserver {
    private readonly entry: FakeObserver;

    constructor(callback: ResizeObserverCallback) {
      this.entry = {
        callback,
        targets: new Set<Element>(),
        fire: () => {
          const entries = Array.from(this.entry.targets, (target) => ({
            target,
            contentRect: { width: containerWidth, height: VIEWPORT_HEIGHT },
          })) as unknown as ResizeObserverEntry[];
          if (entries.length > 0) {
            this.entry.callback(entries, this as unknown as ResizeObserver);
          }
        },
      };
      observers.add(this.entry);
    }

    observe(target: Element) {
      this.entry.targets.add(target);
      this.entry.fire();
    }
    unobserve(target: Element) {
      this.entry.targets.delete(target);
    }
    disconnect() {
      this.entry.targets.clear();
      observers.delete(this.entry);
    }
  }

  global.ResizeObserver = ControllableResizeObserver as unknown as typeof ResizeObserver;

  window.matchMedia = vi.fn().mockImplementation((query: string) => {
    const max = /max-width:\s*([\d.]+)px/.exec(query);
    const min = /min-width:\s*([\d.]+)px/.exec(query);
    let matches = true;
    if (max) matches = matches && VIEWPORT_WIDTH <= Number.parseFloat(max[1]);
    if (min) matches = matches && VIEWPORT_WIDTH >= Number.parseFloat(min[1]);
    return {
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
  }) as unknown as typeof window.matchMedia;
}

beforeAll(() => {
  installLayoutStubs();
});

beforeEach(() => {
  containerWidth = 1400;
});

// ---------------------------------------------------------------------------
// Fixture — one column per filter type
// ---------------------------------------------------------------------------

interface Job {
  id: string;
  type: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  attempts: number;
  createdAt: string;
  favorite: boolean;
  lastError: string | null;
}

const JOBS: Job[] = [
  {
    id: 'job-1',
    type: 'face_detection',
    status: 'succeeded',
    attempts: 1,
    createdAt: '2026-01-04',
    favorite: true,
    lastError: null,
  },
  {
    id: 'job-2',
    type: 'auto_tagging',
    status: 'failed',
    attempts: 3,
    createdAt: '2026-02-11',
    favorite: false,
    lastError: 'rate limited by provider',
  },
  {
    id: 'job-3',
    type: 'geocode',
    status: 'pending',
    attempts: 0,
    createdAt: '2026-03-19',
    favorite: false,
    lastError: null,
  },
];

const STATUS_VALUES = [
  { value: 'pending', label: 'Pending' },
  { value: 'running', label: 'Running' },
  { value: 'succeeded', label: 'Succeeded' },
  { value: 'failed', label: 'Failed' },
];

const COLUMNS: DataTableColumn<Job>[] = [
  {
    id: 'type',
    label: 'Type',
    priority: 'primary',
    value: (r) => r.type,
    filterable: true,
    filterType: 'text',
    searchable: true,
  },
  {
    id: 'status',
    label: 'Status',
    priority: 'primary',
    value: (r) => r.status,
    filterable: true,
    filterType: 'enum',
    enumValues: STATUS_VALUES,
    searchable: true,
  },
  {
    id: 'attempts',
    label: 'Attempts',
    priority: 'secondary',
    align: 'right',
    value: (r) => r.attempts,
    filterable: true,
    filterType: 'number',
  },
  {
    id: 'createdAt',
    label: 'Created',
    priority: 'secondary',
    value: (r) => r.createdAt,
    filterable: true,
    filterType: 'date',
  },
  {
    id: 'favorite',
    label: 'Favorite',
    priority: 'detail',
    value: (r) => String(r.favorite),
    filterable: true,
    filterType: 'boolean',
  },
  {
    id: 'lastError',
    label: 'Last error',
    priority: 'detail',
    truncate: true,
    value: (r) => r.lastError,
    // Explicitly pinned — narrower AND wider than the text default.
    filterable: ['contains', 'isEmpty', 'isNotEmpty'],
    searchable: true,
  },
  // Deliberately NOT filterable, to prove the column picker is a subset.
  { id: 'id', label: 'Job ID', priority: 'detail', value: (r) => r.id },
];

const rowId = (job: Job) => job.id;

type TableProps = React.ComponentProps<typeof DataTable<Job>>;

function renderAtWidth(width: number, overrides: Partial<TableProps> = {}) {
  containerWidth = width;
  return render(
    <DataTable<Job>
      columns={COLUMNS}
      rows={JOBS}
      rowId={rowId}
      ariaLabel="Enrichment jobs"
      {...overrides}
    />,
  );
}

/** Open a MUI Select by its visible label and pick an option by name. */
async function pickOption(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(screen.getByRole('combobox', { name: label }));
  const listbox = await screen.findByRole('listbox');
  await user.click(within(listbox).getByRole('option', { name: option }));
}

/** The option NAMES currently offered by a select, without choosing one. */
async function optionsOf(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole('combobox', { name: label }));
  const listbox = await screen.findByRole('listbox');
  const names = within(listbox)
    .getAllByRole('option')
    .map((option) => option.textContent ?? '');
  await user.keyboard('{Escape}');
  return names;
}

// ---------------------------------------------------------------------------
// 1. The operator catalog (pure)
// ---------------------------------------------------------------------------

describe('filter operators — per value type', () => {
  it('publishes issue #254\'s operator sets verbatim', () => {
    expect(OPERATORS_BY_FILTER_TYPE).toEqual({
      text: ['contains', 'equals', 'startsWith', 'isEmpty'],
      number: ['equals', 'gt', 'lt', 'between'],
      date: ['before', 'after', 'between'],
      enum: ['is', 'isNot', 'isAnyOf'],
      boolean: ['is'],
    });
  });

  it('resolves a column to the operator set for its declared type', () => {
    const byId = (id: string) => COLUMNS.find((column) => column.id === id)!;

    expect(operatorsForColumn(byId('type'))).toEqual([
      'contains',
      'equals',
      'startsWith',
      'isEmpty',
    ]);
    expect(operatorsForColumn(byId('attempts'))).toEqual(['equals', 'gt', 'lt', 'between']);
    expect(operatorsForColumn(byId('createdAt'))).toEqual(['before', 'after', 'between']);
    expect(operatorsForColumn(byId('status'))).toEqual(['is', 'isNot', 'isAnyOf']);
    expect(operatorsForColumn(byId('favorite'))).toEqual(['is']);
  });

  it('defaults an undeclared filterType to text', () => {
    expect(operatorsForColumn({ id: 'x', label: 'X', priority: 'primary', filterable: true })).toEqual(
      OPERATORS_BY_FILTER_TYPE.text,
    );
  });

  it('lets an explicit array pin the operators, in the order given', () => {
    const byId = COLUMNS.find((column) => column.id === 'lastError')!;
    expect(operatorsForColumn(byId)).toEqual(['contains', 'isEmpty', 'isNotEmpty']);
  });

  it('labels numeric comparisons as symbols, everything else as words', () => {
    expect(operatorLabel('equals', 'number')).toBe('=');
    expect(operatorLabel('gt', 'number')).toBe('>');
    expect(operatorLabel('lt', 'number')).toBe('<');
    expect(operatorLabel('equals', 'text')).toBe('equals');
    expect(operatorLabel('before', 'date')).toBe('is before');
    expect(operatorLabel('isAnyOf', 'enum')).toBe('is any of');
  });

  it('knows how many operands each operator takes', () => {
    expect(operatorArity('contains')).toBe(1);
    expect(operatorArity('is')).toBe(1);
    expect(operatorArity('between')).toBe(2);
    expect(operatorArity('isAnyOf')).toBe('many');
    expect(operatorArity('in')).toBe('many');
    expect(operatorArity('isEmpty')).toBe(0);
    expect(operatorArity('isNotEmpty')).toBe(0);
  });

  it('treats an enum column with no enumValues as not filterable', () => {
    expect(
      isFilterableColumn({
        id: 'status',
        label: 'Status',
        priority: 'primary',
        filterable: true,
        filterType: 'enum',
      }),
    ).toBe(false);

    expect(isFilterableColumn(COLUMNS.find((c) => c.id === 'status')!)).toBe(true);
    expect(isFilterableColumn(COLUMNS.find((c) => c.id === 'id')!)).toBe(false);
  });

  it('selects the filterable and searchable subsets of a column set', () => {
    expect(filterableColumns(COLUMNS).map((c) => c.id)).toEqual([
      'type',
      'status',
      'attempts',
      'createdAt',
      'favorite',
      'lastError',
    ]);
    expect(searchableColumns(COLUMNS).map((c) => c.id)).toEqual(['type', 'status', 'lastError']);
  });
});

// ---------------------------------------------------------------------------
// 2. The operators a user is actually offered
// ---------------------------------------------------------------------------

describe('DataTable — operators offered in the filter UI', () => {
  it('offers only the filterable columns in the column picker', async () => {
    const user = userEvent.setup();
    renderAtWidth(1400, { filters: [], onFiltersChange: vi.fn() });

    expect(await optionsOf(user, 'Column')).toEqual([
      'Type',
      'Status',
      'Attempts',
      'Created',
      'Favorite',
      'Last error',
    ]);
  });

  it('swaps the operator set when the column type changes', async () => {
    const user = userEvent.setup();
    renderAtWidth(1400, { filters: [], onFiltersChange: vi.fn() });

    // text (the first filterable column, so the default draft)
    expect(await optionsOf(user, 'Operator')).toEqual([
      'contains',
      'equals',
      'starts with',
      'is empty',
    ]);

    await pickOption(user, 'Column', 'Attempts');
    expect(await optionsOf(user, 'Operator')).toEqual(['=', '>', '<', 'is between']);

    await pickOption(user, 'Column', 'Created');
    expect(await optionsOf(user, 'Operator')).toEqual(['is before', 'is after', 'is between']);

    await pickOption(user, 'Column', 'Status');
    expect(await optionsOf(user, 'Operator')).toEqual(['is', 'is not', 'is any of']);

    await pickOption(user, 'Column', 'Favorite');
    expect(await optionsOf(user, 'Operator')).toEqual(['is']);
  });

  it('draws the operand control the value type calls for', async () => {
    const user = userEvent.setup();
    renderAtWidth(1400, { filters: [], onFiltersChange: vi.fn() });

    // text -> free text
    expect(screen.getByRole('textbox', { name: 'Value' })).toBeInTheDocument();

    // number -> a spinbutton
    await pickOption(user, 'Column', 'Attempts');
    expect(screen.getByRole('spinbutton', { name: 'Value' })).toBeInTheDocument();

    // enum -> a select over enumValues, using the LABELS not the raw values
    await pickOption(user, 'Column', 'Status');
    expect(await optionsOf(user, 'Value')).toEqual([
      'Pending',
      'Running',
      'Succeeded',
      'Failed',
    ]);

    // boolean -> Yes / No
    await pickOption(user, 'Column', 'Favorite');
    expect(await optionsOf(user, 'Value')).toEqual(['Yes', 'No']);
  });

  it('replaces the single operand with a From/To pair for `between`', async () => {
    const user = userEvent.setup();
    renderAtWidth(1400, { filters: [], onFiltersChange: vi.fn() });

    await pickOption(user, 'Column', 'Attempts');
    await pickOption(user, 'Operator', 'is between');

    expect(screen.getByRole('spinbutton', { name: 'From' })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'To' })).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: 'Value' })).not.toBeInTheDocument();
  });

  it('drops the operand control entirely for a 0-arity operator', async () => {
    const user = userEvent.setup();
    renderAtWidth(1400, { filters: [], onFiltersChange: vi.fn() });

    await pickOption(user, 'Operator', 'is empty');

    expect(screen.queryByRole('textbox', { name: 'Value' })).not.toBeInTheDocument();
    // ...and "is empty" is complete on its own, so Add is live immediately.
    expect(screen.getByTestId('datatable-filter-apply')).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// 3. Quick search — the debounce is on the EMISSION
// ---------------------------------------------------------------------------

describe('DataTable — quick search debounce', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits once after the pause, not once per keystroke', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    renderAtWidth(1400, { quickSearch: { value: '', onChange } });

    const box = screen.getByRole('searchbox', { name: 'Search' });

    fireEvent.change(box, { target: { value: 'f' } });
    fireEvent.change(box, { target: { value: 'fa' } });
    fireEvent.change(box, { target: { value: 'fac' } });

    // The INPUT keeps up with the typist...
    expect(box).toHaveValue('fac');
    // ...while nothing has gone to the server yet.
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('fac');
  });

  it('restarts the window on each keystroke rather than emitting a prefix', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    renderAtWidth(1400, { quickSearch: { value: '', onChange } });

    const box = screen.getByRole('searchbox', { name: 'Search' });

    fireEvent.change(box, { target: { value: 'ge' } });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    fireEvent.change(box, { target: { value: 'geo' } });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('geo');
  });

  it('honours a per-instance debounceMs', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    renderAtWidth(1400, { quickSearch: { value: '', onChange, debounceMs: 1000 } });

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'x' },
    });

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(onChange).toHaveBeenCalledWith('x');
  });

  it('clears immediately — an explicit gesture has nothing to debounce', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderAtWidth(1400, { quickSearch: { value: 'geocode', onChange } });

    await user.click(screen.getByRole('button', { name: 'Clear search' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('names the searchable columns in the default placeholder', () => {
    renderAtWidth(1400, { quickSearch: { value: '', onChange: vi.fn() } });
    expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveAttribute(
      'placeholder',
      'Search Type, Status or Last error',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Filter state round-trips, and NOTHING is filtered locally
// ---------------------------------------------------------------------------

describe('DataTable — filter model round-trip', () => {
  it('emits a normalized filter when one is added', async () => {
    const user = userEvent.setup();
    const onFiltersChange = vi.fn();
    renderAtWidth(1400, { filters: [], onFiltersChange });

    // Add is inert until the draft is complete — a half-built filter must never
    // reach the page and trigger a refetch.
    expect(screen.getByTestId('datatable-filter-apply')).toBeDisabled();

    await user.type(screen.getByRole('textbox', { name: 'Value' }), 'geo');
    await user.click(screen.getByTestId('datatable-filter-apply'));

    expect(onFiltersChange).toHaveBeenCalledTimes(1);
    expect(onFiltersChange).toHaveBeenCalledWith([
      { columnId: 'type', operator: 'contains', value: 'geo' },
    ]);
  });

  it('emits enum, number and 0-arity filters in the same normalized shape', async () => {
    const user = userEvent.setup();
    const onFiltersChange = vi.fn();
    renderAtWidth(1400, { filters: [], onFiltersChange });

    await pickOption(user, 'Column', 'Status');
    await pickOption(user, 'Value', 'Failed');
    await user.click(screen.getByTestId('datatable-filter-apply'));
    expect(onFiltersChange).toHaveBeenLastCalledWith([
      { columnId: 'status', operator: 'is', value: 'failed' },
    ]);

    await pickOption(user, 'Column', 'Attempts');
    await pickOption(user, 'Operator', '>');
    await user.type(screen.getByRole('spinbutton', { name: 'Value' }), '2');
    await user.click(screen.getByTestId('datatable-filter-apply'));
    // Number columns emit a real number, not the input's string.
    expect(onFiltersChange).toHaveBeenLastCalledWith([
      { columnId: 'attempts', operator: 'gt', value: 2 },
    ]);

    await pickOption(user, 'Column', 'Last error');
    await pickOption(user, 'Operator', 'is empty');
    await user.click(screen.getByTestId('datatable-filter-apply'));
    expect(onFiltersChange).toHaveBeenLastCalledWith([
      { columnId: 'lastError', operator: 'isEmpty', value: null },
    ]);
  });

  it('emits a [from, to] pair for `between`', async () => {
    const user = userEvent.setup();
    const onFiltersChange = vi.fn();
    renderAtWidth(1400, { filters: [], onFiltersChange });

    await pickOption(user, 'Column', 'Attempts');
    await pickOption(user, 'Operator', 'is between');
    await user.type(screen.getByRole('spinbutton', { name: 'From' }), '1');
    // Half a pair is not a filter.
    expect(screen.getByTestId('datatable-filter-apply')).toBeDisabled();

    await user.type(screen.getByRole('spinbutton', { name: 'To' }), '5');
    await user.click(screen.getByTestId('datatable-filter-apply'));

    expect(onFiltersChange).toHaveBeenLastCalledWith([
      { columnId: 'attempts', operator: 'between', value: [1, 5] },
    ]);
  });

  it('appends to the existing model rather than replacing it', async () => {
    const user = userEvent.setup();
    const onFiltersChange = vi.fn();
    const existing: DataTableFilterModel = [
      { columnId: 'status', operator: 'is', value: 'failed' },
    ];
    renderAtWidth(1400, { filters: existing, onFiltersChange });

    await user.type(screen.getByRole('textbox', { name: 'Value' }), 'geo');
    await user.click(screen.getByTestId('datatable-filter-apply'));

    expect(onFiltersChange).toHaveBeenCalledWith([
      { columnId: 'status', operator: 'is', value: 'failed' },
      { columnId: 'type', operator: 'contains', value: 'geo' },
    ]);
  });

  /**
   * The load-bearing negative. Every assertion above would still pass if the
   * component quietly filtered `rows` itself — which would be wrong, because
   * with server-side pagination it would only ever filter the CURRENT PAGE.
   */
  it('never filters rows itself — the row set is exactly what it was handed', () => {
    renderAtWidth(1400, {
      filters: [
        { columnId: 'status', operator: 'is', value: 'failed' },
        { columnId: 'type', operator: 'contains', value: 'nothing-matches-this' },
      ],
      onFiltersChange: vi.fn(),
    });

    // All three rows are still drawn, filters notwithstanding.
    expect(screen.getByText('face_detection')).toBeInTheDocument();
    expect(screen.getByText('auto_tagging')).toBeInTheDocument();
    expect(screen.getByText('geocode')).toBeInTheDocument();
  });

  it('is fully controlled — a page that ignores the emission sees no change', async () => {
    const user = userEvent.setup();
    renderAtWidth(1400, { filters: [], onFiltersChange: vi.fn() });

    await user.type(screen.getByRole('textbox', { name: 'Value' }), 'geo');
    await user.click(screen.getByTestId('datatable-filter-apply'));

    // The page never fed a new model back, so no chip appeared.
    expect(screen.queryByTestId('datatable-filter-chip')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 5. Chips
// ---------------------------------------------------------------------------

describe('DataTable — active filter chips', () => {
  const FILTERS: DataTableFilterModel = [
    { columnId: 'status', operator: 'is', value: 'failed' },
    { columnId: 'attempts', operator: 'gt', value: 2 },
    { columnId: 'lastError', operator: 'isEmpty', value: null },
  ];

  it('describes each filter with the column label and the enum LABEL', () => {
    renderAtWidth(1400, { filters: FILTERS, onFiltersChange: vi.fn() });

    const chips = screen.getAllByTestId('datatable-filter-chip');
    expect(chips.map((chip) => chip.textContent)).toEqual([
      'Status is Failed',
      'Attempts > 2',
      'Last error is empty',
    ]);
  });

  it('removes exactly the chip that was clicked', async () => {
    const user = userEvent.setup();
    const onFiltersChange = vi.fn();
    renderAtWidth(1400, { filters: FILTERS, onFiltersChange });

    await user.click(screen.getByLabelText('Remove filter: Attempts > 2'));

    expect(onFiltersChange).toHaveBeenCalledTimes(1);
    expect(onFiltersChange).toHaveBeenCalledWith([
      { columnId: 'status', operator: 'is', value: 'failed' },
      { columnId: 'lastError', operator: 'isEmpty', value: null },
    ]);
  });

  it('clears the whole model from "Clear all"', async () => {
    const user = userEvent.setup();
    const onFiltersChange = vi.fn();
    renderAtWidth(1400, { filters: FILTERS, onFiltersChange });

    await user.click(screen.getByTestId('datatable-filter-clear-all'));
    expect(onFiltersChange).toHaveBeenCalledWith([]);
  });

  it('offers no "Clear all" for a single filter — the chip already is one', () => {
    renderAtWidth(1400, { filters: [FILTERS[0]], onFiltersChange: vi.fn() });
    expect(screen.queryByTestId('datatable-filter-clear-all')).not.toBeInTheDocument();
  });

  it('still renders a removable chip for a column the table no longer declares', () => {
    renderAtWidth(1400, {
      filters: [{ columnId: 'ghostColumn', operator: 'contains', value: 'x' }],
      onFiltersChange: vi.fn(),
    });
    // Falls back to the raw columnId rather than crashing on a URL-restored
    // filter whose column was renamed.
    expect(screen.getByTestId('datatable-filter-chip')).toHaveTextContent('ghostColumn contains x');
  });
});

// ---------------------------------------------------------------------------
// 6. The three filter surfaces
// ---------------------------------------------------------------------------

describe('DataTable — filter surface per layout', () => {
  const FILTERS: DataTableFilterModel = [
    { columnId: 'status', operator: 'is', value: 'failed' },
    { columnId: 'attempts', operator: 'gt', value: 2 },
  ];

  it('desktop: the filter row is on screen, with no Filters button', () => {
    renderAtWidth(1400, { filters: FILTERS, onFiltersChange: vi.fn() });

    expect(screen.getByTestId('datatable-filter-bar')).toHaveAttribute(
      'data-filter-surface',
      'desktop',
    );
    expect(screen.getByTestId('datatable-filter-editor')).toBeInTheDocument();
    expect(screen.queryByTestId('datatable-filter-toggle')).not.toBeInTheDocument();
    // Chips wrap; no sideways scroller on a wide layout.
    expect(screen.getByTestId('datatable-filter-chips')).toBeInTheDocument();
    expect(screen.queryByTestId('datatable-filter-chip-strip')).not.toBeInTheDocument();
  });

  it('tablet: the panel is collapsed behind a Filters button carrying the count', async () => {
    const user = userEvent.setup();
    renderAtWidth(800, { filters: FILTERS, onFiltersChange: vi.fn() });

    expect(screen.getByTestId('datatable-filter-bar')).toHaveAttribute(
      'data-filter-surface',
      'tablet',
    );

    const toggle = screen.getByTestId('datatable-filter-toggle');
    // The count is visible as a badge...
    expect(document.querySelector(`.${FILTER_COUNT_CLASS}`)).toHaveTextContent('2');
    // ...and spoken, since a badge bubble is invisible to a screen reader.
    expect(toggle).toHaveAccessibleName('Filters (2 active)');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    // Collapsed: no editor until asked for.
    expect(screen.queryByTestId('datatable-filter-editor')).not.toBeInTheDocument();

    await user.click(toggle);
    expect(screen.getByTestId('datatable-filter-panel')).toBeInTheDocument();
    expect(screen.getByTestId('datatable-filter-editor')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await user.click(toggle);
    expect(screen.queryByTestId('datatable-filter-editor')).not.toBeInTheDocument();
  });

  it('tablet: the Filters button reads plainly when nothing is applied', () => {
    renderAtWidth(800, { filters: [], onFiltersChange: vi.fn() });
    expect(screen.getByTestId('datatable-filter-toggle')).toHaveAccessibleName('Filters');
  });

  it('phone: filters open in a full-screen sheet that traps focus', async () => {
    const user = userEvent.setup();
    renderAtWidth(400, { filters: FILTERS, onFiltersChange: vi.fn() });

    expect(screen.getByTestId('datatable-filter-bar')).toHaveAttribute(
      'data-filter-surface',
      'mobile',
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('datatable-filter-toggle'));

    const sheet = await screen.findByRole('dialog');
    expect(sheet).toHaveAccessibleName('Filters');
    // MUI's modal marks everything outside inert; focus is inside the sheet.
    expect(sheet).toContainElement(document.activeElement as HTMLElement);
    expect(within(sheet).getByTestId('datatable-filter-editor')).toBeInTheDocument();

    await user.click(within(sheet).getByRole('button', { name: 'Close filters' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('phone: Escape closes the sheet', async () => {
    const user = userEvent.setup();
    renderAtWidth(400, { filters: [], onFiltersChange: vi.fn() });

    await user.click(screen.getByTestId('datatable-filter-toggle'));
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('phone: active filters are a horizontally scrollable chip strip', () => {
    renderAtWidth(400, { filters: FILTERS, onFiltersChange: vi.fn() });

    const strip = screen.getByTestId('datatable-filter-chip-strip');
    const style = getComputedStyle(strip);
    // The one place a horizontal scroller is correct: an explicit control that
    // owns its own overflow, not the document scrolling sideways.
    expect(style.overflowX).toBe('auto');
    expect(style.flexWrap).toBe('nowrap');
    expect(style.maxWidth).toBe('100%');
    expect(within(strip).getAllByTestId('datatable-filter-chip')).toHaveLength(2);
  });

  it('renders no filter bar at all when neither filtering nor search is configured', () => {
    renderAtWidth(1400);
    expect(screen.queryByTestId('datatable-filter-bar')).not.toBeInTheDocument();
  });

  it('renders search alone when no column is filterable', () => {
    containerWidth = 1400;
    render(
      <DataTable<Job>
        columns={COLUMNS.map(({ filterable: _filterable, ...rest }) => rest)}
        rows={JOBS}
        rowId={rowId}
        ariaLabel="Enrichment jobs"
        filters={[]}
        onFiltersChange={vi.fn()}
        quickSearch={{ value: '', onChange: vi.fn() }}
      />,
    );

    expect(screen.getByTestId('datatable-quick-search')).toBeInTheDocument();
    expect(screen.queryByTestId('datatable-filter-editor')).not.toBeInTheDocument();
    expect(screen.queryByTestId('datatable-filter-toggle')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 7. Filters survive a layout switch (state lives above the renderers)
// ---------------------------------------------------------------------------

function StatefulFilteredTable() {
  const [filters, setFilters] = useState<DataTableFilterModel>([
    { columnId: 'status', operator: 'is', value: 'failed' },
  ]);
  const [search, setSearch] = useState('tagging');

  return (
    <>
      <div data-testid="probe-filters">{JSON.stringify(filters)}</div>
      <div data-testid="probe-search">{search}</div>
      <DataTable<Job>
        columns={COLUMNS}
        rows={JOBS}
        rowId={rowId}
        ariaLabel="Enrichment jobs"
        filters={filters}
        onFiltersChange={setFilters}
        quickSearch={{ value: search, onChange: setSearch }}
      />
    </>
  );
}

describe('DataTable — filters survive a layout switch', () => {
  it('keeps the model and the search term across desktop -> mobile -> desktop', () => {
    containerWidth = 1400;
    render(<StatefulFilteredTable />);

    const expected = '[{"columnId":"status","operator":"is","value":"failed"}]';
    expect(screen.getByTestId('probe-filters')).toHaveTextContent(expected);
    expect(screen.getByTestId('datatable-filter-chips')).toBeInTheDocument();

    act(() => {
      containerWidth = 400;
      observers.forEach((observer) => observer.fire());
    });

    // Same state, different surface.
    expect(screen.getByTestId('probe-filters')).toHaveTextContent(expected);
    expect(screen.getByTestId('probe-search')).toHaveTextContent('tagging');
    expect(screen.getByTestId('datatable-filter-chip-strip')).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveValue('tagging');

    act(() => {
      containerWidth = 1400;
      observers.forEach((observer) => observer.fire());
    });

    expect(screen.getByTestId('probe-filters')).toHaveTextContent(expected);
    expect(screen.getByTestId('datatable-filter-chips')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 8. Model helpers (pure)
// ---------------------------------------------------------------------------

describe('filter model helpers', () => {
  it('recognises an incomplete draft', () => {
    expect(isFilterComplete({ columnId: 'type', operator: 'contains', value: '' })).toBe(false);
    expect(isFilterComplete({ columnId: 'type', operator: 'contains', value: '   ' })).toBe(false);
    expect(isFilterComplete({ columnId: 'type', operator: 'contains', value: 'geo' })).toBe(true);
    expect(isFilterComplete({ columnId: 'a', operator: 'between', value: [1, ''] })).toBe(false);
    expect(isFilterComplete({ columnId: 'a', operator: 'between', value: [1, 5] })).toBe(true);
    expect(isFilterComplete({ columnId: 'a', operator: 'isAnyOf', value: [] })).toBe(false);
    expect(isFilterComplete({ columnId: 'a', operator: 'isAnyOf', value: ['x'] })).toBe(true);
    expect(isFilterComplete({ columnId: 'a', operator: 'isEmpty', value: null })).toBe(true);
    // A boolean `false` is a real operand, not an empty one.
    expect(isFilterComplete({ columnId: 'a', operator: 'is', value: false })).toBe(true);
    // Zero likewise.
    expect(isFilterComplete({ columnId: 'a', operator: 'equals', value: 0 })).toBe(true);
  });

  it('opens a boolean draft on Yes rather than on nothing', () => {
    const column = COLUMNS.find((c) => c.id === 'favorite')!;
    expect(draftFilterFor(column)).toEqual({
      columnId: 'favorite',
      operator: 'is',
      value: true,
    });
  });

  it('rejects an exact duplicate instead of stacking identical filters', () => {
    const model: DataTableFilterModel = [
      { columnId: 'status', operator: 'is', value: 'failed' },
    ];
    const duplicate = { columnId: 'status', operator: 'is' as const, value: 'failed' };
    expect(containsFilter(model, duplicate)).toBe(true);
    expect(addFilter(model, duplicate)).toBe(model);
    // A different operand on the same column is NOT a duplicate.
    expect(addFilter(model, { columnId: 'status', operator: 'is', value: 'pending' })).toHaveLength(
      2,
    );
  });

  it('returns a new array from every transition', () => {
    const model: DataTableFilterModel = [
      { columnId: 'a', operator: 'contains', value: '1' },
      { columnId: 'b', operator: 'contains', value: '2' },
    ];
    const next = removeFilterAt(model, 0);
    expect(next).not.toBe(model);
    expect(model).toHaveLength(2);
    expect(next).toEqual([{ columnId: 'b', operator: 'contains', value: '2' }]);
  });

  it('builds a chip label from labels, not raw ids or values', () => {
    expect(
      filterChipLabel({ columnId: 'status', operator: 'isAnyOf', value: ['failed', 'pending'] }, COLUMNS),
    ).toBe('Status is any of Failed, Pending');
    expect(
      filterChipLabel({ columnId: 'attempts', operator: 'between', value: [1, 5] }, COLUMNS),
    ).toBe('Attempts is between 1 and 5');
    expect(filterChipLabel({ columnId: 'favorite', operator: 'is', value: true }, COLUMNS)).toBe(
      'Favorite is Yes',
    );
  });
});

// ---------------------------------------------------------------------------
// 9. URL serialization
// ---------------------------------------------------------------------------

describe('filter URL helper', () => {
  const MODEL: DataTableFilterModel = [
    { columnId: 'status', operator: 'is', value: 'failed' },
    { columnId: 'attempts', operator: 'between', value: [1, 5] },
    { columnId: 'lastError', operator: 'isEmpty', value: null },
    { columnId: 'favorite', operator: 'is', value: true },
  ];

  it('round-trips a whole model, types included', () => {
    const written = writeDataTableUrlState(new URLSearchParams(), {
      filters: MODEL,
      search: 'geo',
    });
    const read = readDataTableUrlState(written, { columns: COLUMNS });

    expect(read.filters).toEqual(MODEL);
    expect(read.search).toBe('geo');
  });

  it('survives a trip through a real query STRING, not just the object', () => {
    const written = writeDataTableUrlState(new URLSearchParams(), { filters: MODEL });
    // toString() re-encodes our percent escapes; parsing undoes it symmetrically.
    const reparsed = new URLSearchParams(written.toString());

    expect(readDataTableUrlState(reparsed, { columns: COLUMNS }).filters).toEqual(MODEL);
  });

  it('survives values containing the delimiters', () => {
    const awkward: DataTableFilterModel = [
      { columnId: 'lastError', operator: 'contains', value: 'rate: limited, twice' },
      { columnId: 'type', operator: 'equals', value: 'a:b,c' },
    ];
    const written = writeDataTableUrlState(new URLSearchParams(), { filters: awkward });

    expect(readDataTableUrlState(new URLSearchParams(written.toString()), { columns: COLUMNS }).filters).toEqual(
      awkward,
    );
  });

  it('keeps unrelated params untouched and does not mutate the input', () => {
    const params = new URLSearchParams('page=3&tab=runs');
    const written = writeDataTableUrlState(params, { filters: MODEL, search: 'geo' });

    expect(written.get('page')).toBe('3');
    expect(written.get('tab')).toBe('runs');
    // The original is untouched — the caller decides push vs. replace.
    expect(params.getAll('filter')).toEqual([]);
    expect(written.getAll('filter')).toHaveLength(4);
  });

  it('removes its params entirely when the model and search are empty', () => {
    const params = new URLSearchParams('page=3');
    const seeded = writeDataTableUrlState(params, { filters: MODEL, search: 'geo' });
    const cleared = writeDataTableUrlState(seeded, { filters: [], search: '' });

    expect(cleared.toString()).toBe('page=3');
  });

  it('reads scalars as strings when no columns are supplied', () => {
    const written = writeDataTableUrlState(new URLSearchParams(), {
      filters: [{ columnId: 'attempts', operator: 'gt', value: 2 }],
    });
    // Documented limitation: a URL cannot say "this 2 is a number".
    expect(readDataTableUrlState(written).filters).toEqual([
      { columnId: 'attempts', operator: 'gt', value: '2' },
    ]);
  });

  it('drops a malformed filter param instead of throwing', () => {
    const params = new URLSearchParams('filter=nonsense&filter=status:is:failed&filter=');
    expect(readDataTableUrlState(params, { columns: COLUMNS }).filters).toEqual([
      { columnId: 'status', operator: 'is', value: 'failed' },
    ]);
  });

  it('honours custom param names', () => {
    const written = writeDataTableUrlState(
      new URLSearchParams(),
      { filters: [MODEL[0]], search: 'geo' },
      { filterParam: 'f', searchParam: 'search' },
    );
    expect(written.getAll('f')).toHaveLength(1);
    expect(written.get('search')).toBe('geo');
    expect(
      readDataTableUrlState(written, { filterParam: 'f', searchParam: 'search', columns: COLUMNS })
        .filters,
    ).toEqual([MODEL[0]]);
  });

  it('encodes one filter to the documented shape', () => {
    expect(encodeFilter({ columnId: 'status', operator: 'is', value: 'failed' })).toBe(
      'status:is:failed',
    );
    expect(encodeFilter({ columnId: 'attempts', operator: 'between', value: [1, 5] })).toBe(
      'attempts:between:1,5',
    );
    expect(encodeFilter({ columnId: 'lastError', operator: 'isEmpty', value: null })).toBe(
      'lastError:isEmpty',
    );
    expect(decodeFilter('lastError:isEmpty')).toEqual({
      columnId: 'lastError',
      operator: 'isEmpty',
      value: null,
    });
  });
});

// ---------------------------------------------------------------------------
// 10. Issue #243 guard, extended to the filter controls
// ---------------------------------------------------------------------------

// `assertNoInvisibleHitTargets` is imported from `./testUtils/a11yGuards`
// (issue #257 consolidated the four near-identical copies of this guard into
// one shared module — see that file's docblock).

describe('DataTable filter surface — no invisible-but-tappable controls (#243 guard)', () => {
  const FILTERS: DataTableFilterModel = [
    { columnId: 'status', operator: 'is', value: 'failed' },
    { columnId: 'attempts', operator: 'gt', value: 2 },
  ];

  it('holds for the desktop filter row', () => {
    renderAtWidth(1400, {
      filters: FILTERS,
      onFiltersChange: vi.fn(),
      quickSearch: { value: 'geo', onChange: vi.fn() },
    });
    assertNoInvisibleHitTargets(screen.getByTestId('datatable-filter-bar'));
  });

  it('holds for the tablet panel, opened', async () => {
    const user = userEvent.setup();
    renderAtWidth(800, {
      filters: FILTERS,
      onFiltersChange: vi.fn(),
      quickSearch: { value: 'geo', onChange: vi.fn() },
    });

    await user.click(screen.getByTestId('datatable-filter-toggle'));
    assertNoInvisibleHitTargets(screen.getByTestId('datatable-filter-bar'));
  });

  it('holds for the phone sheet, opened', async () => {
    const user = userEvent.setup();
    renderAtWidth(400, {
      filters: FILTERS,
      onFiltersChange: vi.fn(),
      quickSearch: { value: 'geo', onChange: vi.fn() },
    });

    await user.click(screen.getByTestId('datatable-filter-toggle'));
    const sheet = await screen.findByRole('dialog');
    assertNoInvisibleHitTargets(sheet);
  });

  it('gives every filter control a >=44px touch target', async () => {
    const user = userEvent.setup();
    renderAtWidth(400, {
      filters: FILTERS,
      onFiltersChange: vi.fn(),
      quickSearch: { value: 'geo', onChange: vi.fn() },
    });

    const mustBeTouchSized: HTMLElement[] = [
      screen.getByTestId('datatable-filter-toggle'),
      screen.getByRole('button', { name: 'Clear search' }),
      ...screen.getAllByTestId('datatable-filter-chip'),
    ];

    await user.click(screen.getByTestId('datatable-filter-toggle'));
    const sheet = await screen.findByRole('dialog');
    mustBeTouchSized.push(
      within(sheet).getByRole('button', { name: 'Close filters' }),
      within(sheet).getByTestId('datatable-filter-apply'),
      within(sheet).getByRole('combobox', { name: 'Column' }),
    );

    for (const control of mustBeTouchSized) {
      // A select's sizing lives on its InputBase wrapper, not the combobox div.
      const sized = control.closest<HTMLElement>('.MuiInputBase-root') ?? control;
      const style = getComputedStyle(sized);
      // `height: auto` parses to NaN, which would poison a bare Math.max.
      const px = (raw: string) => {
        const parsed = Number.parseFloat(raw);
        return Number.isFinite(parsed) ? parsed : 0;
      };
      const min = Math.max(px(style.minHeight), px(style.height));
      expect(min, describeControl(control)).toBeGreaterThanOrEqual(44);
    }
  });

  it('reveals every filter control without a hover', () => {
    renderAtWidth(400, {
      filters: FILTERS,
      onFiltersChange: vi.fn(),
      quickSearch: { value: 'geo', onChange: vi.fn() },
    });

    const bar = screen.getByTestId('datatable-filter-bar');
    const painted = Array.from(bar.querySelectorAll<HTMLElement>('button, .MuiChip-root'));
    expect(painted.length).toBeGreaterThan(0);
    for (const control of painted) {
      expect(getComputedStyle(control).opacity).not.toBe('0');
    }
  });
});
