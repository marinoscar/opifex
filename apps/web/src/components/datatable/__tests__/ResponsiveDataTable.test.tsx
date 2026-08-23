/**
 * Component tests — responsive DataTable (issue #253).
 *
 * Covers what this issue promises beyond the #252 foundation:
 *
 *  1. Three layouts, resolved from the table's **container** width — including
 *     the case the whole design exists for: a narrow container inside a wide
 *     viewport (the 400px Workflow runs drawer on a 1440px desktop, issue #261)
 *     renders cards.
 *  2. Selection / page / sort survive a layout switch, because they live above
 *     the renderers.
 *  3. The card layout: priority-driven headline/body/detail, detail closed by
 *     default, tap-to-expand truncation, overflow-menu row actions with the
 *     shared confirm dialog, and the same BulkActionBar as the grid.
 *  4. The tablet layout: the real grid with `detail` columns hidden but
 *     reachable through row expansion.
 *  5. A regression guard for the issue #243 class of bug — no control that is
 *     invisible (`opacity: 0`) while still being hit-testable.
 *
 * ## Test doubles
 *
 * jsdom performs no layout, so both the container-width hook and MUI X's
 * virtualizer would measure 0×0. `installLayoutStubs()` gives every element a
 * width driven by a module-level `containerWidth`, and a ResizeObserver that
 * actually fires — and, unlike the #252 recipe, can be re-fired on demand so a
 * resize is observable mid-test.
 *
 * `window.matchMedia` is implemented against a FIXED 1440px viewport. That is
 * what makes the container-vs-viewport assertions meaningful: every viewport
 * media query in the tree answers "desktop", so any `mobile` result can only
 * have come from the container measurement.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { useState } from 'react';
import { act, screen, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../../__tests__/utils/test-utils';
import { DataTable } from '../DataTable';
import { CardField } from '../mobile/CardField';
import { layoutForWidth, DEFAULT_BREAKPOINTS } from '../useContainerLayout';
import type { DataTableColumn, DataTableSortState } from '../types';
import { assertNoInvisibleHitTargets } from './testUtils/a11yGuards';

// ---------------------------------------------------------------------------
// Layout stubs
// ---------------------------------------------------------------------------

/** The (fixed) viewport every media query in these tests sees. */
const VIEWPORT_WIDTH = 1440;
const VIEWPORT_HEIGHT = 900;

/** The container width under test. Mutated by `setContainerWidth`. */
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

  global.ResizeObserver =
    ControllableResizeObserver as unknown as typeof ResizeObserver;

  // A fixed 1440px viewport, so a viewport media query never says "mobile".
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

/** Resize the container and let every live observer report the new width. */
function setContainerWidth(width: number) {
  containerWidth = width;
  act(() => {
    observers.forEach((observer) => observer.fire());
  });
}

beforeAll(() => {
  installLayoutStubs();
});

beforeEach(() => {
  containerWidth = 1400;
});

// ---------------------------------------------------------------------------
// Fixture — deliberately the same shape as the #252 suite's
// ---------------------------------------------------------------------------

interface Job {
  id: string;
  type: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  attempts: number;
  lastError: string | null;
}

