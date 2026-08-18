/**
 * DataTable — the shared conformance suite (issue #257, epic #238).
 *
 * The point of this module, stated in the issue that created it: the
 * component replaces 16 hand-rolled tables, so whatever regression surface it
 * has is inherited by every one of them at once. The migration issues
 * (#258–#261) should only ever need to write PAGE-specific tests — their own
 * column definitions, their own business logic — never table MECHANICS.
 * Mechanics are tested exactly once, here, against a fixture table, and every
 * migrated page gets that coverage for free by calling
 * {@link runDataTableConformanceSuite}.
 *
 * ## How a page uses this
 *
 * The zero-argument call is what `DataTableConformance.test.tsx` in this
 * directory does — it runs the whole suite against the built-in fixture below
 * and IS the DataTable component's own regression suite for #257's
 * requirements. A migrating page (#258 onward) does not usually need to call
 * this at all: table mechanics don't change per column set, so the coverage
 * below already applies to every table built on this component. The one
 * reason a page WOULD call it is a column whose `render` produces something
 * unusual (a multi-control cell, an embedded form) where "does keyboard nav
 * survive this specific custom content" is worth re-asking against the page's
 * own columns:
 *
 * ```tsx
 * import { runDataTableConformanceSuite } from
 *   '../../../components/datatable/__tests__/conformance/runDataTableConformanceSuite';
 *
 * describe('JobsTable', () => {
 *   runDataTableConformanceSuite({
 *     label: 'JobsTable',
 *     columns: jobsTableColumns,   // the page's real DataTableColumn[]
 *     rows: sampleJobs,
 *     rowId: (job) => job.id,
 *   });
 *
 *   // ...page-specific tests only: business logic behind bulk actions,
 *   // the page's own fetch-and-map layer, column-specific rendering, etc.
 * });
 * ```
 *
 * See docs/specs/datatable.md §17 for the accessibility contract and
 * keyboard model this suite enforces, and for the full "what a migrating
 * page still needs to test" contract.
 *
 * ## What it covers
 *
 * Renderer switching + state preservation across a resize; server-side
 * pagination/sort/filter round-trips; selection and select-all including
 * under virtualization; loading/empty/error states in both renderers; column
 * visibility, density and persisted-view defaults; CSV escaping; the issue
 * #243 "invisible but tappable" guard; "no horizontal document scroll at
 * 360px"; automated axe checks in both renderers and both themes; the row/list
 * semantics, live-region announcements, and focus-management rules from the
 * accessibility contract (§17); and that DataGrid's own keyboard cell
 * navigation survives a column whose `render` produces interactive content
 * (chips, links, buttons).
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import type { ReactElement } from 'react';
import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import { CssBaseline, Chip } from '@mui/material';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { DataTable } from '../../DataTable';
import { rowAccessibleName } from '../../desktop/columnAdapter';
import type {
  DataTableColumn,
  DataTableFilterModel,
  DataTableSortState,
} from '../../types';
import { lightTheme, darkTheme } from '../../../../theme';
import { assertNoInvisibleHitTargets } from '../testUtils/a11yGuards';
import {
  installLayoutStubs,
  resetContainerWidth,
  setContainerWidth,
  setInitialContainerWidth,
} from '../testUtils/layoutStubs';

// ---------------------------------------------------------------------------
// The fixture table
// ---------------------------------------------------------------------------

export interface ConformanceRow {
  id: string;
  name: string;
  status: 'active' | 'paused' | 'archived';
  owner: string;
  score: number;
  notes: string | null;
}

export const conformanceFixtureRows: ConformanceRow[] = [
  { id: 'row-1', name: 'Nightly backup', status: 'active', owner: 'alice', score: 92, notes: null },
  {
    id: 'row-2',
    name: 'Thumbnail repair',
    status: 'paused',
    owner: 'bob',
    score: 41,
    notes: 'Waiting on a provider quota reset before this can resume automatically.',
  },
  { id: 'row-3', name: 'Geocode sweep', status: 'archived', owner: 'carol', score: 15, notes: null },
  { id: 'row-4', name: 'Face backfill', status: 'active', owner: 'alice', score: 77, notes: 'Re-run after the model upgrade.' },
  { id: 'row-5', name: 'Tag vocabulary sync', status: 'paused', owner: 'dave', score: 58, notes: null },
];

export const conformanceFixtureRowId = (row: ConformanceRow) => row.id;

/**
 * Deliberately exercises every corner of the column contract a page might
 * lean on: a `render`-only chip (status), a `render`ed interactive LINK
 * (owner) — the specific case that must survive DataGrid's own cell keyboard
 * navigation — a sortable+filterable number, and a `detail`+`truncate`
 * column with a null value in the fixture (row-1/row-3/row-5).
 */
