/**
 * DataTable — per-user layout persistence (issue #255, epic #238).
 *
 * Reads and writes ONE entry of `user_settings.dataTables`, through the
 * existing `GET` / `PATCH /api/user-settings` endpoints. There is no new
 * endpoint, no new client layer and no new permission — see
 * docs/specs/datatable.md §14.
 *
 * ## Write discipline: debounced, fire-and-forget, in-session authoritative
 *
 * Three properties, and all three exist for the same reason — a layout
 * preference is UI state that happens to be backed up, not domain data being
 * submitted:
 *
 * - **In-session state is authoritative; the server copy is a cache.** The
 *   layout the user sees comes from React state and is applied the instant they
 *   click. The network is told afterwards, and is never consulted again for the
 *   life of the mount. Nothing here ever calls `setState` from a response.
 * - **Fire-and-forget.** A rejected write is logged and dropped. A user who
 *   unchecks a column while offline must still get an unchecked column; making
 *   the checkbox depend on a round trip would trade a working control for a
 *   spinner and, on failure, a control that snaps back for no visible reason.
 * - **Debounced.** Flipping four checkboxes is one intent, so it is one
 *   request. The debounce is on the WRITE, never on the state update.
 *
 * ## Entry-replace PATCH semantics
 *
 * `PATCH /api/user-settings` merges `dataTables` per table id but replaces each
 * ENTRY wholesale (§14.5) — a patch of `{ jobs: { pageSize: 100 } }` drops that
 * entry's stored density and column list. So every write here sends the FULL
 * in-session entry rather than a delta. That is cheap precisely because the
 * hook already holds the complete resolved layout in state; it is also the only
 * way "reset this field" stays expressible.
 *
 * "Reset to defaults" is the merge-patch delete, `{ [tableId]: null }`, which
 * removes the entry entirely and frees its slot against the 40-table cap —
 * rather than storing `{}`, which would be a second way to spell "absent".
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api } from '../../../services/api';
import type { UserSettings, UserSettingsUpdate } from '../../../types';
import type {
  DataTableColumn,
  DataTableDensity,
  DataTableLayout,
  DataTablePaginationConfig,
  DataTableSortConfig,
} from '../types';
import {
  DATA_TABLE_PERSIST_DEBOUNCE_MS,
  encodeVisibility,
  isEmptyStoredLayout,
  resolveStoredSort,
  resolveUserVisibleColumnIds,
  resolveVisibleColumnIds,
  sanitizeStoredLayout,
  type DataTableStoredLayout,
  type DataTableStoredSort,
} from './layoutModel';

/**
 * The read is typed with the shared `UserSettings` (the same type
 * `hooks/useUserSettings.ts` reads this endpoint as) rather than a local
 * re-declaration of the `dataTables` slice, so the two consumers of
 * `GET /api/user-settings` cannot drift.
 *
 * That type is optimistic about the wire, which is fine precisely because
 * nothing here trusts it: the entry goes straight through
 * `sanitizeStoredLayout()`, which takes `unknown` and narrows defensively —
 * the blob is user-writable JSON that an older build or a hand-edited settings
 * row can put anything in.
 */
type UserSettingsRead = Pick<UserSettings, 'dataTables'>;

export interface UseDataTableLayoutPrefsOptions<Row> {
  /** Persistence key. Omit (or leave undefined) to keep everything in-session. */
  tableId?: string;
  columns: DataTableColumn<Row>[];
  /** The resolved layout, so `detail` folding composes with the user's choice. */
  layout: DataTableLayout;
  /** The page's default density — a floor the user's choice overrides. */
  densityProp?: DataTableDensity;
  /** Controlled sort, so a stored sort can be restored into the page's state. */
  sort?: DataTableSortConfig;
  /** Controlled pagination, likewise for a stored page size. */
  pagination?: DataTablePaginationConfig;
}

