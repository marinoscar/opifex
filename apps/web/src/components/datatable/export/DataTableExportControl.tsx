/**
 * DataTable — the CSV export control (issue #256, epic #238).
 *
 * Lives in the view bar next to the column picker and the density toggle, for
 * the same reason those do (§7.4): its SHAPE is decided by the layout, not by
 * how rows are presented.
 *
 * | layout    | surface                                                        |
 * | --------- | -------------------------------------------------------------- |
 * | `desktop` | an "Export" button — a menu when an all-rows fetch is supplied  |
 * | `tablet`  | identical                                                       |
 * | `mobile`  | a `MoreVert` **overflow menu** ("Table actions")                |
 *
 * The phone gets an overflow menu rather than a third button because the view
 * bar there already holds "View" and the filter surface's "Filters"; a fourth
 * labelled control at 360px is what pushes a row into a horizontal scroller.
 *
 * ## Two scopes, one of them optional
 *
 * - **Current page** — always available. Serializes the rows the table was
 *   handed, which are already filtered/sorted/paginated by the server.
 * - **All matching rows** — only when the page supplies `fetchAllRows`. The
 *   component cannot know the endpoint, so it replays the page's OWN callback
 *   with the page's OWN active filters, bounded at
 *   {@link DATA_TABLE_EXPORT_MAX_ROWS} and cancellable.
 *
 * Neither scope ever re-queries with elevated access: the second one is the
 * first one's fetch, run more times.
 *
 * Touch rules (§8.5) apply as everywhere else: ≥44px, nothing hover-revealed,
 * and the menu/dialog are mounted only while open.
 */

import { useCallback, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  LinearProgress,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Tooltip,
} from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import TableRowsIcon from '@mui/icons-material/TableRows';
import StorageIcon from '@mui/icons-material/Storage';
import type { DataTableColumn, DataTableExportConfig, DataTableLayout } from '../types';
import {
  DATA_TABLE_EXPORT_MAX_ROWS,
  ExportCancelledError,
  buildCsvForRows,
  collectAllRows,
  downloadCsv,
  exportFilename,
} from './exportModel';

/** Every control here clears the 44px touch floor. */
const TOUCH_TARGET = { minWidth: 44, minHeight: 44 } as const;

type ExportPhase = 'running' | 'done' | 'error' | 'cancelled';

interface ExportProgress {
  phase: ExportPhase;
  fetched: number;
  capped: boolean;
  error?: string;
}

export interface DataTableExportControlProps<Row> {
  layout: DataTableLayout;
  columns: DataTableColumn<Row>[];
  /** The currently loaded page of rows. */
  rows: Row[];
  /** The user's resolved column visibility (#255), layout-independent. */
  visibleColumnIds?: ReadonlySet<string>;
  config?: DataTableExportConfig<Row>;
  /** Seed for the download filename — the page's `tableId` or `ariaLabel`. */
  filenameBase?: string;
  /** Total matching rows, when the page knows it. Drives the progress bar. */
  total?: number;
}