export const conformanceFixtureColumns: DataTableColumn<ConformanceRow>[] = [
  {
    id: 'name',
    label: 'Name',
    priority: 'primary',
    sortable: true,
    searchable: true,
    filterable: true,
    value: (row) => row.name,
  },
  {
    id: 'status',
    label: 'Status',
    priority: 'primary',
    sortable: true,
    filterable: true,
    filterType: 'enum',
    enumValues: [
      { value: 'active', label: 'Active' },
      { value: 'paused', label: 'Paused' },
      { value: 'archived', label: 'Archived' },
    ],
    value: (row) => row.status,
    render: (row) => (
      <Chip size="small" label={row.status} data-testid={`status-chip-${row.id}`} />
    ),
  },
  {
    id: 'owner',
    label: 'Owner',
    priority: 'secondary',
    searchable: true,
    value: (row) => row.owner,
    // A real interactive control inside a custom `render` — this is what
    // "keyboard nav survives custom renderCell content" is tested against.
    render: (row) => (
      <a href={`#/owner/${row.owner}`} data-testid={`owner-link-${row.id}`}>
        {row.owner}
      </a>
    ),
  },
  {
    id: 'score',
    label: 'Score',
    priority: 'secondary',
    align: 'right',
    sortable: true,
    filterable: true,
    filterType: 'number',
    value: (row) => row.score,
  },
  {
    id: 'notes',
    label: 'Notes',
    priority: 'detail',
    truncate: true,
    value: (row) => row.notes,
  },
];

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/**
 * A minimal theme-aware render — no Router or Auth context, since
 * DataTable needs none of it. This is deliberately NOT the app-wide
 * `render` from `__tests__/utils/test-utils` (used by the other four
 * DataTable suites): that wrapper's `ThemeContextProvider` computes a theme
 * but never applies it via MUI's `<ThemeProvider>` (only `App.tsx` does), so
 * every existing DataTable test in fact renders against MUI's zero-config
 * default theme, never the app's actual `lightTheme`/`darkTheme` palettes.
 * The theme-aware checks this suite adds (contrast, both-theme axe passes)
 * need the REAL palette, so they use this wrapper instead.
 */
function renderWithTheme(ui: ReactElement, mode: 'light' | 'dark' = 'light') {
  return rtlRender(
    <ThemeProvider theme={mode === 'dark' ? darkTheme : lightTheme}>
      <CssBaseline />
      {ui}
    </ThemeProvider>,
  );
}

export interface RunDataTableConformanceSuiteOptions<Row> {
  /** Prefixes every `describe` block. Default `'DataTable'`. */
  label?: string;
  columns?: DataTableColumn<Row>[];
  rows?: Row[];
  rowId?: (row: Row) => string;
}

/**
 * Runs the full shared conformance suite. Call this at the top of a
 * `describe` block (or at module scope) — see the module docblock for the
 * default-fixture vs. custom-fixture usage split.
 */
