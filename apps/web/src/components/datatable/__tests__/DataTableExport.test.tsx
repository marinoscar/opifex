/**
 * Component tests — DataTable CSV export and row virtualization
 * (issue #256, epic #238).
 *
 * Six things this suite exists to pin down, in the order they can bite:
 *
 *  1. **A CSV is a file another program opens.** Commas, quotes and newlines
 *     have to survive a round trip, and the four formula-injection prefixes
 *     (`=`, `+`, `-`, `@`) have to be neutralized — a cell reading
 *     `=cmd|'/c calc'!A1` is code the moment Excel opens the file. The UTF-8
 *     BOM is asserted on the downloaded bytes, not on a helper's return value.
 *  2. **Export writes the `value` scalar, never the rendered node.** A column
 *     whose cell is a `<Chip>` exports what is behind the chip.
 *  3. **Export writes what is on screen.** The user's column visibility (#255)
 *     and `exportable: false` both bound the file; the active filters bound it
 *     by bounding `rows`, because the table never filters rows itself (§10.1).
 *  4. **The all-rows export is the PAGE's query, replayed.** It never invents a
 *     request, is bounded at 10 000 rows, and is cancellable.
 *  5. **Selection stays row-set-derived, not DOM-derived.** That is what makes
 *     select-all correct once the grid virtualizes and only some rows exist in
 *     the DOM.
 *  6. **The card list skips off-screen rendering without guessing heights.**
 *     The placeholder is measured, the measured card is excluded, and an
 *     expanding card opts out (issue #237's failure mode).
 *
 * ## Test doubles
 *
 * Layout stubs are the #253 recipe (container-driven width, `matchMedia` pinned
 * to a 1440px viewport). The download path is stubbed at `URL.createObjectURL`
 * plus `HTMLAnchorElement.click`, so the assertions run against the real Blob
 * the component built rather than against an injected seam.
 *
 * jsdom performs no layout, and MUI X switches virtualization off outright when
 * `platform.env.jsdom` is true — so the grid tests assert the *decision*
 * (`data-virtualized`, the viewport height) and assert that selection cannot
 * depend on which rows happen to be mounted.
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
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { Chip } from '@mui/material';
import { render } from '../../../__tests__/utils/test-utils';
import { DataTable } from '../DataTable';
import type { DataTableColumn, DataTableFilterModel } from '../types';
import {
  assertNoInvisibleHitTargets,
  DEFAULT_VISIBLE_CONTROL_SELECTOR,
} from './testUtils/a11yGuards';
import {
  CSV_BOM,
  escapeCsvField,
  isFormulaText,
  neutralizeFormula,
  toCsv,
  toCsvFile,
  toCsvRow,
} from '../export/csv';
import {
  DATA_TABLE_EXPORT_MAX_ROWS,
  ExportCancelledError,
  buildCsvForRows,
  buildExportMatrix,
  collectAllRows,
  exportColumns,
  exportFilename,
  isExportableColumn,
  slugifyExportName,
} from '../export/exportModel';
import {
  GRID_VIRTUALIZATION_ROW_THRESHOLD,
  planGridVirtualization,
  virtualizedViewportHeight,
} from '../virtualization/gridVirtualization';
import {
  CARD_VIRTUALIZATION_MIN_ROWS,
  containIntrinsicSize,
  shouldVirtualizeCards,
} from '../virtualization/cardVirtualization';

// ---------------------------------------------------------------------------
// Layout stubs (the #253 recipe)
// ---------------------------------------------------------------------------

const VIEWPORT_WIDTH = 1440;
const VIEWPORT_HEIGHT = 900;
const CARD_HEIGHT = 220;

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

  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(
    this: HTMLElement,
  ) {
    // A card reports a card-sized height so the measured placeholder is a real
    // measurement rather than the viewport.
    const isCard = this.getAttribute?.('data-testid') === 'datatable-card';
    const height = isCard ? CARD_HEIGHT : VIEWPORT_HEIGHT;
    return {
      width: containerWidth,
      height,
      top: 0,
      left: 0,
      right: containerWidth,
      bottom: height,
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
            contentRect: {
              width: containerWidth,
              // A card measures a card, not the viewport — otherwise the
              // "measured placeholder" assertion would be measuring the stub.
              height:
                target.getAttribute('data-testid') === 'datatable-card'
                  ? CARD_HEIGHT
                  : VIEWPORT_HEIGHT,
            },
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
// Download double
// ---------------------------------------------------------------------------

interface CapturedDownload {
  blob: Blob;
  filename: string;
}

let captured: CapturedDownload[] = [];
let pendingBlobs: Blob[] = [];
let originalCreate: unknown;
let originalRevoke: unknown;

function installDownloadStubs() {
  captured = [];
  pendingBlobs = [];
  const urlObject = URL as unknown as Record<string, unknown>;
  originalCreate = urlObject.createObjectURL;
  originalRevoke = urlObject.revokeObjectURL;

  urlObject.createObjectURL = vi.fn((blob: Blob) => {
    pendingBlobs.push(blob);
    return `blob:datatable-export-${pendingBlobs.length}`;
  });
  urlObject.revokeObjectURL = vi.fn();

  // jsdom would otherwise log "Not implemented: navigation" for the anchor.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
    function click(this: HTMLAnchorElement) {
      const blob = pendingBlobs[pendingBlobs.length - 1];
      captured.push({ blob, filename: this.download });
    },
  );
}

function restoreDownloadStubs() {
  const urlObject = URL as unknown as Record<string, unknown>;
  urlObject.createObjectURL = originalCreate;
  urlObject.revokeObjectURL = originalRevoke;
}

/** The text of the most recent download. */
async function lastDownloadedCsv(): Promise<string> {
  expect(captured.length).toBeGreaterThan(0);
  return captured[captured.length - 1].blob.text();
}