export function DataTableExportControl<Row>({
  layout,
  columns,
  rows,
  visibleColumnIds,
  config,
  filenameBase,
  total,
}: DataTableExportControlProps<Row>) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchAllRows = config?.fetchAllRows;
  const maxRows = config?.maxRows ?? DATA_TABLE_EXPORT_MAX_ROWS;
  const fetchPageSize = config?.fetchPageSize;
  const nameSeed = config?.filename ?? filenameBase;
  const filename = useCallback(() => exportFilename(nameSeed), [nameSeed]);

  const nothingToExport = rows.length === 0 && !fetchAllRows;
  const closeMenu = () => setAnchorEl(null);

  const exportCurrentPage = useCallback(() => {
    closeMenu();
    downloadCsv(buildCsvForRows(columns, rows, visibleColumnIds), filename());
  }, [columns, rows, visibleColumnIds, filename]);

  const exportAllRows = useCallback(async () => {
    closeMenu();
    if (!fetchAllRows) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setProgress({ phase: 'running', fetched: 0, capped: false });

    try {
      const { rows: all, capped } = await collectAllRows<Row>({
        fetchPage: fetchAllRows,
        pageSize: fetchPageSize,
        maxRows,
        signal: controller.signal,
        onProgress: (fetched) =>
          setProgress((current) =>
            current?.phase === 'running' ? { ...current, fetched } : current,
          ),
      });

      downloadCsv(buildCsvForRows(columns, all, visibleColumnIds), filename());

      // A clean, complete export needs no acknowledgement — the file is the
      // feedback. A capped one does: the user must know the CSV is a prefix.
      if (capped) setProgress({ phase: 'done', fetched: all.length, capped: true });
      else setProgress(null);
    } catch (error) {
      if (error instanceof ExportCancelledError || controller.signal.aborted) {
        setProgress(null);
        return;
      }
      setProgress({
        phase: 'error',
        fetched: 0,
        capped: false,
        error: error instanceof Error ? error.message : 'Export failed',
      });
    } finally {
      abortRef.current = null;
    }
  }, [fetchAllRows, columns, visibleColumnIds, maxRows, fetchPageSize, filename]);

  const cancelExport = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setProgress(null);
  };

  // With no all-rows callback there is exactly one thing to do, so the desktop
  // button does it directly — a one-item menu is a click nobody needs.
  const directExport = !fetchAllRows && layout !== 'mobile';

  const trigger =
    layout === 'mobile' ? (
      <Tooltip title="Table actions">
        <span>
          <IconButton
            size="small"
            onClick={(event) => setAnchorEl(event.currentTarget)}
            aria-haspopup="menu"
            aria-expanded={Boolean(anchorEl)}
            aria-label="Table actions"
            data-testid="datatable-overflow-button"
            disabled={nothingToExport}
            sx={TOUCH_TARGET}
          >
            <MoreVertIcon />
          </IconButton>
        </span>
      </Tooltip>
    ) : (
      <Button
        variant="outlined"
        size="small"
        startIcon={<DownloadIcon />}
        onClick={(event) => (directExport ? exportCurrentPage() : setAnchorEl(event.currentTarget))}
        {...(directExport
          ? {}
          : { 'aria-haspopup': 'menu' as const, 'aria-expanded': Boolean(anchorEl) })}
        aria-label="Export CSV"
        data-testid="datatable-export-button"
        disabled={nothingToExport}
        sx={{ minHeight: 44, flex: '0 0 auto' }}
      >
        Export
      </Button>
    );

  return (
    <>
      {trigger}

      {!directExport && (
        <Menu
          anchorEl={anchorEl}
          open={Boolean(anchorEl)}
          onClose={closeMenu}
          slotProps={{ list: { 'aria-label': 'Export options' } }}
          data-testid="datatable-export-menu"
        >
          <MenuItem
            onClick={exportCurrentPage}
            disabled={rows.length === 0}
            data-testid="datatable-export-current-page"
            sx={{ minHeight: 44 }}
          >
            <ListItemIcon sx={{ minWidth: 36 }}>
              <TableRowsIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText
              primary="Export current page (CSV)"
              secondary={`${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`}
            />
          </MenuItem>

          {fetchAllRows && (
            <MenuItem
              onClick={exportAllRows}
              data-testid="datatable-export-all-rows"
              sx={{ minHeight: 44 }}
            >
              <ListItemIcon sx={{ minWidth: 36 }}>
                <StorageIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText
                primary="Export all matching rows (CSV)"
                secondary={`up to ${maxRows.toLocaleString()} rows`}
              />
            </MenuItem>
          )}
        </Menu>
      )}

      {/* Progress / outcome. Only ever opened by the all-rows path: a
          current-page export is synchronous and needs no dialog. */}
      <Dialog
        open={progress !== null}
        onClose={progress?.phase === 'running' ? undefined : () => setProgress(null)}
        aria-labelledby="datatable-export-progress-title"
        data-testid="datatable-export-progress"
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle id="datatable-export-progress-title">
          {progress?.phase === 'error' ? 'Export failed' : 'Exporting…'}
        </DialogTitle>
        <DialogContent>
          {progress?.phase === 'running' && (
            <>
              <DialogContentText data-testid="datatable-export-progress-text">
                {progress.fetched.toLocaleString()} rows fetched
                {total ? ` of ${Math.min(total, maxRows).toLocaleString()}` : ''}…
              </DialogContentText>
              <LinearProgress
                sx={{ mt: 2 }}
                // Determinate only when the page told us the total; a fake
                // percentage that jumps backwards is worse than a spinner.
                {...(total
                  ? {
                      variant: 'determinate' as const,
                      value: Math.min(
                        100,
                        Math.round((progress.fetched / Math.max(1, Math.min(total, maxRows))) * 100),
                      ),
                    }
                  : { variant: 'indeterminate' as const })}
                aria-label="Export progress"
              />
            </>
          )}

          {progress?.phase === 'done' && progress.capped && (
            <Alert severity="warning" data-testid="datatable-export-capped">
              This export stopped at the {maxRows.toLocaleString()}-row limit. The file contains the
              first {progress.fetched.toLocaleString()} matching rows — narrow the filters to export
              the rest.
            </Alert>
          )}

          {progress?.phase === 'error' && (
            <Alert severity="error" data-testid="datatable-export-error">
              {progress.error}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          {progress?.phase === 'running' ? (
            <Button onClick={cancelExport} sx={{ minHeight: 44 }}>
              Cancel
            </Button>
          ) : (
            <Button onClick={() => setProgress(null)} sx={{ minHeight: 44 }}>
              Close
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </>
  );
}