const JOBS: Job[] = [
  {
    id: 'job-1',
    type: 'face_detection',
    status: 'succeeded',
    attempts: 1,
    lastError: null,
  },
  {
    id: 'job-2',
    type: 'auto_tagging',
    status: 'failed',
    attempts: 3,
    lastError: 'rate limited by provider after three consecutive attempts',
  },
  {
    id: 'job-3',
    type: 'geocode',
    status: 'pending',
    attempts: 0,
    lastError: null,
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
    render: (r) => (
      <span data-testid={`status-chip-${r.id}`}>{r.status.toUpperCase()}</span>
    ),
  },
  {
    id: 'attempts',
    label: 'Attempts',
    priority: 'secondary',
    align: 'right',
    sortable: true,
    value: (r) => r.attempts,
  },
  {
    id: 'lastError',
    label: 'Last error',
    priority: 'detail',
    truncate: true,
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

/** Renders at a given container width without going through a resize. */
function renderAtWidth(width: number, overrides: Partial<TableProps> = {}) {
  containerWidth = width;
  return renderTable(overrides);
}

const wrapper = () => screen.getByTestId('datatable');
const layout = () => wrapper().getAttribute('data-layout');
const renderer = () => wrapper().getAttribute('data-renderer');

// ---------------------------------------------------------------------------
// 1. Breakpoint mapping (pure)
// ---------------------------------------------------------------------------

describe('layoutForWidth', () => {
  it('maps widths onto the three layouts at the documented thresholds', () => {
    expect(layoutForWidth(320)).toBe('mobile');
    expect(layoutForWidth(599)).toBe('mobile');
    expect(layoutForWidth(600)).toBe('tablet');
    expect(layoutForWidth(1199)).toBe('tablet');
    expect(layoutForWidth(1200)).toBe('desktop');
    expect(layoutForWidth(1920)).toBe('desktop');
  });

  it('honours per-instance breakpoint overrides', () => {
    expect(layoutForWidth(700, { mobile: 800, tablet: 1400 })).toBe('mobile');
    expect(layoutForWidth(900, { mobile: 800, tablet: 1400 })).toBe('tablet');
    expect(layoutForWidth(1500, { mobile: 800, tablet: 1400 })).toBe('desktop');
  });

  it('publishes the documented default thresholds', () => {
    expect(DEFAULT_BREAKPOINTS).toEqual({ mobile: 600, tablet: 1200 });
  });
});

// ---------------------------------------------------------------------------
// 2. Renderer switching, driven by CONTAINER width
// ---------------------------------------------------------------------------

describe('DataTable — container-driven renderer switching', () => {
  it('renders the card list in a phone-width container', () => {
    renderAtWidth(400);

    expect(renderer()).toBe('mobile');
    expect(layout()).toBe('mobile');
    expect(screen.getByTestId('datatable-card-list')).toBeInTheDocument();
    expect(screen.getAllByTestId('datatable-card')).toHaveLength(3);
    // No grid at all.
    expect(
      screen.queryByRole('columnheader', { name: /^type$/i }),
    ).not.toBeInTheDocument();
  });

  it('renders the real grid in a tablet-width container, with detail columns folded away', () => {
    renderAtWidth(800);

    expect(layout()).toBe('tablet');
    // Still the grid renderer — tablet is a grid variant, not a third module.
    expect(renderer()).toBe('desktop');
    expect(
      screen.getByRole('columnheader', { name: /^type$/i }),
    ).toBeInTheDocument();
    // `detail` priority is hidden...
    expect(
      screen.queryByRole('columnheader', { name: /last error/i }),
    ).not.toBeInTheDocument();
    // ...but reachable, via the row expander.
    expect(screen.getAllByTestId('datatable-row-expander')).toHaveLength(3);
    expect(screen.queryByTestId('datatable-card-list')).not.toBeInTheDocument();
  });

  it('renders the full grid in a desktop-width container, with no expander', () => {
    renderAtWidth(1400);

    expect(layout()).toBe('desktop');
    expect(renderer()).toBe('desktop');
    expect(
      screen.getByRole('columnheader', { name: /last error/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('datatable-row-expander'),
    ).not.toBeInTheDocument();
  });

  /**
   * The reason the switch measures a container at all — issue #261's acceptance
   * case. Every media query in this file answers for a 1440px viewport, so a
   * `mobile` result here can only have come from the 400px container.
   */
  it('renders cards for a narrow container inside a WIDE viewport (drawer case)', () => {
    expect(window.matchMedia('(max-width:899.95px)').matches).toBe(false); // viewport is desktop

    renderAtWidth(400);

    expect(layout()).toBe('mobile');
    expect(screen.getByTestId('datatable-card-list')).toBeInTheDocument();
  });

  it('switches layout when the container is resized, viewport untouched', () => {
    renderAtWidth(1400);
    expect(layout()).toBe('desktop');

    setContainerWidth(800);
    expect(layout()).toBe('tablet');

    setContainerWidth(420);
    expect(layout()).toBe('mobile');

    setContainerWidth(1400);
    expect(layout()).toBe('desktop');
  });

  it('honours the per-instance mobileBreakpoint / tabletBreakpoint props', () => {
    renderAtWidth(800, { mobileBreakpoint: 900, tabletBreakpoint: 1600 });
    // 800 is normally tablet; this instance says everything under 900 is cards.
    expect(layout()).toBe('mobile');
  });

  it('honours a forced renderer regardless of container width', () => {
    renderAtWidth(1400, { renderer: 'mobile' });
    expect(layout()).toBe('mobile');
    expect(screen.getByTestId('datatable-card-list')).toBeInTheDocument();
  });

  it('honours a forced tablet layout', () => {
    renderAtWidth(1400, { renderer: 'tablet' });
    expect(layout()).toBe('tablet');
    expect(
      screen.queryByRole('columnheader', { name: /last error/i }),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 3. State preservation across a layout switch
// ---------------------------------------------------------------------------

/**
 * A page-shaped harness: it owns selection, pagination and sort exactly the way
 * a real caller does, so "state survives a resize" is a claim about the
 * architecture (state above the renderers) rather than about a renderer's
 * internals.
 */
function StatefulTable({
  initialSort,
}: {
  initialSort?: DataTableSortState | null;
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    new Set(['job-2']),
  );
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState<DataTableSortState | null>(
    initialSort ?? { field: 'attempts', direction: 'desc' },
  );

  return (
    <>
      <div data-testid="probe-selection">
        {Array.from(selectedIds).sort().join(',')}
      </div>
      <div data-testid="probe-page">{page}</div>
      <div data-testid="probe-sort">
        {sort ? `${sort.field}:${sort.direction}` : 'none'}
      </div>
      <DataTable<Job>
        columns={COLUMNS}
        rows={JOBS}
        rowId={rowId}
        ariaLabel="Enrichment jobs"
        selection={{ selectedIds, onSelectionChange: setSelectedIds }}
        sort={{ sort, onSortChange: setSort }}
        pagination={{
          page,
          pageSize,
          total: 137,
          onPaginationChange: (next) => {
            setPage(next.page);
            setPageSize(next.pageSize);
          },
        }}
      />
    </>
  );
}

describe('DataTable — state survives a layout switch', () => {
  it('keeps selection, page and sort across desktop -> mobile -> desktop', () => {
    containerWidth = 1400;
    render(<StatefulTable />);

    expect(screen.getByTestId('probe-selection')).toHaveTextContent('job-2');
    expect(screen.getByTestId('probe-page')).toHaveTextContent('1');
    expect(screen.getByTestId('probe-sort')).toHaveTextContent('attempts:desc');
    expect(
      screen.getByRole('columnheader', { name: /attempts/i }),
    ).toHaveAttribute('aria-sort', 'descending');

    // --- to the card layout -------------------------------------------------
    setContainerWidth(400);
    expect(layout()).toBe('mobile');

    // Selection is intact, and visible in the card layout.
    expect(screen.getByTestId('probe-selection')).toHaveTextContent('job-2');
    const selectedCard = screen
      .getAllByTestId('datatable-card')
      .find((card) => card.getAttribute('data-row-id') === 'job-2');
    expect(selectedCard).toHaveAttribute('data-selected', 'true');
    // "N of M selected" (issue #257): 1 of the 3 loaded rows.
    expect(
      within(screen.getByTestId('datatable-bulk-action-bar')).getByText(
        '1 of 3 selected',
      ),
    ).toBeInTheDocument();

    // Page is intact: page 1 (zero-based) of 25 => rows 26-28 of 137.
    expect(screen.getByTestId('probe-page')).toHaveTextContent('1');
    expect(
      screen.getByTestId('datatable-compact-pagination'),
    ).toHaveTextContent('26–28 of 137');

    // Sort is intact and still reachable, via the card sort control.
    expect(screen.getByTestId('probe-sort')).toHaveTextContent('attempts:desc');
    expect(
      within(screen.getByTestId('datatable-card-sort')).getByText('Attempts'),
    ).toBeInTheDocument();

    // --- back to the grid ---------------------------------------------------
    setContainerWidth(1400);
    expect(layout()).toBe('desktop');
    expect(screen.getByTestId('probe-selection')).toHaveTextContent('job-2');
    expect(screen.getByTestId('probe-page')).toHaveTextContent('1');
    expect(
      screen.getByRole('columnheader', { name: /attempts/i }),
    ).toHaveAttribute('aria-sort', 'descending');
  });

  it('carries a selection MADE on the card layout back to the grid', () => {
    containerWidth = 400;
    render(<StatefulTable />);

    const cards = screen.getAllByTestId('datatable-card');
    const firstCard = cards.find(
      (card) => card.getAttribute('data-row-id') === 'job-1',
    );
    // Named after the row it selects, not a bare "Select row" (issue #257) —
    // job-1's `type` is `face_detection`.
    fireEvent.click(
      within(firstCard as HTMLElement).getByRole('checkbox', {
        name: 'Select face_detection',
      }),
    );

    expect(screen.getByTestId('probe-selection')).toHaveTextContent(
      'job-1,job-2',
    );

    setContainerWidth(1400);
    expect(screen.getByTestId('probe-selection')).toHaveTextContent(
      'job-1,job-2',
    );
    expect(
      within(screen.getByTestId('datatable-bulk-action-bar')).getByText(
        '2 of 3 selected',
      ),
    ).toBeInTheDocument();
  });

  it('keeps pagination controlled from the card layout', () => {
    containerWidth = 400;
    render(<StatefulTable />);

    fireEvent.click(screen.getByRole('button', { name: /go to next page/i }));
    expect(screen.getByTestId('probe-page')).toHaveTextContent('2');
  });

  it('lets the card sort control clear the sort back to the server default', async () => {
    const user = userEvent.setup();
    containerWidth = 400;
    render(<StatefulTable />);

    await user.click(
      within(screen.getByTestId('datatable-card-sort')).getByRole('combobox'),
    );
    await user.click(screen.getByRole('option', { name: 'Default' }));

    expect(screen.getByTestId('probe-sort')).toHaveTextContent('none');
  });
});

// ---------------------------------------------------------------------------
// 4. Card layout — priority mapping and expansion
// ---------------------------------------------------------------------------

describe('CardListRenderer — priority drives the card', () => {
  it('puts primary columns in the headline and secondary columns in the body', () => {
    renderAtWidth(400);

    const card = screen
      .getAllByTestId('datatable-card')
      .find((c) => c.getAttribute('data-row-id') === 'job-2') as HTMLElement;

    // primary -> headline
    expect(
      within(card).getByTestId('datatable-card-headline-type'),
    ).toHaveTextContent('auto_tagging');
    // primary with a `render` keeps its rich cell, unchanged from the grid.
    expect(within(card).getByTestId('status-chip-job-2')).toHaveTextContent(
      'FAILED',
    );
    // secondary -> body label/value pair
    const attempts = within(card).getByTestId('datatable-card-field-attempts');
    expect(attempts).toHaveTextContent('Attempts');
    expect(attempts).toHaveTextContent('3');
  });

  it('does not carry a column’s grid alignment into the card (issue #438)', () => {
    // `attempts` declares `align: 'right'` for the grid, where the cells and
    // the header share an edge to scan down. On a card the label sits ABOVE the
    // value, so aligning the value anywhere but the start edge separates the
    // pair from its own label.
    renderAtWidth(400);

    const card = screen
      .getAllByTestId('datatable-card')
      .find((c) => c.getAttribute('data-row-id') === 'job-2') as HTMLElement;
    const field = within(card).getByTestId('datatable-card-field-attempts');

    for (const element of [
      field,
      ...Array.from(field.children),
    ] as HTMLElement[]) {
      expect(['right', 'center']).not.toContain(
        getComputedStyle(element).textAlign,
      );
    }
  });

  it('renders an em dash for a null scalar, matching the grid', () => {
    renderAtWidth(400);
    const card = screen
      .getAllByTestId('datatable-card')
      .find((c) => c.getAttribute('data-row-id') === 'job-1') as HTMLElement;

    fireEvent.click(
      within(card).getByRole('button', { name: /more details/i }),
    );
    expect(
      within(card).getByTestId('datatable-card-field-lastError'),
    ).toHaveTextContent('—');
  });

  it('keeps the detail region CLOSED by default', () => {
    renderAtWidth(400);

    expect(
      screen.queryByTestId('datatable-card-detail-region'),
    ).not.toBeInTheDocument();
    for (const toggle of screen.getAllByTestId(
      'datatable-card-detail-toggle',
    )) {
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
    }
    // The detail column's value is genuinely not on screen while collapsed.
    expect(
      screen.queryByText(/rate limited by provider/),
    ).not.toBeInTheDocument();
  });

  it('opens the detail region on tap', () => {
    renderAtWidth(400);
    const card = screen
      .getAllByTestId('datatable-card')
      .find((c) => c.getAttribute('data-row-id') === 'job-2') as HTMLElement;

    fireEvent.click(
      within(card).getByRole('button', { name: /more details/i }),
    );

    const region = within(card).getByTestId('datatable-card-detail-region');
    expect(region).toHaveTextContent('Last error');
    expect(region).toHaveTextContent(
      'rate limited by provider after three consecutive attempts',
    );
    expect(
      within(card).getByTestId('datatable-card-detail-toggle'),
    ).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens the detail region with Enter and closes it with Space', async () => {
    const user = userEvent.setup();
    renderAtWidth(400);
    const card = screen
      .getAllByTestId('datatable-card')
      .find((c) => c.getAttribute('data-row-id') === 'job-2') as HTMLElement;

    const toggle = within(card).getByTestId('datatable-card-detail-toggle');
    toggle.focus();

    await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('expands one card without expanding its siblings', () => {
    renderAtWidth(400);

    fireEvent.click(screen.getAllByTestId('datatable-card-detail-toggle')[0]);
    expect(screen.getAllByTestId('datatable-card-detail-region')).toHaveLength(
      1,
    );
  });

  it('renders a compact pagination control instead of the desktop footer', () => {
    renderAtWidth(400, {
      pagination: {
        page: 0,
        pageSize: 25,
        total: 137,
        onPaginationChange: vi.fn(),
      },
    });

    const compact = screen.getByTestId('datatable-compact-pagination');
    expect(compact).toHaveTextContent('1–3 of 137');
    // No rows-per-page select — that is the control that overflows a phone.
    expect(screen.queryByLabelText(/rows per page/i)).not.toBeInTheDocument();
  });

  it('disables the previous-page control on the first page', () => {
    renderAtWidth(400, {
      pagination: {
        page: 0,
        pageSize: 25,
        total: 137,
        onPaginationChange: vi.fn(),
      },
    });
    expect(
      screen.getByRole('button', { name: /go to previous page/i }),
    ).toBeDisabled();
  });

  it('shows the caller-supplied empty state and the error alert', () => {
    renderAtWidth(400, {
      rows: [],
      emptyState: <span>No jobs match these filters</span>,
      error: 'Failed to load jobs',
    });

    expect(
      within(screen.getByTestId('datatable-empty-overlay')).getByText(
        'No jobs match these filters',
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId('datatable-error')).toHaveTextContent(
      'Failed to load jobs',
    );
  });
});

// ---------------------------------------------------------------------------
// 4b. `column.align` stops at the grid (issue #438)
// ---------------------------------------------------------------------------

describe('CardField — alignment is a grid-only concern', () => {
  const centred: DataTableColumn<Job> = {
    id: 'attempts',
    label: 'Attempts',
    priority: 'secondary',
    align: 'center',
    value: (job) => job.attempts,
  };

  it('start-aligns a centre-aligned column’s value, so it stays under its label', () => {
    render(<CardField column={centred} row={JOBS[1]} />);

    const field = screen.getByTestId('datatable-card-field-attempts');
    for (const element of [
      field,
      ...Array.from(field.children),
    ] as HTMLElement[]) {
      expect(['right', 'center']).not.toContain(
        getComputedStyle(element).textAlign,
      );
    }
  });

  it('keeps a truncated value’s expand control out of the column’s alignment', () => {
    render(<CardField column={{ ...centred, truncate: true }} row={JOBS[1]} />);

    // The clamp turns the value into a `ButtonBase`, which must not pick the
    // column's alignment up either. (The button's own `textAlign: 'start'`
    // override — a `button`'s UA default is centred — is not assertable here:
    // jsdom's naive cascade reports MUI's own class, not the `sx` rule.)
    const field = screen.getByTestId('datatable-card-field-attempts');
    for (const element of [
      field,
      ...Array.from(field.children),
    ] as HTMLElement[]) {
      expect(['right', 'center']).not.toContain(
        getComputedStyle(element).textAlign,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Card layout — truncation is tap-to-expand
// ---------------------------------------------------------------------------

describe('CardListRenderer — truncated values', () => {
  it('clamps a truncate column and expands it in place on tap', () => {
    renderAtWidth(400);
    const card = screen
      .getAllByTestId('datatable-card')
      .find((c) => c.getAttribute('data-row-id') === 'job-2') as HTMLElement;

    fireEvent.click(
      within(card).getByRole('button', { name: /more details/i }),
    );

    const value = within(card).getByTestId('datatable-card-expandable-value');
    expect(value).toHaveAttribute('data-expanded', 'false');
    expect(value).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(value);
    expect(value).toHaveAttribute('data-expanded', 'true');
    expect(value).toHaveAttribute('aria-expanded', 'true');
    // The full text was in the DOM all along — the clamp is visual, so the
    // value can never be lost, only folded.
    expect(value).toHaveTextContent(
      'rate limited by provider after three consecutive attempts',
    );
  });

  it('exposes the expander as a real button, so Enter works', async () => {
    const user = userEvent.setup();
    renderAtWidth(400);
    const card = screen
      .getAllByTestId('datatable-card')
      .find((c) => c.getAttribute('data-row-id') === 'job-2') as HTMLElement;
    fireEvent.click(
      within(card).getByRole('button', { name: /more details/i }),
    );

    const value = within(card).getByTestId('datatable-card-expandable-value');
    value.focus();
    await user.keyboard('{Enter}');
    expect(value).toHaveAttribute('data-expanded', 'true');
  });

  it('does not make a non-truncate column expandable', () => {
    renderAtWidth(400);
    const card = screen
      .getAllByTestId('datatable-card')
      .find((c) => c.getAttribute('data-row-id') === 'job-2') as HTMLElement;
    // Only `lastError` declares truncate, and it is behind the closed detail
    // region — so no expandable value is on screen yet.
    expect(
      within(card).queryByTestId('datatable-card-expandable-value'),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 6. Card layout — selection parity with the grid
// ---------------------------------------------------------------------------

describe('CardListRenderer — selection parity', () => {
  it('toggles a single row and reports the same id set the grid would', () => {
    const onSelectionChange = vi.fn();
    renderAtWidth(400, {
      selection: { selectedIds: new Set<string>(), onSelectionChange },
    });

    // job-1's `type` is `face_detection`; the checkbox is named after it
    // rather than a bare "Select row" (issue #257).
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select face_detection' }),
    );
    expect(
      Array.from(onSelectionChange.mock.calls[0][0] as Set<string>),
    ).toEqual(['job-1']);
  });

  it('offers the same page-scoped select-all as the grid header checkbox', () => {
    const onSelectionChange = vi.fn();
    renderAtWidth(400, {
      selection: { selectedIds: new Set<string>(), onSelectionChange },
    });

    fireEvent.click(screen.getByRole('checkbox', { name: /select all rows/i }));
    expect(
      Array.from(onSelectionChange.mock.calls[0][0] as Set<string>).sort(),
    ).toEqual(['job-1', 'job-2', 'job-3']);
  });

  it('deselects everything when select-all is toggled off', () => {
    const onSelectionChange = vi.fn();
    renderAtWidth(400, {
      selection: {
        selectedIds: new Set(['job-1', 'job-2', 'job-3']),
        onSelectionChange,
      },
    });

    fireEvent.click(screen.getByRole('checkbox', { name: /select all rows/i }));
    expect((onSelectionChange.mock.calls[0][0] as Set<string>).size).toBe(0);
  });

  it('reuses the shared BulkActionBar verbatim', () => {
    const archive = vi.fn();
    renderAtWidth(400, {
      selection: {
        selectedIds: new Set(['job-1', 'job-2']),
        onSelectionChange: vi.fn(),
      },
      bulkActions: [{ id: 'archive', label: 'Archive', onClick: archive }],
    });

    const bar = screen.getByTestId('datatable-bulk-action-bar');
    expect(bar).toHaveAttribute('role', 'toolbar');
    expect(within(bar).getByText('2 of 3 selected')).toBeInTheDocument();

    fireEvent.click(within(bar).getByRole('button', { name: 'Archive' }));
    expect(archive).toHaveBeenCalledWith(['job-1', 'job-2']);
  });

  it('renders no checkboxes without a selection config', () => {
    renderAtWidth(400);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('datatable-bulk-action-bar'),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 7. Card layout — row actions in the header overflow menu
// ---------------------------------------------------------------------------

describe('CardListRenderer — row actions', () => {
  it('collapses even a SINGLE action into the card header overflow menu', () => {
    const retry = vi.fn();
    renderAtWidth(400, {
      rowActions: [{ id: 'retry', label: 'Retry', onClick: retry }],
    });

    // No bare icon button; the affordance is always the same menu.
    expect(
      screen.queryByRole('button', { name: 'Retry' }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Row actions for face_detection' }),
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledWith(JOBS[0]);
  });

  it('names each card menu button after its row headline', () => {
    renderAtWidth(400, {
      rowActions: [{ id: 'retry', label: 'Retry', onClick: vi.fn() }],
    });

    expect(
      screen.getByRole('button', { name: 'Row actions for auto_tagging' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Row actions for geocode' }),
    ).toBeInTheDocument();
  });

  it('disables an action per row inside the menu', () => {
    renderAtWidth(400, {
      rowActions: [
        {
          id: 'retry',
          label: 'Retry',
          onClick: vi.fn(),
          disabled: (row) => row.status === 'pending',
        },
      ],
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Row actions for geocode' }),
    );
    expect(screen.getByRole('menuitem', { name: 'Retry' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('gates a destructive action behind the SAME confirmation dialog as the grid', () => {
    const destroy = vi.fn();
    renderAtWidth(400, {
      rowActions: [
        { id: 'retry', label: 'Retry', onClick: vi.fn() },
        {
          id: 'delete',
          label: 'Delete',
          destructive: true,
          confirm: {
            title: 'Delete job?',
            description: 'This removes the job row permanently.',
          },
          onClick: destroy,
        },
      ],
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Row actions for auto_tagging' }),
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(destroy).not.toHaveBeenCalled();

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Delete job?')).toBeInTheDocument();
    expect(
      within(dialog).getByText('This removes the job row permanently.'),
    ).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(destroy).toHaveBeenCalledWith(JOBS[1]);
  });

  it('does not run a confirming action when the dialog is cancelled', () => {
    const destroy = vi.fn();
    renderAtWidth(400, {
      rowActions: [
        {
          id: 'delete',
          label: 'Delete',
          destructive: true,
          confirm: true,
          onClick: destroy,
        },
      ],
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Row actions for face_detection' }),
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Cancel',
      }),
    );
    expect(destroy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 8. Tablet — hidden detail columns stay reachable
// ---------------------------------------------------------------------------

describe('DesktopGridRenderer — tablet row expansion', () => {
  it('reveals the hidden detail columns as label/value pairs', () => {
    renderAtWidth(800);

    expect(
      screen.queryByRole('columnheader', { name: /last error/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('datatable-row-detail-panel'),
    ).not.toBeInTheDocument();

    // Row 2 is `auto_tagging`, the one with a lastError.
    const expanders = screen.getAllByTestId('datatable-row-expander');
    expect(expanders[1]).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(expanders[1]);

    const panel = screen.getByTestId('datatable-row-detail-panel');
    expect(within(panel).getByText('Last error')).toBeInTheDocument();
    expect(panel).toHaveTextContent(
      'rate limited by provider after three consecutive attempts',
    );
    expect(screen.getAllByTestId('datatable-row-expander')[1]).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('collapses the row again on a second activation', () => {
    renderAtWidth(800);

    fireEvent.click(screen.getAllByTestId('datatable-row-expander')[1]);
    expect(
      screen.getByTestId('datatable-row-detail-panel'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getAllByTestId('datatable-row-expander')[1]);
    expect(
      screen.queryByTestId('datatable-row-detail-panel'),
    ).not.toBeInTheDocument();
  });

  it('keeps the real rows intact and selectable while a row is expanded', () => {
    const onSelectionChange = vi.fn();
    renderAtWidth(800, {
      selection: { selectedIds: new Set<string>(), onSelectionChange },
    });

    fireEvent.click(screen.getAllByTestId('datatable-row-expander')[0]);

    // The synthetic detail row must not add a selectable row. Row checkboxes
    // are named after their row (issue #257), so match only those three —
    // not the header "Select all rows" checkbox.
    const rowCheckboxes = screen.getAllByRole('checkbox', {
      name: /^select (face_detection|auto_tagging|geocode)$/i,
    });
    expect(rowCheckboxes).toHaveLength(3);

    fireEvent.click(rowCheckboxes[0]);
    expect(
      Array.from(onSelectionChange.mock.calls[0][0] as Set<string>),
    ).toEqual(['job-1']);
  });

  it('adds no expander when the table declares no detail columns', () => {
    const noDetail = COLUMNS.filter((column) => column.priority !== 'detail');
    renderAtWidth(800, { columns: noDetail });

    expect(layout()).toBe('tablet');
    expect(
      screen.queryByTestId('datatable-row-expander'),
    ).not.toBeInTheDocument();
  });

  it('gives the expander a comfortable touch target, except at compact density', () => {
    // A tablet is a touch device and this is the only route to the hidden
    // columns — but a `compact` row is 36px tall and cannot hold a 44px target.
    const { unmount } = renderAtWidth(800);
    expect(
      Number.parseFloat(
        getComputedStyle(screen.getAllByTestId('datatable-row-expander')[0])
          .minHeight || '0',
      ),
    ).toBeGreaterThanOrEqual(44);
    unmount();

    renderAtWidth(800, { density: 'compact' });
    expect(
      getComputedStyle(screen.getAllByTestId('datatable-row-expander')[0])
        .minHeight,
    ).not.toBe('44px');
  });

  it('does not fall back to "phone or desktop" at the sm boundary', () => {
    // 600px is the first tablet width: it must be the grid, not cards, and it
    // must not be the unqualified desktop grid either.
    renderAtWidth(600);
    expect(layout()).toBe('tablet');
    expect(screen.queryByTestId('datatable-card-list')).not.toBeInTheDocument();
    expect(
      screen.getAllByTestId('datatable-row-expander').length,
    ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 9. Touch-target rule / issue #243 regression guard
// ---------------------------------------------------------------------------

/**
 * The exact bug filed as issue #243: a control revealed on `:hover` sits at
 * `opacity: 0` on a touch device but stays fully hit-testable, so a user taps
 * something they cannot see. The rule is therefore not "don't use opacity" but
 * "invisible implies non-interactive": anything at `opacity: 0` must also carry
 * `pointer-events: none` (or be gated behind `@media (hover: hover)`, which
 * never applies on a touch device).
 */

// `assertNoInvisibleHitTargets` is imported from `./testUtils/a11yGuards`
// (issue #257 consolidated the four near-identical copies of this guard into
// one shared module — see that file's docblock).

describe('DataTable — no invisible-but-tappable controls (issue #243 guard)', () => {
  it('holds for the card layout, with everything on screen', () => {
    renderAtWidth(400, {
      selection: {
        selectedIds: new Set(['job-1']),
        onSelectionChange: vi.fn(),
      },
      bulkActions: [{ id: 'archive', label: 'Archive', onClick: vi.fn() }],
      rowActions: [{ id: 'retry', label: 'Retry', onClick: vi.fn() }],
      pagination: {
        page: 0,
        pageSize: 25,
        total: 137,
        onPaginationChange: vi.fn(),
      },
      sort: {
        sort: { field: 'attempts', direction: 'desc' },
        onSortChange: vi.fn(),
      },
    });

    // Open every collapsible region so nothing escapes the sweep.
    for (const toggle of screen.getAllByTestId(
      'datatable-card-detail-toggle',
    )) {
      fireEvent.click(toggle);
    }

    assertNoInvisibleHitTargets(screen.getByTestId('datatable'));
  });

  it('holds for the tablet layout with a row expanded', () => {
    renderAtWidth(800, {
      selection: {
        selectedIds: new Set(['job-1']),
        onSelectionChange: vi.fn(),
      },
      rowActions: [{ id: 'retry', label: 'Retry', onClick: vi.fn() }],
    });

    fireEvent.click(screen.getAllByTestId('datatable-row-expander')[1]);
    assertNoInvisibleHitTargets(screen.getByTestId('datatable'));
  });

  it('gives every card control a >=44px touch target', () => {
    renderAtWidth(400, {
      selection: { selectedIds: new Set<string>(), onSelectionChange: vi.fn() },
      rowActions: [{ id: 'retry', label: 'Retry', onClick: vi.fn() }],
      pagination: {
        page: 1,
        pageSize: 25,
        total: 137,
        onPaginationChange: vi.fn(),
      },
    });

    const mustBeTouchSized = [
      screen.getByRole('checkbox', { name: 'Select face_detection' }),
      screen.getByRole('checkbox', { name: /select all rows/i }),
      screen.getByRole('button', { name: 'Row actions for face_detection' }),
      screen.getAllByTestId('datatable-card-detail-toggle')[0],
      screen.getByRole('button', { name: /go to next page/i }),
      screen.getByRole('button', { name: /go to previous page/i }),
    ];

    for (const control of mustBeTouchSized) {
      // The checkbox input is wrapped; the sizing lives on the labelled span.
      const sized =
        control.closest<HTMLElement>('[class*="MuiCheckbox-root"]') ?? control;
      const style = getComputedStyle(sized);
      expect(Number.parseFloat(style.minHeight || '0')).toBeGreaterThanOrEqual(
        44,
      );
    }
  });

  it('shows every card control without any pointer interaction (no hover reveal)', () => {
    renderAtWidth(400, {
      selection: { selectedIds: new Set<string>(), onSelectionChange: vi.fn() },
      rowActions: [{ id: 'retry', label: 'Retry', onClick: vi.fn() }],
    });

    // The issue #243 bug was a gallery tile's checkbox that needed a hover to
    // appear; a card's must not — a card list is a touch surface first.
    const list = screen.getByTestId('datatable-card-list');
    const painted = Array.from(
      list.querySelectorAll<HTMLElement>('.MuiCheckbox-root, button'),
    );
    expect(painted.length).toBeGreaterThan(0);
    for (const control of painted) {
      expect(getComputedStyle(control).opacity).not.toBe('0');
    }
  });
});