/** The most recent download's rows, BOM stripped, CRLF split. */
async function lastDownloadedRows(): Promise<string[]> {
  const text = await lastDownloadedCsv();
  return text.replace(CSV_BOM, '').split('\r\n').filter(Boolean);
}

beforeEach(() => {
  containerWidth = 1400;
  installDownloadStubs();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  restoreDownloadStubs();
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
  token: string;
}

const JOBS: Job[] = [
  {
    id: 'job-1',
    type: 'face_detection',
    status: 'pending',
    attempts: 1,
    lastError: null,
    token: 'shr_secret_1',
  },
  {
    id: 'job-2',
    type: 'auto_tagging',
    status: 'failed',
    attempts: 3,
    lastError: 'rate limited, "429"',
    token: 'shr_secret_2',
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
    // The whole point of `render` vs `value`: the cell is a chip, the CSV is a
    // word.
    value: (r) => r.status,
    render: (r) => <Chip size="small" label={r.status.toUpperCase()} />,
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
  // Never exportable: this is what #259/#260 will set on share tokens and PAT
  // material.
  {
    id: 'token',
    label: 'Token',
    priority: 'detail',
    value: (r) => r.token,
    exportable: false,
  },
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

/** A page of N synthetic jobs, for the virtualization thresholds. */
function manyJobs(count: number): Job[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `job-${index + 1}`,
    type: `type_${index + 1}`,
    status: index % 2 === 0 ? ('pending' as const) : ('failed' as const),
    attempts: index,
    lastError: null,
    token: `shr_${index}`,
  }));
}

// ===========================================================================
// 1. CSV serialization — the pure rules
// ===========================================================================

describe('CSV serialization — escaping', () => {
  it('leaves a plain field untouched', () => {
    expect(escapeCsvField('face_detection')).toBe('face_detection');
    expect(escapeCsvField(42)).toBe('42');
  });

  it('writes null and undefined as an EMPTY field, not an em dash', () => {
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField(undefined)).toBe('');
  });

  it('quotes a field containing a comma', () => {
    expect(escapeCsvField('San José, Costa Rica')).toBe(
      '"San José, Costa Rica"',
    );
  });

  it('quotes a field containing a double quote, and doubles the quote', () => {
    expect(escapeCsvField('rate limited, "429"')).toBe(
      '"rate limited, ""429"""',
    );
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
  });

  it('quotes a field containing a newline or a carriage return', () => {
    expect(escapeCsvField('line one\nline two')).toBe('"line one\nline two"');
    expect(escapeCsvField('line one\r\nline two')).toBe(
      '"line one\r\nline two"',
    );
  });

  it('quotes leading/trailing whitespace so a parser cannot trim it away', () => {
    expect(escapeCsvField('  padded  ')).toBe('"  padded  "');
  });
});