export interface DataTableLayoutPrefs {
  /** Effective density: the user's choice, else the page's, else `standard`. */
  density: DataTableDensity;
  /** Column ids this layout draws right now (baseline ∩ user choice). */
  visibleColumnIds: ReadonlySet<string>;
  /** The user's choice alone, ignoring layout folding — what the picker shows. */
  userVisibleColumnIds: ReadonlySet<string>;
  /** `true` once a stored entry has been read (or persistence is off). */
  hydrated: boolean;
  /** `true` when anything differs from the contract defaults. */
  customized: boolean;
  setDensity: (density: DataTableDensity) => void;
  /** Show/hide one column. Pinned (`hideable: false`) columns are ignored. */
  toggleColumn: (columnId: string, visible: boolean) => void;
  /** Drop every stored preference for this table and delete the server entry. */
  reset: () => void;
}

export function useDataTableLayoutPrefs<Row>({
  tableId,
  columns,
  layout,
  densityProp,
  sort,
  pagination,
}: UseDataTableLayoutPrefsOptions<Row>): DataTableLayoutPrefs {
  // The one piece of authoritative state. Everything below either derives from
  // it or pushes it at the network.
  const [entry, setEntry] = useState<DataTableStoredLayout>({});
  const [hydrated, setHydrated] = useState(!tableId);

  // Mirrors `entry` for the reads that happen outside render — the debounce
  // timer, the unmount flush, and the async tail of the hydration GET. It is
  // written by hand at every `setEntry` call site below rather than during
  // render, which the React Compiler forbids: a render React discards would
  // still have published its value to everything holding the ref.
  const entryRef = useRef(entry);

  // Set as soon as the user touches a control, so a slow GET that lands
  // afterwards can never overwrite a choice already on screen.
  const touchedRef = useRef(false);
  const mountedRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Read through refs: the controlled configs are recreated inline by most
  // pages, and a restore effect that re-ran on every parent render would fight
  // the page for its own state.
  const columnsRef = useRef(columns);
  const sortRef = useRef(sort);
  const paginationRef = useRef(pagination);

  // Synced on COMMIT, not during render. `useLayoutEffect` with no dependency
  // array runs after every commit and before every passive effect of that same
  // commit, so each read site below still sees the current render's props —
  // while a render that React throws away (a transition, a Suspense retry) no
  // longer leaks its props into the tree that stayed on screen.
  useLayoutEffect(() => {
    columnsRef.current = columns;
    sortRef.current = sort;
    paginationRef.current = pagination;
  });

  /**
   * The sort / page size this table is considered to have "started" at.
   *
   * Seeded once, at hydration, from the STORED entry where it has one and from
   * the page's own props otherwise — so mounting a paginated table does not
   * immediately persist its default page size as though the user had chosen it.
   * Only a later divergence from this baseline is a preference worth storing.
   */
  const mirrorRef = useRef<{
    sort: DataTableStoredSort | null;
    pageSize?: number;
  } | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // --- Writes ---------------------------------------------------------------

  const write = useCallback(
    (next: DataTableStoredLayout | null) => {
      if (!tableId) return;
      // `null` deletes the entry (JSON Merge Patch); an object replaces it
      // wholesale, which is why `next` is always the COMPLETE entry.
      //
      // NO `If-Match` HEADER, DELIBERATELY.
      //
      // `PATCH /api/user-settings` supports optimistic concurrency: the
      // controller reads `if-match` and the service compares it against the
      // stored `version`, raising a 409 on a mismatch. `hooks/useUserSettings.ts`
      // opts into that — it holds the whole settings object, shows a form, and a
      // "settings were updated elsewhere" retry is the right answer there.
      //
      // It is the wrong answer here. This write is fire-and-forget UI backup
      // (see the docblock above): it is debounced, its response is never read,
      // and it only ever touches ONE key of ONE namespace. Sending a version we
      // read at mount would make it fail on any race with a concurrent write to
      // an UNRELATED namespace — a theme toggle in another tab bumps `version`,
      // and the user's column choice would then silently fail to persist for no
      // reason connected to columns. The server-side merge is already per-table
      // and per-namespace, so there is no lost update to protect against: two
      // concurrent writers of the SAME table entry is one user racing themselves.
      //
      // Verified against the API: `expectedVersion` is `undefined` when the
      // header is absent, and the version check is skipped entirely in that case
      // (`user-settings.controller.ts` → `user-settings.service.ts`).
      const patch: UserSettingsUpdate = { dataTables: { [tableId]: next } };
      void api.patch('/user-settings', patch).catch((error: unknown) => {
        // Fire-and-forget by design: the layout the user is looking at came
        // from state and stays there. Losing the backup is a warning, never
        // a rollback.
        console.warn(
          `Failed to persist DataTable layout for "${tableId}"`,
          error,
        );
      });
    },
    [tableId],
  );

  const cancelPending = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const schedule = useCallback(
    (next: DataTableStoredLayout) => {
      if (!tableId) return;
      cancelPending();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        write(isEmptyStoredLayout(next) ? null : next);
      }, DATA_TABLE_PERSIST_DEBOUNCE_MS);
    },
    [tableId, cancelPending, write],
  );

  /** Apply a change to the in-session entry, then schedule one write for it. */
  const commit = useCallback(
    (mutate: (current: DataTableStoredLayout) => DataTableStoredLayout) => {
      touchedRef.current = true;
      const next = mutate(entryRef.current);
      // A mutation that declined to change anything (a pinned column, say) is
      // not a write — scheduling one would spend a request on nothing.
      if (next === entryRef.current) return;
      entryRef.current = next;
      setEntry(next);
      schedule(next);
    },
    [schedule],
  );

  // A pending write must survive the unmount that a route change causes —
  // otherwise the last change before navigating away is the one that never
  // lands. Flush it (still fire-and-forget) instead of cancelling it.
  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        const pending = entryRef.current;
        if (tableId) write(isEmptyStoredLayout(pending) ? null : pending);
      }
    },
    [tableId, write],
  );

  // --- Hydration ------------------------------------------------------------

  useEffect(() => {
    if (!tableId) {
      mirrorRef.current = {
        sort: sortRef.current?.sort ?? null,
        pageSize: paginationRef.current?.pageSize,
      };
      setHydrated(true);
      return;
    }

    let cancelled = false;
    setHydrated(false);

    void (async () => {
      let stored: DataTableStoredLayout = {};
      try {
        const settings = await api.get<UserSettingsRead>('/user-settings');
        stored = sanitizeStoredLayout(settings?.dataTables?.[tableId]);
      } catch (error: unknown) {
        // Same posture as a failed write: a settings outage costs the user
        // their restored layout, never their ability to use the table.
        console.warn(`Failed to load DataTable layout for "${tableId}"`, error);
      }

      if (cancelled || !mountedRef.current) return;

      // A choice made while the GET was in flight wins: in-session state is
      // authoritative, and the server copy is only ever a starting point.
      if (!touchedRef.current) {
        entryRef.current = stored;
        setEntry(stored);

        // `sort` and `pageSize` are controlled by the PAGE, so restoring them
        // means handing them back through the page's own callbacks rather than
        // holding a second copy here. Both are validated against the current
        // columns first: a stored sort on a column that has since been removed
        // or made unsortable would be a query the server rejects.
        const restoredSort = resolveStoredSort(columnsRef.current, stored);
        const sortConfig = sortRef.current;
        if (restoredSort && sortConfig) {
          const active = sortConfig.sort;
          if (
            !active ||
            active.field !== restoredSort.field ||
            active.direction !== restoredSort.direction
          ) {
            sortConfig.onSortChange(restoredSort);
          }
        }

        const paginationConfig = paginationRef.current;
        if (
          stored.pageSize &&
          paginationConfig &&
          stored.pageSize !== paginationConfig.pageSize
        ) {
          // Page 0: a different page size makes the current offset meaningless.
          paginationConfig.onPaginationChange({
            page: 0,
            pageSize: stored.pageSize,
          });
        }

        // Baseline for the mirror effect below: a stored value where there is
        // one (the restore we just requested will land on it), the page's own
        // value otherwise. Either way, "no change yet" means "no write yet".
        mirrorRef.current = {
          sort: restoredSort ?? sortRef.current?.sort ?? null,
          pageSize: stored.pageSize ?? paginationRef.current?.pageSize,
        };
      } else {
        mirrorRef.current = {
          sort: sortRef.current?.sort ?? null,
          pageSize: paginationRef.current?.pageSize,
        };
      }

      setHydrated(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [tableId]);

  // --- Mirroring the page's sort / pageSize into the entry -------------------

  const activeSort = sort?.sort ?? null;
  const activePageSize = pagination?.pageSize;

  useEffect(() => {
    if (!tableId || !hydrated) return;
    const baseline = mirrorRef.current;
    if (!baseline) return;

    const nextSort = activeSort
      ? { field: activeSort.field, direction: activeSort.direction }
      : undefined;
    const sortChanged =
      (baseline.sort?.field ?? null) !== (nextSort?.field ?? null) ||
      (baseline.sort?.direction ?? null) !== (nextSort?.direction ?? null);
    const pageSizeChanged =
      activePageSize !== undefined && baseline.pageSize !== activePageSize;

    if (!sortChanged && !pageSizeChanged) return;

    mirrorRef.current = {
      sort: nextSort ?? null,
      pageSize: activePageSize ?? baseline.pageSize,
    };

    const current = entryRef.current;
    const next: DataTableStoredLayout = { ...current };
    if (sortChanged) {
      if (nextSort) next.sort = nextSort;
      else delete next.sort;
    }
    if (pageSizeChanged) next.pageSize = activePageSize;

    entryRef.current = next;
    setEntry(next);
    schedule(next);
  }, [tableId, hydrated, activeSort, activePageSize, schedule]);

  // --- Derived layout -------------------------------------------------------

  const density = entry.density ?? densityProp ?? 'standard';

  const userVisibleColumnIds = useMemo(
    () => resolveUserVisibleColumnIds(columns, entry),
    [columns, entry],
  );

  const visibleColumnIds = useMemo(
    () => resolveVisibleColumnIds(columns, entry, layout),
    [columns, entry, layout],
  );

  const setDensity = useCallback(
    (next: DataTableDensity) => {
      commit((current) => ({ ...current, density: next }));
    },
    [commit],
  );

  const toggleColumn = useCallback(
    (columnId: string, visible: boolean) => {
      commit((current) => {
        const cols = columnsRef.current;
        const column = cols.find((candidate) => candidate.id === columnId);
        // A pinned column has no hidden state to store.
        if (!column || column.hideable === false) return current;

        const chosen = new Set(resolveUserVisibleColumnIds(cols, current));
        if (visible) chosen.add(columnId);
        else chosen.delete(columnId);

        return { ...current, visibleColumns: encodeVisibility(cols, chosen) };
      });
    },
    [commit],
  );

  const reset = useCallback(() => {
    touchedRef.current = true;
    cancelPending();
    entryRef.current = {};
    setEntry({});
    // Immediate, not debounced: "reset" is a single deliberate gesture with
    // nothing to coalesce, and it is expressed as the merge-patch DELETE so the
    // entry stops existing rather than becoming an empty object.
    write(null);
  }, [cancelPending, write]);

  return {
    density,
    visibleColumnIds,
    userVisibleColumnIds,
    hydrated,
    customized: !isEmptyStoredLayout(entry),
    setDensity,
    toggleColumn,
    reset,
  };
}
