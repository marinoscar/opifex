/**
 * Component tests — DataTable column visibility, density and layout
 * persistence (issue #255, epic #238).
 *
 * Five things this suite exists to pin down, in the order they can bite:
 *
 *  1. **Absent means default, never empty.** A stored entry with no
 *     `visibleColumns`, or no stored entry at all, opens the table in the
 *     priority-derived baseline — not in a table with zero columns.
 *  2. **A stored layout is reconciled against the CURRENT columns.** A column
 *     added after the layout was stored is VISIBLE, not silently hidden; a
 *     stored id for a column that no longer exists is ignored, not an error.
 *     These are the two halves of the same failure mode and the reason the
 *     encoding carries an explicit hidden marker at all.
 *  3. **In-session state is authoritative.** A failed (or slow) settings write
 *     never disturbs, reverts, or blocks what is on screen.
 *  4. **Density reaches BOTH renderers.** Grid row height and card padding.
 *  5. **The write is debounced and fire-and-forget**, and "reset to defaults"
 *     is the merge-patch DELETE rather than a stored empty object.
 *
 * ## Test doubles
 *
 * The layout stubs are the #253 recipe (container-driven width, `matchMedia`
 * pinned to a 1440px viewport) — see `ResponsiveDataTable.test.tsx` for why.
 * The network is stubbed by spying on the real `api` singleton rather than
 * mocking the module, so the component under test goes through exactly the
 * client every page uses.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from 'vitest';
import { useState } from 'react';
import {
  act,
  screen,
  within,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import { render } from '../../../__tests__/utils/test-utils';
import { DataTable } from '../DataTable';
import { api } from '../../../services/api';
import type { DataTableColumn, DataTableSortState } from '../types';
import {
  DATA_TABLE_PERSIST_DEBOUNCE_MS,
  decodeVisibility,
  encodeVisibility,
  isEmptyStoredLayout,
  pickerColumns,
  resolveStoredSort,
  resolveUserVisibleColumnIds,
  resolveVisibleColumnIds,
  sanitizeStoredLayout,
  type DataTableStoredLayout,
} from '../layout/layoutModel';
import { assertNoInvisibleHitTargets } from './testUtils/a11yGuards';

// ---------------------------------------------------------------------------
// Layout stubs (the #253 recipe)
// ---------------------------------------------------------------------------

const VIEWPORT_WIDTH = 1440;
const VIEWPORT_HEIGHT = 900;

let containerWidth = 1400;

interface FakeObserver {
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
  for (const prop of [
    'clientHeight',
    'offsetHeight',
    'scrollHeight',
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get: () => VIEWPORT_HEIGHT,
    });
  }

  HTMLElement.prototype.getBoundingClientRect =
    function getBoundingClientRect() {
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
        targets: new Set<Element>(),
        fire: () => {
          const entries = Array.from(this.entry.targets, (target) => ({
            target,
            contentRect: { width: containerWidth, height: VIEWPORT_HEIGHT },
          })) as unknown as ResizeObserverEntry[];
          if (entries.length > 0)
            callback(entries, this as unknown as ResizeObserver);
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

  global.ResizeObserver =
    ControllableResizeObserver as unknown as typeof ResizeObserver;

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

// ---------------------------------------------------------------------------
// Network doubles
// ---------------------------------------------------------------------------

let getSpy: ReturnType<typeof vi.spyOn>;
let patchSpy: ReturnType<typeof vi.spyOn>;

/** Seed what `GET /api/user-settings` returns for this test. */
function stubSettings(dataTables?: Record<string, unknown>) {
  getSpy.mockResolvedValue({
    theme: 'light',
    ...(dataTables ? { dataTables } : {}),
  });
}

/** Every `dataTables` payload sent to PATCH, in order. */
function patchedNamespaces(): Record<string, unknown>[] {
  return patchSpy.mock.calls.map(
    (call) => (call[1] as { dataTables: Record<string, unknown> }).dataTables,
  );
}