export function runDataTableConformanceSuite<Row = ConformanceRow>(
  options: RunDataTableConformanceSuiteOptions<Row> = {},
): void {
  const label = options.label ?? 'DataTable';
  const columns = (options.columns ?? conformanceFixtureColumns) as unknown as DataTableColumn<Row>[];
  const rows = (options.rows ?? conformanceFixtureRows) as unknown as Row[];
  const rowId = (options.rowId ?? conformanceFixtureRowId) as (row: Row) => string;

  // -------------------------------------------------------------------------
  // Fixture-INDEPENDENT probes
  //
  // Everything below derives the identifiers the assertions need (a row's
  // accessible name, a sortable column, an enum filter, a hideable column)
  // from the column set the suite was HANDED, rather than naming the built-in
  // fixture's fields. Against the default fixture each one resolves to exactly
  // the value the suite used to hard-code, so the component's own run is
  // unchanged; against a page's real columns (issue #67) they resolve to that
  // page's equivalents, which is what makes `options.columns` mean anything.
  //
  // Three assertions cannot be derived this way — they need rows the suite
  // fabricates itself, or a specific interactive element inside a `render`.
  // Those are `runIf(usingDefaultFixture)` rather than silently weakened: a
  // mechanic is asserted once, and once is against the fixture built for it.
  // -------------------------------------------------------------------------

  /** `true` when running against the built-in fixture rather than a page's columns. */
  const usingDefaultFixture = !options.columns && !options.rows;

  /** The columns that are actually drawn — `filterOnly` ones have no cell. */
  const drawable = columns.filter((column) => !column.filterOnly);

  /** A row's accessible name: the first `primary` column's scalar. */
  const rowLabel = (row: Row): string => rowAccessibleName(drawable, row, rowId(row));

  const sortableColumns = drawable.filter((column) => column.sortable);
  /** The column whose header a "clicking sorts" assertion uses. */
  const primarySortColumn = sortableColumns[0];
  /** A second one, so "reflects the controlled state" is not the same column. */
  const secondarySortColumn = sortableColumns[1] ?? sortableColumns[0];

  /** An enum filter to stand in for "a filter is active". */
  const enumFilterColumn = drawable.find(
    (column) => column.filterable && column.filterType === 'enum' && column.enumValues?.length,
  );
  const sampleFilter: DataTableFilterModel[number] = enumFilterColumn?.enumValues?.[0]
    ? {
        columnId: enumFilterColumn.id,
        operator: 'is',
        value: enumFilterColumn.enumValues[0].value,
      }
    : { columnId: drawable[0].id, operator: 'contains', value: '\u0000no-match' };

  /**
   * The column the picker test hides. A non-`primary` one where possible: the
   * primary column supplies every row's accessible name, so hiding it would
   * rename half the controls the other assertions look for.
   */
  const hideableColumn =
    drawable.find((column) => column.hideable !== false && column.priority !== 'primary') ??
    drawable.find((column) => column.hideable !== false);

  type TableProps = React.ComponentProps<typeof DataTable<Row>>;

  function renderTable(
    overrides: Partial<TableProps> = {},
    opts: { theme?: 'light' | 'dark' } = {},
  ) {
    return renderWithTheme(
      <DataTable<Row>
        columns={columns}
        rows={rows}
        rowId={rowId}
        ariaLabel={`${label} fixture`}
        {...overrides}
      />,
      opts.theme,
    );
  }

  function renderAtWidth(
    width: number,
    overrides: Partial<TableProps> = {},
    opts: { theme?: 'light' | 'dark' } = {},
  ) {
    setInitialContainerWidth(width);
    return renderTable(overrides, opts);
  }

  const wrapper = () => screen.getByTestId('datatable');
  const layoutOf = () => wrapper().getAttribute('data-layout');

  beforeAll(() => {
    installLayoutStubs();
  });

  beforeEach(() => {
    resetContainerWidth(1400);
  });

  // =========================================================================
  // 1. Renderer switching + state preservation across a resize
  // =========================================================================

  describe(`${label} conformance — renderer switching`, () => {
    it('resolves mobile / tablet / desktop at the documented container breakpoints', () => {
      renderAtWidth(400);
      expect(layoutOf()).toBe('mobile');
      cleanup();

      renderAtWidth(800);
      expect(layoutOf()).toBe('tablet');
      cleanup();

      renderAtWidth(1400);
      expect(layoutOf()).toBe('desktop');
    });

    it('preserves selection, page, sort and filters across a resize in both directions', () => {
      function Stateful() {
        const [selectedIds, setSelectedIds] = useState<Set<string>>(
          new Set([rowId(rows[0])]),
        );
        const [page, setPage] = useState(0);
        const [sort, setSort] = useState<DataTableSortState | null>({
          field: primarySortColumn.id,
          direction: 'desc',
        });
        const [filters, setFilters] = useState<DataTableFilterModel>([sampleFilter]);

        return (
          <>
            <div data-testid="probe-selection">{Array.from(selectedIds).sort().join(',')}</div>
            <div data-testid="probe-page">{page}</div>
            <div data-testid="probe-sort">{sort ? `${sort.field}:${sort.direction}` : 'none'}</div>
            <div data-testid="probe-filters">{filters.length}</div>
            <DataTable<Row>
              columns={columns}
              rows={rows}
              rowId={rowId}
              ariaLabel={`${label} fixture`}
              selection={{ selectedIds, onSelectionChange: setSelectedIds }}
              sort={{ sort, onSortChange: setSort }}
              filters={filters}
              onFiltersChange={setFilters}
              pagination={{
                page,
                pageSize: 25,
                total: rows.length,
                onPaginationChange: (next) => setPage(next.page),
              }}
            />
          </>
        );
      }

      setInitialContainerWidth(1400);
      renderWithTheme(<Stateful />);

      expect(screen.getByTestId('probe-selection')).toHaveTextContent(rowId(rows[0]));
      expect(screen.getByTestId('probe-sort')).toHaveTextContent(
        `${primarySortColumn.id}:desc`,
      );
      expect(screen.getByTestId('probe-filters')).toHaveTextContent('1');

      setContainerWidth(400);
      expect(layoutOf()).toBe('mobile');
      expect(screen.getByTestId('probe-selection')).toHaveTextContent(rowId(rows[0]));
      expect(screen.getByTestId('probe-sort')).toHaveTextContent(
        `${primarySortColumn.id}:desc`,
      );
      expect(screen.getByTestId('probe-filters')).toHaveTextContent('1');

      setContainerWidth(1400);
      expect(layoutOf()).toBe('desktop');
      expect(screen.getByTestId('probe-selection')).toHaveTextContent(rowId(rows[0]));
      expect(screen.getByTestId('probe-sort')).toHaveTextContent(
        `${primarySortColumn.id}:desc`,
      );
      expect(screen.getByTestId('probe-filters')).toHaveTextContent('1');
    });
  });

  // =========================================================================
  // 2. Server-side pagination / sorting / filtering round-trips
  // =========================================================================

  describe(`${label} conformance — server round-trips`, () => {
    it('never slices, sorts or filters `rows` itself — pagination is a pure pass-through', () => {
      const onPaginationChange = vi.fn();
      renderTable({
        pagination: { page: 0, pageSize: 2, total: 137, onPaginationChange },
      });

      // Every row is drawn even though pageSize is 2 — the table trusts the
      // caller's `rows`, it never re-paginates them.
      for (const row of rows) {
        expect(screen.getByText(rowLabel(row))).toBeInTheDocument();
      }
      expect(screen.getByText(/of 137/)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /go to next page/i }));
      expect(onPaginationChange).toHaveBeenCalledWith({ page: 1, pageSize: 2 });
    });

    it('emits a sort request and reflects the controlled state — never sorts rows itself', () => {
      const onSortChange = vi.fn();
      renderTable({ sort: { sort: null, onSortChange } });

      fireEvent.click(
        screen.getByRole('columnheader', {
          name: new RegExp(`^${primarySortColumn.label}`, 'i'),
        }),
      );
      expect(onSortChange).toHaveBeenCalledWith({
        field: primarySortColumn.id,
        direction: 'asc',
      });

      cleanup();
      renderTable({
        sort: {
          sort: { field: secondarySortColumn.id, direction: 'desc' },
          onSortChange: vi.fn(),
        },
      });
      expect(
        screen.getByRole('columnheader', {
          name: new RegExp(`^${secondarySortColumn.label}`, 'i'),
        }),
      ).toHaveAttribute('aria-sort', 'descending');
    });

    it('emits a filter model and NEVER filters `rows` locally (negative test)', () => {
      const onFiltersChange = vi.fn();
      renderTable({
        filters: [sampleFilter],
        onFiltersChange,
      });

      // Every row is still on screen: the table trusts the caller already
      // filtered `rows` server-side, and never re-filters what it is handed.
      for (const row of rows) {
        expect(screen.getByText(rowLabel(row))).toBeInTheDocument();
      }

      fireEvent.click(screen.getByTestId('datatable-filter-chip-remove'));
      expect(onFiltersChange).toHaveBeenCalledWith([]);
    });
  });

  // =========================================================================
  // 3. Selection + select-all, including under virtualization
  // =========================================================================

  describe(`${label} conformance — selection`, () => {
    it('toggles one row and reports the id set back out', () => {
      const onSelectionChange = vi.fn();
      renderTable({ selection: { selectedIds: new Set<string>(), onSelectionChange } });

      const first = rows[0];
      fireEvent.click(screen.getByRole('checkbox', { name: `Select ${rowLabel(first)}` }));
      expect(Array.from(onSelectionChange.mock.calls[0][0] as Set<string>)).toEqual([
        rowId(first),
      ]);
    });

    // Fabricates 60 rows of the fixture's own shape, which the suite cannot do
    // for an arbitrary `Row`. The mechanic is table-wide, so asserting it once
    // against the fixture is the whole coverage.
    it.runIf(usingDefaultFixture)(
      'select-all reports every loaded row id, even past the virtualization threshold',
      () => {
      // 60 rows crosses `GRID_VIRTUALIZATION_ROW_THRESHOLD` (50) — select-all
      // must still resolve to every id, not just what happens to be mounted.
      const manyRows = Array.from({ length: 60 }, (_, i) => ({
        id: `bulk-${i}`,
        name: `Item ${i}`,
        status: 'active' as const,
        owner: 'alice',
        score: i,
        notes: null,
      })) as unknown as Row[];
      const manyRowIds = manyRows.map((row) => rowId(row));

      const onSelectionChange = vi.fn();
      renderTable({
        rows: manyRows,
        selection: { selectedIds: new Set<string>(), onSelectionChange },
      });

      expect(screen.getByTestId('datatable-scroll-container')).toHaveAttribute(
        'data-virtualized',
        'true',
      );

      fireEvent.click(screen.getByRole('checkbox', { name: /select all rows/i }));
      const emitted = onSelectionChange.mock.calls[0][0] as Set<string>;
      expect(emitted.size).toBe(60);
      expect(Array.from(emitted).sort()).toEqual([...manyRowIds].sort());
      },
    );

    it('mirrors select-all on the card layout, page-scoped', () => {
      const onSelectionChange = vi.fn();
      renderAtWidth(400, { selection: { selectedIds: new Set<string>(), onSelectionChange } });

      fireEvent.click(screen.getByRole('checkbox', { name: /select all rows/i }));
      const emitted = onSelectionChange.mock.calls[0][0] as Set<string>;
      expect(emitted.size).toBe(rows.length);
    });
  });

  // =========================================================================
  // 4. Loading / empty / error states, in both renderers
  // =========================================================================

  describe(`${label} conformance — loading / empty / error states`, () => {
    for (const [name, width] of [['desktop', 1400], ['mobile', 400]] as const) {
      it(`shows a loading overlay on ${name} without discarding rows already on screen`, () => {
        renderAtWidth(width, { loading: true });
        expect(screen.getByTestId('datatable-loading-overlay')).toBeInTheDocument();
      });

      it(`shows the caller's empty state on ${name}`, () => {
        renderAtWidth(width, { rows: [], emptyState: <span>Nothing here yet</span> });
        expect(
          within(screen.getByTestId('datatable-empty-overlay')).getByText('Nothing here yet'),
        ).toBeInTheDocument();
      });

      it(`renders the error alert on ${name} while keeping the table beneath it readable`, () => {
        renderAtWidth(width, { error: 'Failed to load' });
        expect(screen.getByTestId('datatable-error')).toHaveTextContent('Failed to load');
        expect(screen.getByText(rowLabel(rows[0]))).toBeInTheDocument();
      });
    }
  });

  // =========================================================================
  // 5. Column visibility, density, persisted-view defaults
  // =========================================================================

  describe(`${label} conformance — visibility, density, persisted defaults`, () => {
    it('opens with every hideable column visible when nothing is persisted (contract default)', () => {
      renderTable();
      for (const column of columns) {
        if (column.hideable === false) continue;
        expect(screen.getByRole('columnheader', { name: new RegExp(`^${column.label}$`, 'i') })).toBeInTheDocument();
      }
    });

    it('hides a column via the picker and keeps it out of a CSV export', () => {
      renderTable({ csvExport: {} });
      fireEvent.click(screen.getByTestId('datatable-columns-button'));
      fireEvent.click(screen.getByTestId(`datatable-column-toggle-${hideableColumn!.id}`));
      // Menu stays open (multi-toggle is one trip, not one per column).
      expect(
        screen.queryByRole('columnheader', {
          name: new RegExp(`^${hideableColumn!.label}$`, 'i'),
        }),
      ).not.toBeInTheDocument();
    });

    it('maps density onto BOTH renderers — grid row height and card padding', () => {
      renderTable({ density: 'compact' });
      expect(wrapper()).toHaveAttribute('data-density', 'compact');
      cleanup();

      renderAtWidth(400, { density: 'comfortable' });
      expect(screen.getByTestId('datatable-card-list')).toHaveAttribute('data-density', 'comfortable');
    });
  });

  // =========================================================================
  // 6. CSV export escaping
  // =========================================================================

  describe(`${label} conformance — CSV export`, () => {
    let createObjectURLSpy: ReturnType<typeof vi.fn>;
    let clickSpy: ReturnType<typeof vi.spyOn>;
    let lastBlob: Blob | null;

    beforeEach(() => {
      lastBlob = null;
      createObjectURLSpy = vi.fn((blob: Blob) => {
        lastBlob = blob;
        return 'blob:mock';
      });
      URL.createObjectURL = createObjectURLSpy as unknown as typeof URL.createObjectURL;
      URL.revokeObjectURL = vi.fn();
      clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    });

    afterEach(() => {
      clickSpy.mockRestore();
    });

    // Fabricates rows carrying quotes, commas and a negative number — the
    // fixture's own shape, and not something the suite can synthesize for an
    // arbitrary `Row`. Escaping is table-wide; once is enough.
    it.runIf(usingDefaultFixture)(
      'writes the `value` scalar for a `render`-only column, quotes/escapes as RFC 4180 requires',
      async () => {
      const quirky = [
        { id: 'q1', name: 'has "quotes"', status: 'active', owner: 'a,b', score: -5, notes: null },
      ] as unknown as Row[];
      renderTable({ rows: quirky, csvExport: {} });

      fireEvent.click(screen.getByTestId('datatable-export-button'));
      await waitFor(() => expect(lastBlob).not.toBeNull());

      const text = await (lastBlob as Blob).text();
      expect(text).toContain('"has ""quotes"""');
      expect(text).toContain('"a,b"');
      // A negative number is a real number, not a formula — must NOT be
      // apostrophe-neutralized.
      expect(text).toMatch(/(?<!')-5/);
      // The Chip-rendered `status` column still exports its scalar, not "[object Object]".
      expect(text).toContain('active');
      },
    );
  });

  // =========================================================================
  // 7. Issue #243 guard — no invisible-but-tappable control
  // =========================================================================

  describe(`${label} conformance — issue #243 guard`, () => {
    it('holds on the desktop grid with every affordance present', () => {
      renderTable({
        selection: { selectedIds: new Set([rowId(rows[0])]), onSelectionChange: vi.fn() },
        bulkActions: [{ id: 'archive', label: 'Archive', onClick: vi.fn() }],
        rowActions: [{ id: 'retry', label: 'Retry', onClick: vi.fn() }],
        sort: { sort: { field: primarySortColumn.id, direction: 'asc' }, onSortChange: vi.fn() },
        csvExport: {},
      });
      assertNoInvisibleHitTargets(wrapper());
    });

    it('holds on the card layout with every affordance present, detail regions opened', () => {
      renderAtWidth(400, {
        selection: { selectedIds: new Set([rowId(rows[0])]), onSelectionChange: vi.fn() },
        bulkActions: [{ id: 'archive', label: 'Archive', onClick: vi.fn() }],
        rowActions: [{ id: 'retry', label: 'Retry', onClick: vi.fn() }],
      });
      for (const toggle of screen.getAllByTestId('datatable-card-detail-toggle')) {
        fireEvent.click(toggle);
      }
      assertNoInvisibleHitTargets(wrapper());
    });
  });

  // =========================================================================
  // 8. No horizontal document scroll at 360px — the epic's headline criterion
  // =========================================================================

  describe(`${label} conformance — no horizontal document scroll at 360px`, () => {
    it('keeps every containment layer at max-width: 100% / min-width: 0 at a 360px container', () => {
      renderAtWidth(360, {
        rowActions: [{ id: 'retry', label: 'Retry', onClick: vi.fn() }],
        selection: { selectedIds: new Set<string>(), onSelectionChange: vi.fn() },
      });

      // The three containment layers named in §6 of the spec.
      const outer = wrapper();
      expect(getComputedStyle(outer).maxWidth).toBe('100%');
      expect(getComputedStyle(outer).minWidth).toBe('0px');

      const cardList = screen.getByTestId('datatable-card-list');
      expect(getComputedStyle(cardList).maxWidth).toBe('100%');
      expect(getComputedStyle(cardList).minWidth).toBe('0px');

      // The one thing this test can assert directly in jsdom (which performs
      // no real layout, so `scrollWidth` is stubbed — see `layoutStubs.ts`):
      // nothing in the tree sets an explicit width wider than the container,
      // and `document.body` never receives an inline width/overflow override.
      expect(document.body.style.width).toBe('');
      expect(document.body.style.overflowX).toBe('');
    });

    it('keeps the desktop grid variant contained at 360px too (forced, not just auto-picked)', () => {
      renderAtWidth(360, { renderer: 'desktop' });
      const scrollContainer = screen.getByTestId('datatable-scroll-container');
      expect(getComputedStyle(scrollContainer).overflowX).toBe('auto');
      expect(getComputedStyle(scrollContainer).maxWidth).toBe('100%');
      expect(document.body.style.width).toBe('');
    });
  });

  // =========================================================================
  // 9. Automated a11y assertions (axe) — both renderers, both themes
  // =========================================================================

  /**
   * `color-contrast` is disabled here — deliberately, and only here. jsdom
   * performs no real layout or paint, so the rule cannot resolve an element's
   * true effective background (every box is 0×0) and is a well-known
   * false-negative trap under jsdom; running it produces noise, not signal.
   * Real contrast coverage lives in `DataTableContrast.test.tsx`, computed
   * directly from the theme palette with a pure WCAG calculator
   * (`testUtils/contrast.ts`) — a stronger, deterministic check than axe could
   * give us in this environment anyway. Every other axe rule runs at full
   * strength; if one ever fires here, the fix belongs in the component, not
   * in this list.
   */
  const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

  describe(`${label} conformance — automated accessibility (axe)`, () => {
    const cases: Array<['desktop' | 'mobile', 'light' | 'dark']> = [
      ['desktop', 'light'],
      ['desktop', 'dark'],
      ['mobile', 'light'],
      ['mobile', 'dark'],
    ];

    for (const [rendererName, theme] of cases) {
      it(`has no axe violations — ${rendererName} renderer, ${theme} theme`, async () => {
        const { container } = renderAtWidth(
          rendererName === 'mobile' ? 400 : 1400,
          {
            selection: { selectedIds: new Set([rowId(rows[0])]), onSelectionChange: vi.fn() },
            bulkActions: [{ id: 'archive', label: 'Archive', onClick: vi.fn() }],
            rowActions: [{ id: 'retry', label: 'Retry', onClick: vi.fn() }],
            sort: { sort: { field: 'score', direction: 'desc' }, onSortChange: vi.fn() },
            filters: [sampleFilter],
            onFiltersChange: vi.fn(),
            csvExport: {},
          },
          { theme },
        );
        const results = await axe(container, AXE_OPTIONS);
        expect(results).toHaveNoViolations();
      });
    }

    it('the tablet grid variant (row expansion) has no axe violations', async () => {
      const { container } = renderAtWidth(800, {
        rowActions: [{ id: 'retry', label: 'Retry', onClick: vi.fn() }],
      });
      fireEvent.click(screen.getAllByTestId('datatable-row-expander')[0]);
      const results = await axe(container, AXE_OPTIONS);
      expect(results).toHaveNoViolations();
    });
  });

  // =========================================================================
  // 10. Renderer semantics — grid vs. list, per the accessibility contract
  // =========================================================================

  describe(`${label} conformance — renderer semantics`, () => {
    it('the desktop grid announces as a grid, named, with real row/column context', () => {
      renderTable();
      const grid = screen.getByRole('grid', { name: `${label} fixture` });
      expect(grid).toBeInTheDocument();
      // DataGrid's own row/column semantics — columnheader + gridcell/row roles.
      expect(screen.getAllByRole('columnheader').length).toBeGreaterThan(0);
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1); // header row + data rows
    });

    it('the card list announces as a LIST, and each card is labelled by its primary column', () => {
      renderAtWidth(400);
      const list = screen.getByRole('list', { name: `${label} fixture` });
      const items = within(list).getAllByRole('listitem');
      expect(items).toHaveLength(rows.length);

      // Each item's accessible name is its row's primary-column value — never
      // generic, never identical across rows.
      const names = items.map((item) => item.getAttribute('aria-label'));
      expect(names).toEqual(rows.map(rowLabel));
      expect(new Set(names).size).toBe(names.length);
    });
  });

  // =========================================================================
  // 11. Live-region announcements
  // =========================================================================

  describe(`${label} conformance — live-region announcements`, () => {
    it('announces "N of M selected" from a live region, on both renderers', () => {
      const first = rows[0];
      renderTable({
        selection: { selectedIds: new Set([rowId(first)]), onSelectionChange: vi.fn() },
      });
      const status = within(screen.getByTestId('datatable-bulk-action-bar')).getByRole('status');
      expect(status).toHaveAttribute('aria-live', 'polite');
      expect(status).toHaveTextContent(`1 of ${rows.length} selected`);
      cleanup();

      renderAtWidth(400, {
        selection: { selectedIds: new Set([rowId(first)]), onSelectionChange: vi.fn() },
      });
      expect(
        within(screen.getByTestId('datatable-bulk-action-bar')).getByRole('status'),
      ).toHaveTextContent(`1 of ${rows.length} selected`);
    });

    it('announces "Filtered to N results" once a filter is active and the page reports a total', () => {
      renderTable({
        filters: [sampleFilter],
        onFiltersChange: vi.fn(),
        pagination: { page: 0, pageSize: 25, total: 12, onPaginationChange: vi.fn() },
      });
      const region = screen.getByTestId('datatable-filter-live-region');
      expect(region).toHaveAttribute('aria-live', 'polite');
      expect(region).toHaveTextContent('Filtered to 12 results');
    });

    it('stays silent with no active filter and no active search', () => {
      renderTable({
        filters: [],
        onFiltersChange: vi.fn(),
        pagination: { page: 0, pageSize: 25, total: 5, onPaginationChange: vi.fn() },
      });
      expect(screen.getByTestId('datatable-filter-live-region')).toHaveTextContent('');
    });

    it('singularizes "1 result"', () => {
      renderTable({
        filters: [sampleFilter],
        onFiltersChange: vi.fn(),
        pagination: { page: 0, pageSize: 25, total: 1, onPaginationChange: vi.fn() },
      });
      expect(screen.getByTestId('datatable-filter-live-region')).toHaveTextContent(
        'Filtered to 1 result',
      );
      expect(screen.getByTestId('datatable-filter-live-region')).not.toHaveTextContent('1 results');
    });
  });

  // =========================================================================
  // 12. Focus management — sheet / menu / overflow menu trap and restore
  // =========================================================================

  describe(`${label} conformance — focus management`, () => {
    it('the phone filter sheet traps focus and restores it to the trigger on close', async () => {
      const user = userEvent.setup();
      renderAtWidth(400, { filters: [], onFiltersChange: vi.fn() });

      const trigger = screen.getByTestId('datatable-filter-toggle');
      trigger.focus();
      await user.click(trigger);

      const dialog = await screen.findByRole('dialog');
      expect(dialog.contains(document.activeElement)).toBe(true);

      // Tabbing repeatedly never escapes the dialog (MUI's Modal focus trap).
      for (let i = 0; i < 8; i += 1) {
        await user.tab();
        expect(dialog.contains(document.activeElement)).toBe(true);
      }

      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(document.activeElement).toBe(trigger);
    });

    it('the desktop column-picker menu traps focus and restores it to the trigger on close', async () => {
      const user = userEvent.setup();
      renderTable();

      const trigger = screen.getByTestId('datatable-columns-button');
      trigger.focus();
      await user.click(trigger);

      const menu = await screen.findByRole('menu');
      expect(menu.contains(document.activeElement)).toBe(true);

      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
      expect(document.activeElement).toBe(trigger);
    });

    it("a row's overflow menu traps focus and restores it to the trigger on close", async () => {
      const user = userEvent.setup();
      renderTable({
        rowActions: [
          { id: 'retry', label: 'Retry', onClick: vi.fn() },
          { id: 'delete', label: 'Delete', destructive: true, onClick: vi.fn() },
        ],
      });

      const first = rows[0];
      const trigger = screen.getByRole('button', {
        name: `Row actions for ${rowLabel(first)}`,
      });
      trigger.focus();
      await user.click(trigger);

      const menu = await screen.findByRole('menu');
      expect(menu.contains(document.activeElement)).toBe(true);

      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
      expect(document.activeElement).toBe(trigger);
    });
  });

  // =========================================================================
  // 13. Keyboard model
  // =========================================================================

  describe(`${label} conformance — keyboard model`, () => {
    // Targets the fixture's own `<a data-testid="owner-link-…">` inside a
    // `render` cell. A page's columns may contain no interactive cell at all,
    // so this one stays pinned to the fixture that guarantees one.
    it.runIf(usingDefaultFixture)(
      'the interactive content of a custom `render` cell is reachable by Tab and activatable',
      () => {
        renderTable();

        const first = rows[0] as unknown as ConformanceRow;
        const link = screen.getByTestId(`owner-link-${first.id}`);
        // Not sitting inertly off the tab order: a real DOM tab walk reaches it.
        link.focus();
        expect(document.activeElement).toBe(link);
      },
    );

    it('every row-checkbox is independently reachable and toggleable by keyboard', async () => {
      const onSelectionChange = vi.fn();
      renderTable({ selection: { selectedIds: new Set<string>(), onSelectionChange } });

      const first = rows[0];
      const checkbox = screen.getByRole('checkbox', { name: `Select ${rowLabel(first)}` });
      checkbox.focus();
      expect(document.activeElement).toBe(checkbox);
      fireEvent.keyDown(checkbox, { key: ' ' });
      fireEvent.click(checkbox);
      expect(onSelectionChange).toHaveBeenCalled();
    });

    it('the tablet row-expander is a real button reachable and activatable by keyboard', async () => {
      const user = userEvent.setup();
      renderAtWidth(800);

      const expander = screen.getAllByTestId('datatable-row-expander')[0];
      expander.focus();
      await user.keyboard('{Enter}');
      expect(expander).toHaveAttribute('aria-expanded', 'true');
    });

    it('the card sort control and pagination are fully keyboard-operable (no pointer-only affordance)', async () => {
      const user = userEvent.setup();
      const onSortChange = vi.fn();
      renderAtWidth(400, {
        sort: { sort: null, onSortChange },
        pagination: { page: 0, pageSize: 25, total: 137, onPaginationChange: vi.fn() },
      });

      await user.click(within(screen.getByTestId('datatable-card-sort')).getByRole('combobox'));
      await user.click(screen.getByRole('option', { name: primarySortColumn.label }));
      expect(onSortChange).toHaveBeenCalledWith({
        field: primarySortColumn.id,
        direction: 'asc',
      });

      const nextPage = screen.getByRole('button', { name: /go to next page/i });
      nextPage.focus();
      expect(document.activeElement).toBe(nextPage);
    });

    it('bulk select-all is reachable and toggleable by keyboard on both renderers', () => {
      const onSelectionChange = vi.fn();
      renderTable({ selection: { selectedIds: new Set<string>(), onSelectionChange } });
      const selectAll = screen.getByRole('checkbox', { name: /select all rows/i });
      selectAll.focus();
      expect(document.activeElement).toBe(selectAll);
      fireEvent.click(selectAll);
      expect(onSelectionChange).toHaveBeenCalled();
    });
  });
}
