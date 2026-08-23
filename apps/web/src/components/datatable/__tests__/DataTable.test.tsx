/**
 * Component tests — DataTable foundation (issue #252).
 *
 * Covers the three things this issue is actually promising:
 *
 *  1. The shell renders on desktop against a server-driven contract —
 *     pagination, sorting, selection + bulk bar — and shows the four states
 *     (data / loading / empty / error).
 *  2. `columnAdapter` faithfully round-trips a column's `render`, `value`,
 *     `align` and `truncate` into a `GridColDef` (unit-tested directly, with no
 *     grid in the way).
 *  3. Wide content is contained: the scroll owner is the table's own wrapper,
 *     never the document body.
 *
 * jsdom performs no layout, so MUI X's virtualizer would otherwise measure a
 * 0×0 viewport and render zero rows. `installLayoutStubs()` below gives every
 * element a fixed 800×600 box and a ResizeObserver that actually fires — the
 * standard recipe for exercising DataGrid under jsdom.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { screen, within, fireEvent } from '@testing-library/react';
import { render } from '../../../__tests__/utils/test-utils';
import { DataTable, shouldRenderViewBar } from '../DataTable';
import { toGridColDef, extractColumnValue, buildColumnVisibilityModel } from '../desktop/columnAdapter';
import type { DataTableColumn } from '../types';

// ---------------------------------------------------------------------------
// jsdom layout stubs
// ---------------------------------------------------------------------------

const VIEWPORT_WIDTH = 800;
const VIEWPORT_HEIGHT = 600;

function installLayoutStubs() {
  for (const [prop, value] of [
    ['clientWidth', VIEWPORT_WIDTH],
    ['clientHeight', VIEWPORT_HEIGHT],
    ['offsetWidth', VIEWPORT_WIDTH],
    ['offsetHeight', VIEWPORT_HEIGHT],
    ['scrollWidth', VIEWPORT_WIDTH],
    ['scrollHeight', VIEWPORT_HEIGHT],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get() {
        return value;
      },
    });
  }

  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return {
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT,
      top: 0,
      left: 0,
      right: VIEWPORT_WIDTH,
      bottom: VIEWPORT_HEIGHT,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };

  class FiringResizeObserver {
    private readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element) {
      this.callback(
        [
          {
            target,
            contentRect: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
          } as unknown as ResizeObserverEntry,
        ],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver = FiringResizeObserver as unknown as typeof ResizeObserver;
}

beforeAll(() => {
  installLayoutStubs();
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface Job {
  id: string;
  type: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  attempts: number;
  lastError: string | null;
}

const JOBS: Job[] = [
  { id: 'job-1', type: 'face_detection', status: 'succeeded', attempts: 1, lastError: null },
  { id: 'job-2', type: 'auto_tagging', status: 'failed', attempts: 3, lastError: 'rate limited by provider after three consecutive attempts' },
  { id: 'job-3', type: 'geocode', status: 'pending', attempts: 0, lastError: null },
];

const COLUMNS: DataTableColumn<Job>[] = [
  { id: 'type', label: 'Type', priority: 'primary', sortable: true, value: (r) => r.type },
  {
    id: 'status',
    label: 'Status',
    priority: 'primary',
    value: (r) => r.status,
    render: (r) => <span data-testid={`status-chip-${r.id}`}>{r.status.toUpperCase()}</span>,
  },
  { id: 'attempts', label: 'Attempts', priority: 'secondary', align: 'right', sortable: true, value: (r) => r.attempts },
  { id: 'lastError', label: 'Last error', priority: 'detail', truncate: true, value: (r) => r.lastError },
];

const rowId = (job: Job) => job.id;

/** Minimum props for the table under test, overridable per case. */
function renderTable(overrides: Partial<React.ComponentProps<typeof DataTable<Job>>> = {}) {
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

// ---------------------------------------------------------------------------
// Rendering + the four states
// ---------------------------------------------------------------------------

describe('DataTable — desktop rendering', () => {
  it('resolves to the desktop renderer and renders headers and rows', () => {
    renderTable();

    expect(screen.getByTestId('datatable')).toHaveAttribute('data-renderer', 'desktop');

    expect(screen.getByRole('columnheader', { name: /type/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /status/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /attempts/i })).toBeInTheDocument();

    expect(screen.getByText('face_detection')).toBeInTheDocument();
    expect(screen.getByText('auto_tagging')).toBeInTheDocument();
    expect(screen.getByText('geocode')).toBeInTheDocument();
  });

  it('uses the column render function for rich cells', () => {
    renderTable();
    expect(screen.getByTestId('status-chip-job-1')).toHaveTextContent('SUCCEEDED');
    expect(screen.getByTestId('status-chip-job-2')).toHaveTextContent('FAILED');
  });

  it('shows the loading overlay in the loading state', () => {
    renderTable({ loading: true, rows: [] });
    expect(screen.getByTestId('datatable-loading-overlay')).toBeInTheDocument();
  });

  it('shows the caller-supplied empty state when there are no rows', () => {
    renderTable({ rows: [], emptyState: <span>No jobs match these filters</span> });
    const overlay = screen.getByTestId('datatable-empty-overlay');
    expect(within(overlay).getByText('No jobs match these filters')).toBeInTheDocument();
  });

  it('falls back to a default empty message when no emptyState is given', () => {
    renderTable({ rows: [] });
    expect(within(screen.getByTestId('datatable-empty-overlay')).getByText('No results')).toBeInTheDocument();
  });

  it('renders the error state as an alert above the table', () => {
    renderTable({ error: 'Failed to load jobs' });
    const alert = screen.getByTestId('datatable-error');
    expect(alert).toHaveTextContent('Failed to load jobs');
    // The table is still rendered beneath the error, so a stale page stays readable.
    expect(screen.getByText('face_detection')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The view bar is chrome ABOUT rows (issue #438)
// ---------------------------------------------------------------------------

describe('shouldRenderViewBar', () => {
  const empty = { rowCount: 0, hasActiveQuery: false } as const;

  it('draws the bar whenever there are rows', () => {
    expect(shouldRenderViewBar({ rowCount: 3, hasActiveQuery: false })).toBe(true);
  });

  it('hides the bar for a table that resolved to zero rows with nothing applied', () => {
    expect(shouldRenderViewBar(empty)).toBe(false);
  });

  it('keeps the bar while loading, so a refetch never flashes it out', () => {
    // The node/job pages poll every 5s and render unconditionally to avoid
    // remount churn (§18.4); a page that clears `rows` mid-fetch must not make
    // the chrome row appear and disappear twelve times a minute.
    expect(shouldRenderViewBar({ ...empty, loading: true })).toBe(true);
  });

  it('keeps the bar when a filter or quick search produced the empty result', () => {
    // Zero rows is a RESULT here, not an empty table — the controls must hold
    // still while the user narrows a query.
    expect(shouldRenderViewBar({ ...empty, hasActiveQuery: true })).toBe(true);
  });

  it('keeps the bar when the server reports rows this page is not showing', () => {
    // A page index past the end: the table HAS rows, so "export all matching
    // rows" is still meaningful.
    expect(shouldRenderViewBar({ ...empty, total: 137 })).toBe(true);
    expect(shouldRenderViewBar({ ...empty, total: 0 })).toBe(false);
  });
});

describe('DataTable — empty table chrome (issue #438)', () => {
  it('leaves the empty state alone, with no column picker or dead export button', () => {
    renderTable({ rows: [], emptyState: <span>No node credentials yet</span> });

    expect(screen.queryByTestId('datatable-view-bar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('datatable-columns-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('datatable-export-button')).not.toBeInTheDocument();

    // The renderers below the bars own the empty state and are untouched.
    expect(
      within(screen.getByTestId('datatable-empty-overlay')).getByText('No node credentials yet'),
    ).toBeInTheDocument();
  });

  it('keeps the bar on an empty page while a filter is applied', () => {
    renderTable({
      rows: [],
      filters: [{ columnId: 'status', operator: 'is', value: 'failed' }],
      onFiltersChange: vi.fn(),
    });

    expect(screen.getByTestId('datatable-view-bar')).toBeInTheDocument();
    expect(screen.getByTestId('datatable-columns-button')).toBeInTheDocument();
  });

  it('keeps the bar while an empty table is still loading', () => {
    renderTable({ rows: [], loading: true });
    expect(screen.getByTestId('datatable-view-bar')).toBeInTheDocument();
  });

  it('keeps the bar when there are rows', () => {
    renderTable();
    expect(screen.getByTestId('datatable-view-bar')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Server-side pagination
// ---------------------------------------------------------------------------

describe('DataTable — server pagination', () => {
  it('reports the server total and pushes page changes back out', () => {
    const onPaginationChange = vi.fn();
    renderTable({
      pagination: { page: 0, pageSize: 25, total: 137, onPaginationChange },
    });

    // rowCount comes from the server total, not from rows.length.
    expect(screen.getByText(/of 137/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /go to next page/i }));
    expect(onPaginationChange).toHaveBeenCalledWith({ page: 1, pageSize: 25 });
  });

  it('hides the footer entirely when no pagination config is supplied', () => {
    renderTable();
    expect(screen.queryByRole('button', { name: /go to next page/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Server-side sorting
// ---------------------------------------------------------------------------

describe('DataTable — server sorting', () => {
  it('emits a sort state when a sortable header is activated', () => {
    const onSortChange = vi.fn();
    renderTable({ sort: { sort: null, onSortChange } });

    fireEvent.click(screen.getByRole('columnheader', { name: /^type$/i }));
    expect(onSortChange).toHaveBeenCalledWith({ field: 'type', direction: 'asc' });
  });

  it('reflects the controlled sort state on the header', () => {
    renderTable({ sort: { sort: { field: 'attempts', direction: 'desc' }, onSortChange: vi.fn() } });
    expect(screen.getByRole('columnheader', { name: /attempts/i })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });

  it('does not make a non-sortable column interactive', () => {
    const onSortChange = vi.fn();
    renderTable({ sort: { sort: null, onSortChange } });

    // `status` declares no `sortable`, so it must stay inert.
    fireEvent.click(screen.getByRole('columnheader', { name: /^status$/i }));
    expect(onSortChange).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Selection + bulk actions
// ---------------------------------------------------------------------------

describe('DataTable — selection and bulk actions', () => {
  it('emits the selected id set when a row checkbox is toggled', () => {
    const onSelectionChange = vi.fn();
    renderTable({ selection: { selectedIds: new Set<string>(), onSelectionChange } });

    // Row checkboxes are named after their row (issue #257) — job-1's `type`
    // is `face_detection` — never a bare "Select row".
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select face_detection' }));

    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    expect(Array.from(onSelectionChange.mock.calls[0][0] as Set<string>)).toEqual(['job-1']);
  });

  it('maps the select-all header checkbox to every loaded row id', () => {
    const onSelectionChange = vi.fn();
    renderTable({ selection: { selectedIds: new Set<string>(), onSelectionChange } });

    fireEvent.click(screen.getByRole('checkbox', { name: /select all rows/i }));

    const emitted = onSelectionChange.mock.calls[0][0] as Set<string>;
    // MUI X v9 reports select-all as an `exclude` model; we materialise it
    // against the current (server-paginated) page.
    expect(Array.from(emitted).sort()).toEqual(['job-1', 'job-2', 'job-3']);
  });

  it('shows the bulk bar with the selection count and runs a bulk action', () => {
    const onSelectionChange = vi.fn();
    const archive = vi.fn();
    renderTable({
      selection: { selectedIds: new Set(['job-1', 'job-2']), onSelectionChange },
      bulkActions: [{ id: 'archive', label: 'Archive', onClick: archive }],
    });

    const bar = screen.getByTestId('datatable-bulk-action-bar');
    // "N of M selected" (issue #257): 2 of the 3 loaded rows.
    expect(within(bar).getByText('2 of 3 selected')).toBeInTheDocument();
    expect(bar).toHaveAttribute('role', 'toolbar');

    fireEvent.click(within(bar).getByRole('button', { name: 'Archive' }));
    expect(archive).toHaveBeenCalledWith(['job-1', 'job-2']);
  });

  it('clears the selection from the bulk bar', () => {
    const onSelectionChange = vi.fn();
    renderTable({ selection: { selectedIds: new Set(['job-1']), onSelectionChange } });

    fireEvent.click(screen.getByRole('button', { name: /clear selection/i }));
    expect((onSelectionChange.mock.calls[0][0] as Set<string>).size).toBe(0);
  });

  it('renders no bulk bar and no checkboxes without a selection config', () => {
    renderTable();
    expect(screen.queryByTestId('datatable-bulk-action-bar')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /select all rows/i })).not.toBeInTheDocument();
  });

  it('honours selectable: false', () => {
    renderTable({
      selection: { selectable: false, selectedIds: new Set(['job-1']), onSelectionChange: vi.fn() },
    });
    expect(screen.queryByTestId('datatable-bulk-action-bar')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Row actions
// ---------------------------------------------------------------------------

describe('DataTable — row actions', () => {
  it('renders a single action as a labelled icon button', () => {
    const retry = vi.fn();
    renderTable({ rowActions: [{ id: 'retry', label: 'Retry', onClick: retry }] });

    // Disambiguated per row (issue #257): "Retry for face_detection", never a
    // bare "Retry" repeated identically on every row.
    const buttons = screen.getAllByRole('button', { name: /^retry for /i });
    fireEvent.click(buttons[0]);
    expect(retry).toHaveBeenCalledWith(JOBS[0]);
  });

  it('disables an action per row', () => {
    renderTable({
      rowActions: [
        { id: 'retry', label: 'Retry', onClick: vi.fn(), disabled: (row) => row.status === 'pending' },
      ],
    });
    const buttons = screen.getAllByRole('button', { name: /^retry for /i });
    expect(buttons[0]).toBeEnabled();
    expect(buttons[2]).toBeDisabled();
  });

  it('collapses two or more actions into an overflow menu', () => {
    const retry = vi.fn();
    renderTable({
      rowActions: [
        { id: 'retry', label: 'Retry', onClick: retry },
        { id: 'delete', label: 'Delete', onClick: vi.fn(), destructive: true },
      ],
    });

    fireEvent.click(screen.getAllByRole('button', { name: /row actions/i })[0]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledWith(JOBS[0]);
  });

  it('gates a confirming action behind a dialog', () => {
    const destroy = vi.fn();
    renderTable({
      rowActions: [
        {
          id: 'delete',
          label: 'Delete',
          destructive: true,
          confirm: { title: 'Delete job?', description: 'This removes the job row permanently.' },
          onClick: destroy,
        },
      ],
    });

    // Single-action buttons are disambiguated per row (issue #257): job-1's
    // `type` is `face_detection`, so the button reads "Delete for
    // face_detection", never a bare "Delete" repeated on every row.
    fireEvent.click(screen.getAllByRole('button', { name: /^delete for /i })[0]);
    expect(destroy).not.toHaveBeenCalled();

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Delete job?')).toBeInTheDocument();
    expect(within(dialog).getByText('This removes the job row permanently.')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(destroy).toHaveBeenCalledWith(JOBS[0]);
  });

  it('does not run the action when the confirm dialog is cancelled', () => {
    const destroy = vi.fn();
    renderTable({
      rowActions: [{ id: 'delete', label: 'Delete', destructive: true, confirm: true, onClick: destroy }],
    });

    fireEvent.click(screen.getAllByRole('button', { name: /^delete for /i })[0]);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(destroy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Column adapter (unit)
// ---------------------------------------------------------------------------

describe('columnAdapter', () => {
  const job = JOBS[1];

  it('round-trips id, label, align and sortable', () => {
    const def = toGridColDef(COLUMNS[2]); // attempts, align right, sortable
    expect(def.field).toBe('attempts');
    expect(def.headerName).toBe('Attempts');
    expect(def.align).toBe('right');
    expect(def.headerAlign).toBe('right');
    expect(def.sortable).toBe(true);
  });

  it('defaults sortable to false and disables grid-side filtering', () => {
    const def = toGridColDef(COLUMNS[1]); // status: declares no `sortable`
    expect(def.sortable).toBe(false);
    // Client-side filtering is owned by #254, never by the grid.
    expect(def.filterable).toBe(false);
  });

  it('wires `value` into valueGetter', () => {
    const def = toGridColDef(COLUMNS[0]);
    expect(def.valueGetter).toBeDefined();
     
    const got = (def.valueGetter as any)(undefined, job, def, undefined);
    expect(got).toBe('auto_tagging');
  });

  it('falls back to row[id] when no `value` extractor is declared', () => {
    const column: DataTableColumn<Job> = { id: 'attempts', label: 'Attempts', priority: 'secondary' };
    expect(extractColumnValue(column, job)).toBe(3);
    expect(extractColumnValue({ id: 'nope', label: 'Nope', priority: 'detail' }, job)).toBeNull();
  });

  it('wires `render` into renderCell', () => {
    const def = toGridColDef(COLUMNS[1]);
    expect(def.renderCell).toBeDefined();
     
    const node = (def.renderCell as any)({ row: job, value: 'failed' });
    render(<>{node}</>);
    expect(screen.getByTestId('status-chip-job-2')).toHaveTextContent('FAILED');
  });

  it('wraps a truncate column in an ellipsis cell carrying the full value', () => {
    const def = toGridColDef(COLUMNS[3]); // lastError, truncate: true
     
    const node = (def.renderCell as any)({ row: job, value: job.lastError });
    render(<>{node}</>);

    const cell = screen.getByTestId('datatable-truncated-cell');
    expect(cell).toHaveTextContent(job.lastError as string);
    expect(getComputedStyle(cell).textOverflow).toBe('ellipsis');
    expect(getComputedStyle(cell).whiteSpace).toBe('nowrap');
    expect(getComputedStyle(cell).overflow).toBe('hidden');
  });

  it('renders an em dash for a null scalar in a truncate column', () => {
    const def = toGridColDef(COLUMNS[3]);
     
    const node = (def.renderCell as any)({ row: JOBS[0], value: null });
    render(<>{node}</>);
    expect(screen.getByTestId('datatable-truncated-cell')).toHaveTextContent('—');
  });

  it('flexes by default and honours an explicit width', () => {
    const flexed = toGridColDef(COLUMNS[0]);
    expect(flexed.flex).toBe(1);
    expect(flexed.minWidth).toBeGreaterThan(0);

    const fixed = toGridColDef<Job>({ id: 'type', label: 'Type', priority: 'primary', width: 160 });
    expect(fixed.width).toBe(160);
    expect(fixed.flex).toBeUndefined();
  });

  it('hides only `detail` columns when the viewport is narrow', () => {
    expect(buildColumnVisibilityModel(COLUMNS, { hideDetailColumns: true })).toEqual({
      type: true,
      status: true,
      attempts: true,
      lastError: false,
    });
    expect(buildColumnVisibilityModel(COLUMNS, { hideDetailColumns: false })).toEqual({
      type: true,
      status: true,
      attempts: true,
      lastError: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Horizontal containment (non-negotiable)
// ---------------------------------------------------------------------------

describe('DataTable — horizontal containment', () => {
  /** Intentionally far wider than the 800px viewport. */
  const WIDE_COLUMNS: DataTableColumn<Job>[] = Array.from({ length: 14 }, (_, index) => ({
    id: `col${index}`,
    label: `A very long column heading number ${index}`,
    priority: 'secondary' as const,
    width: 320,
    value: () => `a rather long cell value for column ${index}`,
  }));

  beforeEach(() => {
    document.body.style.margin = '0';
  });

  it('keeps the scroll owner inside the table, never on the document body', () => {
    render(
      <DataTable<Job>
        columns={WIDE_COLUMNS}
        rows={JOBS}
        rowId={rowId}
        ariaLabel="Wide table"
        pagination={{ page: 0, pageSize: 25, total: 3, onPaginationChange: vi.fn() }}
      />,
    );

    const wrapper = screen.getByTestId('datatable');
    const scroller = screen.getByTestId('datatable-scroll-container');

    // The outer shell may never exceed its parent.
    expect(getComputedStyle(wrapper).maxWidth).toBe('100%');
    expect(getComputedStyle(wrapper).minWidth).toBe('0px');

    // ...and the element that actually scrolls sideways is this one.
    expect(getComputedStyle(scroller).overflowX).toBe('auto');
    expect(getComputedStyle(scroller).maxWidth).toBe('100%');
    expect(getComputedStyle(scroller).minWidth).toBe('0px');

    // Nothing in the tree opts the body into horizontal scrolling.
    expect(getComputedStyle(document.body).overflowX).not.toBe('scroll');
    expect(document.body.style.width).toBe('');
  });
});