describe('CSV serialization — formula injection', () => {
  // The four prefixes named in the issue, plus the two whitespace prefixes some
  // spreadsheets strip before deciding whether a cell is a formula.
  it.each([
    ['=', "=cmd|'/c calc'!A1"],
    ['+', '+1+1'],
    ['-', '-2+3+cmd|calc'],
    ['@', '@SUM(A1:A9)'],
    ['tab', '\t=1+1'],
    ['CR', '\r=1+1'],
  ])('neutralizes a %s-prefixed field', (_name, payload) => {
    expect(isFormulaText(payload)).toBe(true);
    expect(neutralizeFormula(payload)).toBe(`'${payload}`);
    expect(escapeCsvField(payload).replace(/^"|"$/g, '')).toMatch(/^'/);
  });

  it('escapes AND quotes a formula that also contains a comma', () => {
    expect(escapeCsvField('=SUM(1,2)')).toBe('"\'=SUM(1,2)"');
  });

  it('does NOT neutralize a negative number, in either representation', () => {
    // A `-` prefix is only dangerous when the cell is not a number. Prefixing
    // `-5` would corrupt every numeric column that can go negative.
    expect(escapeCsvField(-5)).toBe('-5');
    expect(escapeCsvField('-5')).toBe('-5');
    expect(escapeCsvField('+1.5e3')).toBe('+1.5e3');
    expect(isFormulaText('-5')).toBe(false);
  });

  it('still neutralizes a formula that merely starts like a number', () => {
    expect(isFormulaText('-1+cmd|calc')).toBe(true);
    expect(neutralizeFormula('-1+cmd|calc')).toBe("'-1+cmd|calc");
  });

  it('treats an empty string as harmless', () => {
    expect(isFormulaText('')).toBe(false);
    expect(escapeCsvField('')).toBe('');
  });
});

describe('CSV serialization — documents', () => {
  it('joins fields with commas and records with CRLF, ending with a terminator', () => {
    expect(toCsvRow(['a', 'b', 1])).toBe('a,b,1');
    expect(toCsv(['A', 'B'], [['1', '2']])).toBe('A,B\r\n1,2\r\n');
  });

  it('prefixes the FILE (not a field) with the UTF-8 BOM', () => {
    const file = toCsvFile(['Type'], [['José']]);
    expect(file.startsWith(CSV_BOM)).toBe(true);
    expect(file.charCodeAt(0)).toBe(0xfeff);
    // The BOM is a file concern only — the row serializer stays composable.
    expect(toCsv(['Type'], [['José']]).startsWith(CSV_BOM)).toBe(false);
  });

  it('round-trips a header-only export', () => {
    expect(toCsv(['A', 'B'], [])).toBe('A,B\r\n');
  });
});

// ===========================================================================
// 2. Export model — columns, matrix, filename
// ===========================================================================

describe('export model — column selection', () => {
  it('defaults every column to exportable', () => {
    expect(isExportableColumn(COLUMNS[0])).toBe(true);
    expect(isExportableColumn(COLUMNS.find((c) => c.id === 'token')!)).toBe(
      false,
    );
  });

  it('drops `exportable: false` columns', () => {
    expect(exportColumns(COLUMNS).map((c) => c.id)).toEqual([
      'type',
      'status',
      'attempts',
      'lastError',
    ]);
  });

  it('drops columns the user has hidden, and keeps declaration order', () => {
    const visible = new Set(['lastError', 'type', 'token']);
    expect(exportColumns(COLUMNS, visible).map((c) => c.id)).toEqual([
      'type',
      'lastError',
    ]);
  });

  it('treats an omitted visibility set as "nothing is hidden"', () => {
    expect(exportColumns(COLUMNS, undefined)).toHaveLength(4);
  });
});

describe('export model — matrix', () => {
  it('uses the `value` scalar, never the rendered node', () => {
    const { header, body } = buildExportMatrix(exportColumns(COLUMNS), JOBS);
    expect(header).toEqual(['Type', 'Status', 'Attempts', 'Last error']);
    // The cell renders <Chip label="PENDING" />; the CSV carries `pending`.
    expect(body[0]).toEqual(['face_detection', 'pending', 1, null]);
    expect(body[1]).toEqual([
      'auto_tagging',
      'failed',
      3,
      'rate limited, "429"',
    ]);
  });

  it('builds a complete file, BOM and quoting included', () => {
    const csv = buildCsvForRows(COLUMNS, JOBS);
    const rows = csv.replace(CSV_BOM, '').split('\r\n');
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(rows[0]).toBe('Type,Status,Attempts,Last error');
    expect(rows[1]).toBe('face_detection,pending,1,');
    expect(rows[2]).toBe('auto_tagging,failed,3,"rate limited, ""429"""');
    expect(csv).not.toContain('shr_secret');
  });
});

describe('export model — filename', () => {
  it('slugifies a table name and falls back to `export`', () => {
    expect(slugifyExportName('Enrichment jobs')).toBe('enrichment-jobs');
    expect(slugifyExportName('  ')).toBe('export');
    expect(slugifyExportName(undefined)).toBe('export');
  });

  it('dates the file so two snapshots never collide', () => {
    expect(exportFilename('jobs', new Date('2026-08-05T10:00:00Z'))).toBe(
      'jobs-2026-08-05.csv',
    );
  });
});

// ===========================================================================
// 3. collectAllRows — the bounded, cancellable walk
// ===========================================================================

describe('collectAllRows', () => {
  it('walks zero-based pages until a short page ends the set', async () => {
    const seen: number[] = [];
    const fetchPage = vi.fn(
      async ({ page, pageSize }: { page: number; pageSize: number }) => {
        seen.push(page);
        return page < 2 ? manyJobs(pageSize) : manyJobs(3);
      },
    );

    const { rows, capped } = await collectAllRows<Job>({
      fetchPage,
      pageSize: 10,
    });

    expect(seen).toEqual([0, 1, 2]);
    expect(rows).toHaveLength(23);
    expect(capped).toBe(false);
  });

  it('stops at an empty page', async () => {
    const fetchPage = vi.fn(async ({ page }: { page: number }) =>
      page === 0 ? manyJobs(10) : [],
    );
    const { rows } = await collectAllRows<Job>({ fetchPage, pageSize: 10 });
    expect(rows).toHaveLength(10);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('caps the walk at maxRows and reports it', async () => {
    const fetchPage = vi.fn(async ({ pageSize }: { pageSize: number }) =>
      manyJobs(pageSize),
    );
    const { rows, capped } = await collectAllRows<Job>({
      fetchPage,
      pageSize: 10,
      maxRows: 25,
    });
    expect(rows).toHaveLength(25);
    expect(capped).toBe(true);
  });

  it('defaults the ceiling to 10 000 rows', () => {
    expect(DATA_TABLE_EXPORT_MAX_ROWS).toBe(10_000);
  });

  it('reports progress as the running total', async () => {
    const onProgress = vi.fn();
    const fetchPage = vi.fn(
      async ({ page, pageSize }: { page: number; pageSize: number }) =>
        page === 0 ? manyJobs(pageSize) : manyJobs(2),
    );
    await collectAllRows<Job>({ fetchPage, pageSize: 5, onProgress });
    expect(onProgress.mock.calls.map((call) => call[0])).toEqual([5, 7]);
  });

  it('throws ExportCancelledError once the signal aborts', async () => {
    const controller = new AbortController();
    const fetchPage = vi.fn(async ({ pageSize }: { pageSize: number }) => {
      controller.abort();
      return manyJobs(pageSize);
    });

    await expect(
      collectAllRows<Job>({
        fetchPage,
        pageSize: 5,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ExportCancelledError);
  });
});

// ===========================================================================
// 4. The export control — one control, three layouts
// ===========================================================================

describe('DataTable — the export control', () => {
  it('offers a labelled Export button on desktop', () => {
    renderAtWidth(1400);
    const button = screen.getByTestId('datatable-export-button');
    expect(button).toHaveAccessibleName('Export CSV');
    // The visible word is inside the accessible name (WCAG 2.5.3).
    expect(button).toHaveTextContent('Export');
  });

  it('offers the same button on a tablet', () => {
    renderAtWidth(800);
    expect(screen.getByTestId('datatable-export-button')).toBeInTheDocument();
  });

  it('collapses into an overflow menu on a phone', () => {
    renderAtWidth(400);
    expect(
      screen.queryByTestId('datatable-export-button'),
    ).not.toBeInTheDocument();

    const overflow = screen.getByTestId('datatable-overflow-button');
    expect(overflow).toHaveAccessibleName('Table actions');

    fireEvent.click(overflow);
    expect(
      screen.getByTestId('datatable-export-current-page'),
    ).toBeInTheDocument();
  });

  it('is removed entirely by disableExport', () => {
    renderAtWidth(1400, { disableExport: true });
    expect(
      screen.queryByTestId('datatable-export-button'),
    ).not.toBeInTheDocument();
    // …and the rest of the view bar is untouched.
    expect(screen.getByTestId('datatable-columns-button')).toBeInTheDocument();
  });

  it('is removed on a phone too', () => {
    renderAtWidth(400, { disableExport: true });
    expect(
      screen.queryByTestId('datatable-overflow-button'),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('datatable-view-button')).toBeInTheDocument();
  });

  it('disables itself when there is nothing to export', () => {
    // Zero rows because a FILTER matched nothing — the one empty case where the
    // view bar (and so this button) is still drawn, since the user is mid-query
    // and the controls must not move under them (#438). A plain empty table
    // hides the bar outright; that rule is asserted in `DataTable.test.tsx`.
    renderAtWidth(1400, {
      rows: [],
      filters: [{ columnId: 'status', operator: 'is', value: 'failed' }],
      onFiltersChange: vi.fn(),
    });
    expect(screen.getByTestId('datatable-export-button')).toBeDisabled();
  });

  it('exports without a menu when no all-rows callback is supplied', () => {
    renderAtWidth(1400);
    fireEvent.click(screen.getByTestId('datatable-export-button'));
    // One click, one file — a one-item menu would be a click nobody needs.
    expect(captured).toHaveLength(1);
    expect(
      screen.queryByTestId('datatable-export-menu'),
    ).not.toBeInTheDocument();
  });
});

// ===========================================================================
// 5. Current-page export — what actually lands in the file
// ===========================================================================

describe('DataTable — current-page export', () => {
  it('downloads a dated .csv of the loaded rows, BOM first', async () => {
    renderAtWidth(1400, { tableId: 'jobs' });
    fireEvent.click(screen.getByTestId('datatable-export-button'));

    // `Blob.text()` decodes UTF-8, and a UTF-8 decode STRIPS a leading BOM —
    // so the only honest place to assert it is the bytes themselves.
    const bytes = new Uint8Array(await captured[0].blob.arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(captured[0].blob.type).toBe('text/csv;charset=utf-8;');
    expect(captured[0].filename).toMatch(/^jobs-\d{4}-\d{2}-\d{2}\.csv$/);

    const rows = await lastDownloadedRows();
    expect(rows[0]).toBe('Type,Status,Attempts,Last error');
    expect(rows).toHaveLength(3);
  });

  it('exports the scalar behind a rendered chip, never the node', async () => {
    renderAtWidth(1400);
    // The cell really is a chip on screen…
    expect(screen.getAllByText('PENDING').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId('datatable-export-button'));
    const rows = await lastDownloadedRows();

    // …and the file really does carry the scalar.
    expect(rows[1]).toContain('pending');
    expect(rows[1]).not.toContain('PENDING');
    expect(rows.join('\n')).not.toContain('[object Object]');
  });

  it('never writes an `exportable: false` column', async () => {
    renderAtWidth(1400);
    fireEvent.click(screen.getByTestId('datatable-export-button'));
    const text = await lastDownloadedCsv();

    expect(text).not.toContain('Token');
    expect(text).not.toContain('shr_secret_1');
  });

  it('respects the user’s column visibility choice', async () => {
    renderAtWidth(1400);

    fireEvent.click(screen.getByTestId('datatable-columns-button'));
    fireEvent.click(screen.getByTestId('datatable-column-toggle-attempts'));
    // The menu is modal; close it before touching the bar underneath.
    fireEvent.keyDown(screen.getByTestId('datatable-columns-menu'), {
      key: 'Escape',
    });

    fireEvent.click(screen.getByTestId('datatable-export-button'));
    const rows = await lastDownloadedRows();

    expect(rows[0]).toBe('Type,Status,Last error');
    expect(rows[1]).not.toMatch(/(^|,)1(,|$)/);
  });

  it('exports the rows the server returned for the ACTIVE filters', async () => {
    // The table never filters `rows` (§10.1), so "respects the filters" means
    // exactly this: the file is the filtered page the page handed us, and
    // nothing else.
    const filters: DataTableFilterModel = [
      { columnId: 'status', operator: 'is', value: 'failed' },
    ];
    const filtered = JOBS.filter((job) => job.status === 'failed');

    renderAtWidth(1400, { rows: filtered, filters, onFiltersChange: vi.fn() });
    fireEvent.click(screen.getByTestId('datatable-export-button'));

    const rows = await lastDownloadedRows();
    expect(rows).toHaveLength(2); // header + the one matching row
    expect(rows[1]).toContain('auto_tagging');
    expect(rows.join('\n')).not.toContain('face_detection');
  });

  it('exports the same file from the phone overflow menu', async () => {
    renderAtWidth(400);
    fireEvent.click(screen.getByTestId('datatable-overflow-button'));
    fireEvent.click(screen.getByTestId('datatable-export-current-page'));

    const rows = await lastDownloadedRows();
    expect(rows[0]).toBe('Type,Status,Attempts,Last error');
    expect(rows).toHaveLength(3);
  });

  it('names the file from an explicit csvExport.filename', async () => {
    renderAtWidth(1400, { csvExport: { filename: 'Admin Shares' } });
    fireEvent.click(screen.getByTestId('datatable-export-button'));
    expect(captured[0].filename).toMatch(
      /^admin-shares-\d{4}-\d{2}-\d{2}\.csv$/,
    );
  });
});

// ===========================================================================
// 6. All-rows export — the page's own query, replayed
// ===========================================================================

describe('DataTable — all matching rows export', () => {
  it('offers the option only when a fetch callback is supplied', () => {
    renderAtWidth(1400);
    fireEvent.click(screen.getByTestId('datatable-export-button'));
    expect(
      screen.queryByTestId('datatable-export-all-rows'),
    ).not.toBeInTheDocument();
  });

  it('replays the page’s callback page by page and exports everything', async () => {
    const fetchAllRows = vi.fn(
      async ({ page, pageSize }: { page: number; pageSize: number }) =>
        page === 0 ? manyJobs(pageSize) : manyJobs(4),
    );

    renderAtWidth(1400, { csvExport: { fetchAllRows, fetchPageSize: 10 } });
    fireEvent.click(screen.getByTestId('datatable-export-button'));
    fireEvent.click(screen.getByTestId('datatable-export-all-rows'));

    await waitFor(() => expect(captured).toHaveLength(1));

    expect(fetchAllRows.mock.calls.map((call) => call[0].page)).toEqual([0, 1]);
    const rows = await lastDownloadedRows();
    expect(rows).toHaveLength(15); // header + 14 rows
  });

  it('stops at the row ceiling and says so instead of silently truncating', async () => {
    const fetchAllRows = vi.fn(async ({ pageSize }: { pageSize: number }) =>
      manyJobs(pageSize),
    );

    renderAtWidth(1400, {
      csvExport: { fetchAllRows, fetchPageSize: 10, maxRows: 25 },
    });
    fireEvent.click(screen.getByTestId('datatable-export-button'));
    fireEvent.click(screen.getByTestId('datatable-export-all-rows'));

    await waitFor(() => expect(captured).toHaveLength(1));
    const rows = await lastDownloadedRows();
    expect(rows).toHaveLength(26);

    const notice = await screen.findByTestId('datatable-export-capped');
    expect(notice).toHaveTextContent(/25-row limit/);
  });

  it('surfaces a failed fetch instead of downloading a partial file', async () => {
    const fetchAllRows = vi.fn(async () => {
      throw new Error('502 Bad Gateway');
    });

    renderAtWidth(1400, { csvExport: { fetchAllRows } });
    fireEvent.click(screen.getByTestId('datatable-export-button'));
    fireEvent.click(screen.getByTestId('datatable-export-all-rows'));

    const error = await screen.findByTestId('datatable-export-error');
    expect(error).toHaveTextContent('502 Bad Gateway');
    expect(captured).toHaveLength(0);
  });

  it('shows progress and can be cancelled mid-walk', async () => {
    let release: (() => void) | null = null;
    const fetchAllRows = vi.fn(
      async ({ page, pageSize }: { page: number; pageSize: number }) => {
        if (page === 0) return manyJobs(pageSize);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return manyJobs(pageSize);
      },
    );

    renderAtWidth(1400, {
      csvExport: { fetchAllRows, fetchPageSize: 10 },
      pagination: {
        page: 0,
        pageSize: 25,
        total: 400,
        onPaginationChange: vi.fn(),
      },
    });
    fireEvent.click(screen.getByTestId('datatable-export-button'));
    fireEvent.click(screen.getByTestId('datatable-export-all-rows'));

    const dialog = await screen.findByTestId('datatable-export-progress');
    await waitFor(() =>
      expect(
        screen.getByTestId('datatable-export-progress-text'),
      ).toHaveTextContent('10 rows'),
    );

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await act(async () => {
      release?.();
    });

    await waitFor(() =>
      expect(
        screen.queryByTestId('datatable-export-progress'),
      ).not.toBeInTheDocument(),
    );
    // A cancelled export produces no file.
    expect(captured).toHaveLength(0);
  });
});

// ===========================================================================
// 7. Grid virtualization
// ===========================================================================

describe('grid virtualization — the plan (pure)', () => {
  it('keeps auto-height for an ordinary page', () => {
    expect(
      planGridVirtualization({ rowCount: 25, density: 'standard' }),
    ).toEqual({
      virtualized: false,
      autoHeight: true,
      height: undefined,
    });
  });

  it('trades auto-height for a bounded viewport past the threshold', () => {
    const plan = planGridVirtualization({
      rowCount: GRID_VIRTUALIZATION_ROW_THRESHOLD + 1,
      density: 'standard',
    });
    expect(plan.virtualized).toBe(true);
    // autoHeight is what MUI X checks: `enabledForRows: … && !autoHeight`.
    expect(plan.autoHeight).toBe(false);
    expect(plan.height).toBe(virtualizedViewportHeight('standard', 51));
  });

  it('does not fire exactly AT the threshold', () => {
    expect(
      planGridVirtualization({
        rowCount: GRID_VIRTUALIZATION_ROW_THRESHOLD,
        density: 'standard',
      }).virtualized,
    ).toBe(false);
  });

  it('honours an explicit height at any row count', () => {
    expect(
      planGridVirtualization({ rowCount: 3, height: 400, density: 'standard' }),
    ).toEqual({
      virtualized: true,
      autoHeight: false,
      height: 400,
    });
  });

  it('scales the viewport with density', () => {
    expect(virtualizedViewportHeight('compact', 100)).toBeLessThan(
      virtualizedViewportHeight('comfortable', 100),
    );
    // Never taller than the rows it has.
    expect(virtualizedViewportHeight('standard', 2)).toBeLessThan(
      virtualizedViewportHeight('standard', 12),
    );
  });
});

describe('DataTable — grid virtualization, rendered', () => {
  const bigPage = manyJobs(60);

  it('does not virtualize an ordinary page', () => {
    renderAtWidth(1400, {
      pagination: {
        page: 0,
        pageSize: 25,
        total: 2,
        onPaginationChange: vi.fn(),
      },
    });
    const scroller = screen.getByTestId('datatable-scroll-container');
    expect(scroller).toHaveAttribute('data-virtualized', 'false');
    // Auto-height: the table grows with its rows and the PAGE scrolls (§5).
    expect(getComputedStyle(scroller).height).not.toMatch(/px$/);
  });

  it('virtualizes a large page and bounds the viewport', () => {
    renderAtWidth(1400, {
      rows: bigPage,
      pagination: {
        page: 0,
        pageSize: 100,
        total: 600,
        onPaginationChange: vi.fn(),
      },
    });
    const scroller = screen.getByTestId('datatable-scroll-container');
    expect(scroller).toHaveAttribute('data-virtualized', 'true');
    expect(getComputedStyle(scroller).height).toBe(
      `${virtualizedViewportHeight('standard', 60)}px`,
    );
  });

  it('keeps select-all correct with virtualization enabled', () => {
    const onSelectionChange = vi.fn();
    renderAtWidth(1400, {
      rows: bigPage,
      pagination: {
        page: 0,
        pageSize: 100,
        total: 600,
        onPaginationChange: vi.fn(),
      },
      selection: { selectedIds: new Set<string>(), onSelectionChange },
    });

    expect(screen.getByTestId('datatable-scroll-container')).toHaveAttribute(
      'data-virtualized',
      'true',
    );

    fireEvent.click(screen.getByRole('checkbox', { name: /select all rows/i }));

    const emitted = onSelectionChange.mock.calls[0][0] as Set<string>;
    // Selection is materialised from the ROW SET, not from the mounted DOM —
    // which is exactly why windowing cannot break it.
    expect(emitted.size).toBe(60);
    expect(emitted.has('job-1')).toBe(true);
    expect(emitted.has('job-60')).toBe(true);
  });

  it('keeps synthetic tablet detail rows unselectable while virtualized', () => {
    const onSelectionChange = vi.fn();
    renderAtWidth(800, {
      rows: bigPage,
      pagination: {
        page: 0,
        pageSize: 100,
        total: 600,
        onPaginationChange: vi.fn(),
      },
      selection: { selectedIds: new Set<string>(), onSelectionChange },
    });

    // Expand a row: a synthetic detail row joins `rows`, so the count the
    // virtualization plan sees includes it.
    fireEvent.click(screen.getAllByTestId('datatable-row-expander')[0]);
    expect(screen.getByTestId('datatable-scroll-container')).toHaveAttribute(
      'data-virtualized',
      'true',
    );

    fireEvent.click(screen.getByRole('checkbox', { name: /select all rows/i }));
    const emitted = onSelectionChange.mock.calls[0][0] as Set<string>;
    expect(emitted.size).toBe(60);
    expect(
      Array.from(emitted).some((id) => id.startsWith('__datatable_detail__')),
    ).toBe(false);
  });

  it('still exports every loaded row when the grid is virtualized', async () => {
    renderAtWidth(1400, {
      rows: bigPage,
      pagination: {
        page: 0,
        pageSize: 100,
        total: 600,
        onPaginationChange: vi.fn(),
      },
    });
    fireEvent.click(screen.getByTestId('datatable-export-button'));

    const rows = await lastDownloadedRows();
    // The export reads the row array, not the mounted rows.
    expect(rows).toHaveLength(61);
  });
});

// ===========================================================================
// 8. Card list — render skipping (NOT a virtualizer)
// ===========================================================================

describe('card render-skipping helpers (pure)', () => {
  it('kicks in only for a list long enough to be worth it', () => {
    expect(shouldVirtualizeCards(CARD_VIRTUALIZATION_MIN_ROWS - 1)).toBe(false);
    expect(shouldVirtualizeCards(CARD_VIRTUALIZATION_MIN_ROWS)).toBe(true);
  });

  it('emits `auto <length>` so the browser prefers its own remembered size', () => {
    expect(containIntrinsicSize(220)).toBe('auto 220px');
    // A missing measurement falls back rather than emitting `auto 0px`.
    expect(containIntrinsicSize(null)).toMatch(/^auto \d+px$/);
    expect(containIntrinsicSize(0)).toBe('auto 1px');
  });
});

describe('DataTable — card list render skipping, rendered', () => {
  it('leaves a short list alone', () => {
    renderAtWidth(400, { rows: manyJobs(5) });
    for (const card of screen.getAllByTestId('datatable-card')) {
      expect(card).toHaveAttribute('data-skip-offscreen', 'false');
    }
  });

  it('skips off-screen cards past the threshold, except the measured one', () => {
    renderAtWidth(400, { rows: manyJobs(25) });
    const cards = screen.getAllByTestId('datatable-card');

    expect(cards[0]).toHaveAttribute('data-skip-offscreen', 'false');
    expect(cards[1]).toHaveAttribute('data-skip-offscreen', 'true');
    expect(cards[cards.length - 1]).toHaveAttribute(
      'data-skip-offscreen',
      'true',
    );
  });

  it('uses a MEASURED placeholder height, not a computed guess', async () => {
    renderAtWidth(400, { rows: manyJobs(25) });
    await waitFor(() => {
      const card = screen.getAllByTestId('datatable-card')[1];
      // CARD_HEIGHT is what a real card in this list measures.
      expect(card).toHaveAttribute(
        'data-intrinsic-height',
        `auto ${CARD_HEIGHT}px`,
      );
    });
  });

  it('stops skipping a card while its detail region is open', () => {
    renderAtWidth(400, { rows: manyJobs(25) });
    const toggles = screen.getAllByTestId('datatable-card-detail-toggle');

    expect(screen.getAllByTestId('datatable-card')[1]).toHaveAttribute(
      'data-skip-offscreen',
      'true',
    );
    fireEvent.click(toggles[1]);
    // A card whose height is changing under the user's finger stays rendered —
    // this is the issue #237 failure mode, avoided rather than estimated.
    expect(screen.getAllByTestId('datatable-card')[1]).toHaveAttribute(
      'data-skip-offscreen',
      'false',
    );
  });

  it('marks images produced by a column render as lazy', async () => {
    const withThumb: DataTableColumn<Job>[] = [
      ...COLUMNS,
      {
        id: 'thumb',
        label: 'Preview',
        priority: 'secondary',
        value: (r) => r.id,
        render: (r) => (
          <img src={`/thumb/${r.id}.jpg`} alt={`Preview of ${r.type}`} />
        ),
      },
    ];

    renderAtWidth(400, { rows: manyJobs(25), columns: withThumb });

    await waitFor(() => {
      const images = document.querySelectorAll('img[src^="/thumb/"]');
      expect(images.length).toBeGreaterThan(0);
      for (const image of Array.from(images)) {
        expect(image.getAttribute('loading')).toBe('lazy');
        expect(image.getAttribute('decoding')).toBe('async');
      }
    });
  });

  it('never overrides an explicit loading attribute', async () => {
    const eager: DataTableColumn<Job>[] = [
      ...COLUMNS,
      {
        id: 'thumb',
        label: 'Preview',
        priority: 'secondary',
        value: (r) => r.id,
        render: (r) => (
          <img src={`/hero/${r.id}.jpg`} alt="Hero" loading="eager" />
        ),
      },
    ];

    renderAtWidth(400, { rows: manyJobs(25), columns: eager });
    await waitFor(() =>
      expect(
        document.querySelector('img[src^="/hero/"]')?.getAttribute('loading'),
      ).toBe('eager'),
    );
  });
});

// ===========================================================================
// 9. Touch-target rule / issue #243 regression guard, extended to export
// ===========================================================================

// `assertNoInvisibleHitTargets` is imported from `./testUtils/a11yGuards`
// (issue #257 consolidated the four near-identical copies of this guard into
// one shared module). `[role="menuitem"]` is this suite's addition to the
// #253/#255 sweep: the export menu's controls are menu items, not buttons or
// checkboxes.
const EXPORT_MENU_SELECTOR = `${DEFAULT_VISIBLE_CONTROL_SELECTOR}, [role="menuitem"]`;

describe('DataTable — export controls obey the touch rules (issue #243 guard)', () => {
  it('holds for the desktop export button and its menu', () => {
    renderAtWidth(1400, { csvExport: { fetchAllRows: vi.fn(async () => []) } });
    fireEvent.click(screen.getByTestId('datatable-export-button'));

    assertNoInvisibleHitTargets(screen.getByTestId('datatable-export-menu'), {
      selector: EXPORT_MENU_SELECTOR,
    });
    assertNoInvisibleHitTargets(screen.getByTestId('datatable-view-bar'), {
      selector: EXPORT_MENU_SELECTOR,
    });
  });

  it('holds for the phone overflow menu', () => {
    renderAtWidth(400);
    fireEvent.click(screen.getByTestId('datatable-overflow-button'));
    assertNoInvisibleHitTargets(screen.getByTestId('datatable-export-menu'), {
      selector: EXPORT_MENU_SELECTOR,
    });
  });

  it('gives the export control a >=44px touch target in every layout', () => {
    renderAtWidth(1400, { csvExport: { fetchAllRows: vi.fn(async () => []) } });
    expect(
      Number.parseFloat(
        getComputedStyle(screen.getByTestId('datatable-export-button'))
          .minHeight || '0',
      ),
    ).toBeGreaterThanOrEqual(44);

    fireEvent.click(screen.getByTestId('datatable-export-button'));
    for (const item of [
      screen.getByTestId('datatable-export-current-page'),
      screen.getByTestId('datatable-export-all-rows'),
    ]) {
      expect(
        Number.parseFloat(getComputedStyle(item).minHeight || '0'),
      ).toBeGreaterThanOrEqual(44);
    }
  });

  it('gives the phone overflow button a >=44px touch target', () => {
    renderAtWidth(400);
    const button = screen.getByTestId('datatable-overflow-button');
    expect(
      Number.parseFloat(getComputedStyle(button).minHeight || '0'),
    ).toBeGreaterThanOrEqual(44);
  });

  it('keeps the view bar inside horizontal containment with export present', () => {
    renderAtWidth(360);
    const bar = screen.getByTestId('datatable-view-bar');
    expect(getComputedStyle(bar).maxWidth).toBe('100%');
    expect(getComputedStyle(bar).minWidth).toBe('0px');
    expect(getComputedStyle(bar).flexWrap).toBe('wrap');
    expect(document.body.style.width).toBe('');
  });
});