beforeEach(() => {
  containerWidth = 1400;
  getSpy = vi.spyOn(api, 'get').mockResolvedValue({ theme: 'light' });
  patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface Job {
  id: string;
  type: string;
  status: 'pending' | 'failed';
  attempts: number;
  lastError: string | null;
}

const JOBS: Job[] = [
  {
    id: 'job-1',
    type: 'face_detection',
    status: 'pending',
    attempts: 1,
    lastError: null,
  },
  {
    id: 'job-2',
    type: 'auto_tagging',
    status: 'failed',
    attempts: 3,
    lastError: 'rate limited',
  },
];

const COLUMNS: DataTableColumn<Job>[] = [
  {
    id: 'type',
    label: 'Type',
    priority: 'primary',
    sortable: true,
    value: (r) => r.type,
  },
  {
    id: 'status',
    label: 'Status',
    priority: 'primary',
    value: (r) => r.status,
  },
  {
    id: 'attempts',
    label: 'Attempts',
    priority: 'secondary',
    sortable: true,
    value: (r) => r.attempts,
  },
  {
    id: 'lastError',
    label: 'Last error',
    priority: 'detail',
    value: (r) => r.lastError,
  },
];

const rowId = (job: Job) => job.id;

type TableProps = React.ComponentProps<typeof DataTable<Job>>;

function renderTable(overrides: Partial<TableProps> = {}) {
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

/** Render at a container width and let hydration settle. */
async function renderHydrated(
  width: number,
  overrides: Partial<TableProps> = {},
) {
  containerWidth = width;
  const result = renderTable(overrides);
  // The stored entry arrives on a microtask; flush it before asserting.
  await act(async () => {});
  return result;
}

const wrapper = () => screen.getByTestId('datatable');
const gridRow = () => document.querySelector('.MuiDataGrid-row') as HTMLElement;
const gridRowMinHeight = () =>
  Number.parseFloat(getComputedStyle(gridRow()).minHeight || '0');
const cardHeaderPadding = () =>
  Number.parseFloat(
    getComputedStyle(screen.getAllByTestId('datatable-card-header')[0])
      .paddingLeft || '0',
  );

function openColumnsMenu() {
  fireEvent.click(screen.getByTestId('datatable-columns-button'));
  return screen.getByTestId('datatable-columns-menu');
}

/**
 * MUI's `Menu` is a modal: while it is open the rest of the app carries
 * `aria-hidden`, so a role query against the grid underneath finds nothing.
 * The picker deliberately does NOT close on each toggle (hiding three columns
 * is one trip, not three), so a test that wants to look at the table closes it
 * explicitly.
 */
function closeColumnsMenu() {
  fireEvent.keyDown(screen.getByTestId('datatable-columns-menu'), {
    key: 'Escape',
  });
}

function openViewSheet() {
  fireEvent.click(screen.getByTestId('datatable-view-button'));
  return screen.getByTestId('datatable-view-sheet');
}

// ---------------------------------------------------------------------------
// 1. The pure model
// ---------------------------------------------------------------------------

describe('layoutModel — visibility resolution', () => {
  it('treats an absent visibleColumns as "show everything the layout allows"', () => {
    expect(Array.from(resolveUserVisibleColumnIds(COLUMNS, {}))).toEqual([
      'type',
      'status',
      'attempts',
      'lastError',
    ]);
    expect(
      Array.from(resolveUserVisibleColumnIds(COLUMNS, undefined)),
    ).toHaveLength(4);
  });

  it('hides only the columns explicitly marked hidden', () => {
    const stored: DataTableStoredLayout = {
      visibleColumns: ['type', 'status', 'lastError', '-attempts'],
    };
    const visible = resolveUserVisibleColumnIds(COLUMNS, stored);
    expect(visible.has('attempts')).toBe(false);
    expect(visible.has('type')).toBe(true);
  });

  /**
   * The load-bearing case. A stored list written before `owner` existed knows
   * nothing about it — and "unknown" must resolve to the contract default, not
   * to hidden, or every column added to a table would silently disappear for
   * every user who had ever touched that table's layout.
   */
  it('shows a column added AFTER the layout was stored', () => {
    const stored: DataTableStoredLayout = {
      visibleColumns: ['type', 'status', 'lastError', '-attempts'],
    };
    const withNewColumn: DataTableColumn<Job>[] = [
      ...COLUMNS,
      { id: 'owner', label: 'Owner', priority: 'secondary', value: () => 'me' },
    ];

    const visible = resolveUserVisibleColumnIds(withNewColumn, stored);
    expect(visible.has('owner')).toBe(true);
    // ...without resurrecting the one the user actually hid.
    expect(visible.has('attempts')).toBe(false);
  });

  it('ignores a stored id for a column that no longer exists', () => {
    const stored: DataTableStoredLayout = {
      visibleColumns: [
        'type',
        'status',
        'attempts',
        'lastError',
        '-removedColumn',
      ],
    };
    const visible = resolveUserVisibleColumnIds(COLUMNS, stored);
    expect(visible.has('removedColumn')).toBe(false);
    expect(Array.from(visible)).toEqual([
      'type',
      'status',
      'attempts',
      'lastError',
    ]);
  });

  it('keeps a hideable:false column visible whatever the stored list says', () => {
    const pinned: DataTableColumn<Job>[] = [
      { ...COLUMNS[0], hideable: false },
      COLUMNS[1],
    ];
    const visible = resolveUserVisibleColumnIds(pinned, {
      visibleColumns: ['-type', 'status'],
    });
    expect(visible.has('type')).toBe(true);
  });

  it('round-trips a choice through encode/decode', () => {
    const chosen = new Set(['type', 'status', 'lastError']);
    const encoded = encodeVisibility(COLUMNS, chosen);

    expect(encoded).toEqual(['type', 'status', 'lastError', '-attempts']);
    // A naive consumer reading the field as "the visible ids" gets the right
    // answer too: `-attempts` matches no column id, so it is simply ignored.
    expect(encoded.filter((id) => COLUMNS.some((c) => c.id === id))).toEqual([
      'type',
      'status',
      'lastError',
    ]);

    const decoded = decodeVisibility(encoded);
    expect(Array.from(decoded.hidden)).toEqual(['attempts']);
    expect(
      resolveUserVisibleColumnIds(COLUMNS, { visibleColumns: encoded }),
    ).toEqual(chosen);
  });

  it('AND-s the user choice with the tablet detail fold, never overriding it', () => {
    const stored: DataTableStoredLayout = {
      visibleColumns: ['type', 'status', 'lastError', '-attempts'],
    };
    // Desktop: the fold does not apply, so the user's choice is the whole story.
    expect(
      Array.from(resolveVisibleColumnIds(COLUMNS, stored, 'desktop')),
    ).toEqual(['type', 'status', 'lastError']);
    // Tablet: `lastError` is `detail`, folded into the row expander regardless.
    expect(
      Array.from(resolveVisibleColumnIds(COLUMNS, stored, 'tablet')),
    ).toEqual(['type', 'status']);
  });

  it('offers the picker only columns it can actually change', () => {
    const pinned: DataTableColumn<Job>[] = [
      { ...COLUMNS[0], hideable: false },
      ...COLUMNS.slice(1),
    ];
    expect(pickerColumns(pinned, 'desktop').map((c) => c.id)).toEqual([
      'status',
      'attempts',
      'lastError',
    ]);
    // On a tablet the `detail` column is already folded into the expander, so a
    // checkbox for it would claim an effect it does not have.
    expect(pickerColumns(pinned, 'tablet').map((c) => c.id)).toEqual([
      'status',
      'attempts',
    ]);
  });
});

describe('layoutModel — stored entry hygiene', () => {
  it('resolves a stored sort only against a column that still sorts', () => {
    expect(
      resolveStoredSort(COLUMNS, {
        sort: { field: 'attempts', direction: 'desc' },
      }),
    ).toEqual({
      field: 'attempts',
      direction: 'desc',
    });
    // Column exists but is not sortable.
    expect(
      resolveStoredSort(COLUMNS, {
        sort: { field: 'status', direction: 'asc' },
      }),
    ).toBeNull();
    // Column is gone entirely.
    expect(
      resolveStoredSort(COLUMNS, { sort: { field: 'gone', direction: 'asc' } }),
    ).toBeNull();
  });

  it('drops keys the entry contract does not allow, so the next PATCH cannot 400', () => {
    const sanitized = sanitizeStoredLayout({
      visibleColumns: ['type', 42, ''],
      density: 'cozy',
      sort: { field: 'type', direction: 'sideways' },
      pageSize: 25.5,
      desnity: 'compact',
    });

    expect(sanitized).toEqual({ visibleColumns: ['type'] });
    expect('desnity' in sanitized).toBe(false);
  });

  it('recognises the empty entry that means "reset to defaults"', () => {
    expect(isEmptyStoredLayout({})).toBe(true);
    expect(isEmptyStoredLayout({ density: 'compact' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Hydration — absent keys resolve to contract defaults
// ---------------------------------------------------------------------------

describe('DataTable — defaults when nothing is stored', () => {
  it('draws every column and the standard density with no dataTables namespace', async () => {
    await renderHydrated(1400, { tableId: 'jobs' });

    expect(wrapper().getAttribute('data-density')).toBe('standard');
    for (const label of ['Type', 'Status', 'Attempts', 'Last error']) {
      expect(
        screen.getByRole('columnheader', { name: label }),
      ).toBeInTheDocument();
    }
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('draws every column for a stored entry that omits visibleColumns', async () => {
    // The exact §14.3 hazard: an entry exists (the user set a density once) but
    // says nothing about columns. That must NOT freeze the column set.
    stubSettings({ jobs: { density: 'compact' } });
    await renderHydrated(1400, { tableId: 'jobs' });

    expect(wrapper().getAttribute('data-density')).toBe('compact');
    expect(
      screen.getByRole('columnheader', { name: 'Last error' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: 'Attempts' }),
    ).toBeInTheDocument();
  });

  it('shows a newly-added column whose id predates nothing in the stored list', async () => {
    stubSettings({
      jobs: { visibleColumns: ['type', 'status', 'lastError', '-attempts'] },
    });

    const withNewColumn: DataTableColumn<Job>[] = [
      ...COLUMNS,
      { id: 'owner', label: 'Owner', priority: 'secondary', value: () => 'me' },
    ];
    await renderHydrated(1400, { tableId: 'jobs', columns: withNewColumn });

    expect(
      screen.getByRole('columnheader', { name: 'Owner' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('columnheader', { name: 'Attempts' }),
    ).not.toBeInTheDocument();
  });

  it('ignores a stored id for a column that no longer exists', async () => {
    stubSettings({
      jobs: {
        visibleColumns: ['type', 'status', 'attempts', 'lastError', '-gone'],
      },
    });
    await renderHydrated(1400, { tableId: 'jobs' });

    for (const label of ['Type', 'Status', 'Attempts', 'Last error']) {
      expect(
        screen.getByRole('columnheader', { name: label }),
      ).toBeInTheDocument();
    }
  });

  it('restores a stored sort through the page’s own onSortChange', async () => {
    stubSettings({ jobs: { sort: { field: 'attempts', direction: 'desc' } } });
    const onSortChange = vi.fn();
    await renderHydrated(1400, {
      tableId: 'jobs',
      sort: { sort: null, onSortChange },
    });

    expect(onSortChange).toHaveBeenCalledWith({
      field: 'attempts',
      direction: 'desc',
    });
  });

  it('does not restore a stored sort whose column is no longer sortable', async () => {
    stubSettings({ jobs: { sort: { field: 'status', direction: 'asc' } } });
    const onSortChange = vi.fn();
    await renderHydrated(1400, {
      tableId: 'jobs',
      sort: { sort: null, onSortChange },
    });

    expect(onSortChange).not.toHaveBeenCalled();
  });

  it('restores a stored page size, resetting to the first page', async () => {
    stubSettings({ jobs: { pageSize: 50 } });
    const onPaginationChange = vi.fn();
    await renderHydrated(1400, {
      tableId: 'jobs',
      pagination: { page: 3, pageSize: 25, total: 137, onPaginationChange },
    });

    expect(onPaginationChange).toHaveBeenCalledWith({ page: 0, pageSize: 50 });
  });
});

// ---------------------------------------------------------------------------
// 3. The controls, in both renderers
// ---------------------------------------------------------------------------

describe('DataTable — column picker', () => {
  it('hides a column from the GRID when unchecked in the desktop menu', async () => {
    await renderHydrated(1400, { tableId: 'jobs' });
    expect(
      screen.getByRole('columnheader', { name: 'Attempts' }),
    ).toBeInTheDocument();

    const menu = openColumnsMenu();
    fireEvent.click(
      within(menu).getByTestId('datatable-column-toggle-attempts'),
    );
    closeColumnsMenu();

    expect(
      screen.queryByRole('columnheader', { name: 'Attempts' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: 'Type' }),
    ).toBeInTheDocument();
    // The button's accessible name carries the count no icon can convey.
    expect(
      screen.getByRole('button', { name: 'Columns (1 hidden)' }),
    ).toBeInTheDocument();
  });

  it('hides a field from the CARD when unchecked in the phone sheet', async () => {
    await renderHydrated(400, { tableId: 'jobs' });
    expect(
      screen.getAllByTestId('datatable-card-field-attempts').length,
    ).toBeGreaterThan(0);

    const sheet = openViewSheet();
    fireEvent.click(
      within(sheet).getByRole('checkbox', { name: 'Show Attempts' }),
    );

    expect(
      screen.queryAllByTestId('datatable-card-field-attempts'),
    ).toHaveLength(0);
    expect(
      screen.getAllByTestId('datatable-card-headline-type').length,
    ).toBeGreaterThan(0);
  });

  it('does not offer a pinned (hideable: false) column', async () => {
    const pinned: DataTableColumn<Job>[] = [
      { ...COLUMNS[0], hideable: false },
      ...COLUMNS.slice(1),
    ];
    await renderHydrated(1400, { tableId: 'jobs', columns: pinned });

    const menu = openColumnsMenu();
    expect(
      within(menu).queryByTestId('datatable-column-toggle-type'),
    ).not.toBeInTheDocument();
    expect(
      within(menu).getByTestId('datatable-column-toggle-status'),
    ).toBeInTheDocument();
  });

  it('keeps a hidden detail column out of the tablet expander panel', async () => {
    await renderHydrated(1400, { tableId: 'jobs' });

    const menu = openColumnsMenu();
    fireEvent.click(
      within(menu).getByTestId('datatable-column-toggle-lastError'),
    );
    closeColumnsMenu();

    // Narrow to the tablet grid: `lastError` would normally be reachable via
    // the row expander, but hidden means hidden at every width.
    act(() => {
      containerWidth = 800;
      observers.forEach((observer) => observer.fire());
    });

    expect(screen.queryAllByTestId('datatable-row-expander')).toHaveLength(0);
  });
});

describe('DataTable — density', () => {
  it('changes grid row height', async () => {
    await renderHydrated(1400, { tableId: 'jobs' });
    const standard = gridRowMinHeight();

    fireEvent.click(screen.getByRole('button', { name: 'Compact density' }));
    const compact = gridRowMinHeight();

    fireEvent.click(
      screen.getByRole('button', { name: 'Comfortable density' }),
    );
    const comfortable = gridRowMinHeight();

    expect(compact).toBeLessThan(standard);
    expect(comfortable).toBeGreaterThan(standard);
    expect(wrapper().getAttribute('data-density')).toBe('comfortable');
  });

  it('changes card padding — the card renderer answers density too', async () => {
    await renderHydrated(400, { tableId: 'jobs' });
    const standard = cardHeaderPadding();
    expect(standard).toBeGreaterThan(0);

    const sheet = openViewSheet();
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Compact density' }),
    );
    const compact = cardHeaderPadding();

    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Comfortable density' }),
    );
    const comfortable = cardHeaderPadding();

    expect(compact).toBeLessThan(standard);
    expect(comfortable).toBeGreaterThan(standard);
    expect(
      screen.getAllByTestId('datatable-card')[0].getAttribute('data-density'),
    ).toBe('comfortable');
  });

  it('lets a user override the page’s density default', async () => {
    await renderHydrated(1400, { tableId: 'jobs', density: 'comfortable' });
    expect(wrapper().getAttribute('data-density')).toBe('comfortable');

    fireEvent.click(screen.getByRole('button', { name: 'Compact density' }));
    expect(wrapper().getAttribute('data-density')).toBe('compact');
  });
});

// ---------------------------------------------------------------------------
// 4. Write discipline
// ---------------------------------------------------------------------------

describe('DataTable — persistence write discipline', () => {
  it('sends ONE debounced PATCH for a burst of toggles, carrying the final state', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      containerWidth = 1400;
      renderTable({ tableId: 'jobs' });
      await act(async () => {});

      const menu = openColumnsMenu();
      fireEvent.click(
        within(menu).getByTestId('datatable-column-toggle-attempts'),
      );
      fireEvent.click(
        within(menu).getByTestId('datatable-column-toggle-lastError'),
      );
      fireEvent.click(
        within(menu).getByTestId('datatable-column-toggle-status'),
      );

      // Still nothing on the wire: the debounce is on the WRITE, and the three
      // clicks are one intent.
      act(() => {
        vi.advanceTimersByTime(DATA_TABLE_PERSIST_DEBOUNCE_MS - 1);
      });
      expect(patchSpy).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(1);
      });

      expect(patchSpy).toHaveBeenCalledTimes(1);
      expect(patchedNamespaces()[0]).toEqual({
        jobs: {
          visibleColumns: ['type', '-status', '-attempts', '-lastError'],
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends the WHOLE entry every time, because PATCH replaces an entry wholesale', async () => {
    stubSettings({ jobs: { density: 'compact', pageSize: 50 } });
    await renderHydrated(1400, { tableId: 'jobs' });

    const menu = openColumnsMenu();
    fireEvent.click(
      within(menu).getByTestId('datatable-column-toggle-attempts'),
    );

    await waitFor(() => expect(patchSpy).toHaveBeenCalled());
    // Density and pageSize ride along untouched: a delta would have silently
    // erased them (docs/specs/datatable.md §14.5).
    expect(patchedNamespaces().at(-1)).toEqual({
      jobs: {
        density: 'compact',
        pageSize: 50,
        visibleColumns: ['type', 'status', 'lastError', '-attempts'],
      },
    });
  });

  /**
   * A layout preference is UI state that happens to be backed up. Losing the
   * backup must cost the backup, never the state the user is looking at.
   */
  it('keeps in-session state when the settings write fails', async () => {
    patchSpy.mockRejectedValue(new Error('network down'));
    await renderHydrated(1400, { tableId: 'jobs' });

    const menu = openColumnsMenu();
    fireEvent.click(
      within(menu).getByTestId('datatable-column-toggle-attempts'),
    );
    closeColumnsMenu();
    fireEvent.click(screen.getByTestId('datatable-density-compact'));

    await waitFor(() => expect(patchSpy).toHaveBeenCalled());
    // Let every rejection settle, so a stray handler would have had its chance.
    await act(async () => {});

    expect(
      screen.queryByRole('columnheader', { name: 'Attempts' }),
    ).not.toBeInTheDocument();
    expect(wrapper().getAttribute('data-density')).toBe('compact');
    expect(
      screen.getByRole('columnheader', { name: 'Type' }),
    ).toBeInTheDocument();
  });

  it('renders defaults, and stays usable, when the settings READ fails', async () => {
    getSpy.mockRejectedValue(new Error('settings unavailable'));
    await renderHydrated(1400, { tableId: 'jobs' });

    expect(
      screen.getByRole('columnheader', { name: 'Attempts' }),
    ).toBeInTheDocument();

    const menu = openColumnsMenu();
    fireEvent.click(
      within(menu).getByTestId('datatable-column-toggle-attempts'),
    );
    closeColumnsMenu();
    expect(
      screen.queryByRole('columnheader', { name: 'Attempts' }),
    ).not.toBeInTheDocument();
  });

  /**
   * In-session state is authoritative and the server copy is a cache — so a GET
   * that lands after the user has already clicked must not overwrite the click.
   */
  it('does not let a late GET clobber a choice already made', async () => {
    let resolveGet: (value: unknown) => void = () => {};
    getSpy.mockReturnValue(
      new Promise((resolve) => {
        resolveGet = resolve;
      }),
    );

    containerWidth = 1400;
    renderTable({ tableId: 'jobs' });

    // The user acts while the read is still in flight.
    fireEvent.click(screen.getByRole('button', { name: 'Compact density' }));
    expect(wrapper().getAttribute('data-density')).toBe('compact');

    await act(async () => {
      resolveGet({
        theme: 'light',
        dataTables: { jobs: { density: 'comfortable' } },
      });
    });

    expect(wrapper().getAttribute('data-density')).toBe('compact');
  });

  it('expresses "reset to defaults" as the merge-patch DELETE', async () => {
    stubSettings({
      jobs: { density: 'compact', visibleColumns: ['type', '-attempts'] },
    });
    await renderHydrated(1400, { tableId: 'jobs' });

    expect(
      screen.queryByRole('columnheader', { name: 'Attempts' }),
    ).not.toBeInTheDocument();

    const menu = openColumnsMenu();
    fireEvent.click(within(menu).getByTestId('datatable-layout-reset'));
    await act(async () => {});

    // Immediate, not debounced — a single deliberate gesture has nothing to
    // coalesce — and `null`, not `{}`: the entry stops existing.
    await waitFor(() => expect(patchSpy).toHaveBeenCalled());
    expect(patchedNamespaces().at(-1)).toEqual({ jobs: null });

    expect(
      screen.getByRole('columnheader', { name: 'Attempts' }),
    ).toBeInTheDocument();
    expect(wrapper().getAttribute('data-density')).toBe('standard');
  });

  it('offers "Reset to defaults" even when nothing has been customized', async () => {
    await renderHydrated(1400, { tableId: 'jobs' });
    const menu = openColumnsMenu();
    expect(
      within(menu).getByTestId('datatable-layout-reset'),
    ).toBeInTheDocument();
  });

  it('does not persist anything on mount just for having a pagination config', async () => {
    await renderHydrated(1400, {
      tableId: 'jobs',
      pagination: {
        page: 0,
        pageSize: 25,
        total: 2,
        onPaginationChange: vi.fn(),
      },
      sort: {
        sort: { field: 'type', direction: 'asc' },
        onSortChange: vi.fn(),
      },
    });

    // The page's own defaults are the BASELINE, not a preference: writing them
    // back would store "25 per page" as a user choice nobody made, and would
    // fire a PATCH on every mount of every paginated table.
    await waitFor(() => expect(getSpy).toHaveBeenCalled());
    await new Promise((resolve) =>
      setTimeout(resolve, DATA_TABLE_PERSIST_DEBOUNCE_MS + 50),
    );
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('persists a sort the user changes away from the page’s baseline', async () => {
    function Harness() {
      const [sort, setSort] = useState<DataTableSortState | null>(null);
      return (
        <DataTable<Job>
          columns={COLUMNS}
          rows={JOBS}
          rowId={rowId}
          ariaLabel="Enrichment jobs"
          tableId="jobs"
          sort={{ sort, onSortChange: setSort }}
          pagination={{
            page: 0,
            pageSize: 25,
            total: 2,
            onPaginationChange: vi.fn(),
          }}
        />
      );
    }

    containerWidth = 1400;
    render(<Harness />);
    await act(async () => {});

    fireEvent.click(screen.getByRole('columnheader', { name: 'Type' }));

    await waitFor(() => expect(patchSpy).toHaveBeenCalled());
    // Only the field that actually diverged from the baseline is stored — the
    // untouched page size stays absent, and absent means "contract default".
    expect(patchedNamespaces().at(-1)).toEqual({
      jobs: { sort: { field: 'type', direction: 'asc' } },
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Persistence is inert without a tableId
// ---------------------------------------------------------------------------

describe('DataTable — no tableId', () => {
  it('touches the network for neither reads nor writes, but still works', async () => {
    await renderHydrated(1400);

    expect(getSpy).not.toHaveBeenCalled();

    const menu = openColumnsMenu();
    fireEvent.click(
      within(menu).getByTestId('datatable-column-toggle-attempts'),
    );
    closeColumnsMenu();
    fireEvent.click(screen.getByTestId('datatable-density-compact'));

    // The controls are a UI feature; only the BACKUP is opt-in.
    expect(
      screen.queryByRole('columnheader', { name: 'Attempts' }),
    ).not.toBeInTheDocument();
    expect(wrapper().getAttribute('data-density')).toBe('compact');

    await act(async () => {});
    expect(patchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. Touch-target rule / issue #243 guard, extended to the new controls
// ---------------------------------------------------------------------------

// `assertNoInvisibleHitTargets` is imported from `./testUtils/a11yGuards`
// (issue #257 consolidated the four near-identical copies of this guard into
// one shared module — see that file's docblock).

describe('DataTable — layout controls obey the touch rules (issue #243 guard)', () => {
  it('holds for the desktop column menu, opened', async () => {
    await renderHydrated(1400, { tableId: 'jobs' });
    const menu = openColumnsMenu();
    // The menu lives in a portal, so the sweep roots at the menu itself.
    assertNoInvisibleHitTargets(menu);
    assertNoInvisibleHitTargets(screen.getByTestId('datatable-view-bar'));
  });

  it('holds for the phone view sheet, opened', async () => {
    await renderHydrated(400, { tableId: 'jobs' });
    assertNoInvisibleHitTargets(openViewSheet());
  });

  it('gives every layout control a >=44px touch target', async () => {
    await renderHydrated(400, { tableId: 'jobs' });
    const sheet = openViewSheet();

    const mustBeTouchSized: HTMLElement[] = [
      screen.getByTestId('datatable-view-button'),
      within(sheet).getByRole('button', { name: 'Close view options' }),
      within(sheet).getByRole('button', { name: 'Compact density' }),
      within(sheet).getByTestId('datatable-layout-reset'),
      within(sheet).getByRole('checkbox', { name: 'Show Attempts' }),
    ];

    for (const control of mustBeTouchSized) {
      const sized =
        control.closest<HTMLElement>('[class*="MuiCheckbox-root"]') ?? control;
      const style = getComputedStyle(sized);
      expect(Number.parseFloat(style.minHeight || '0')).toBeGreaterThanOrEqual(
        44,
      );
    }
  });

  it('gives the desktop density toggle and columns button a >=44px target', async () => {
    await renderHydrated(1400, { tableId: 'jobs' });

    for (const control of [
      screen.getByTestId('datatable-columns-button'),
      screen.getByTestId('datatable-density-standard'),
    ]) {
      expect(
        Number.parseFloat(getComputedStyle(control).minHeight || '0'),
      ).toBeGreaterThanOrEqual(44);
    }
  });

  it('keeps the view bar inside the table’s horizontal containment', async () => {
    await renderHydrated(360, { tableId: 'jobs' });
    const bar = screen.getByTestId('datatable-view-bar');
    const style = getComputedStyle(bar);

    expect(style.maxWidth).toBe('100%');
    expect(style.minWidth).toBe('0px');
    expect(style.flexWrap).toBe('wrap');
    expect(document.body.style.width).toBe('');
  });
});
