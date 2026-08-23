import { describe, expect, it } from 'vitest';

import {
  formatCost,
  formatSilence,
  runColumns,
  TABLE_ID,
} from '../../../components/runs/runColumns';
import { RUN_STATUSES } from '../../../types/cockpit';

/**
 * The column contract for `/runs` (#82).
 *
 * Asserted without mounting a page, which is the reason the columns live in
 * their own module: this is the table's public shape, read by both renderers,
 * the CSV export and these tests.
 */

describe('runColumns', () => {
  const byId = () =>
    Object.fromEntries(runColumns().map((column) => [column.id, column]));

  it('declares sortable ONLY where GET /api/runs can sort', () => {
    // A sortable header the endpoint cannot answer looks live and does
    // nothing, which is worse than no affordance at all.
    const sortable = runColumns()
      .filter((column) => column.sortable)
      .map((column) => column.id)
      .sort();

    expect(sortable).toEqual(['costUsd', 'lastEventAt', 'startedAt', 'status']);
  });

  it('declares filterable ONLY on status, the one parameter the API takes', () => {
    const filterable = runColumns()
      .filter((column) => column.filterable)
      .map((column) => column.id);

    expect(filterable).toEqual(['status']);
  });

  it('offers all six statuses individually, not collapsed into "unhealthy"', () => {
    // VISION §9 treats stalled, blocked and quarantined as three different
    // problems with three different responses. Collapsing them in the filter
    // would undo that exactly where an operator acts on it.
    const values = byId()
      .status.enumValues?.map((option) => option.value)
      .sort();

    expect(values).toEqual([...RUN_STATUSES].sort());
  });

  it('sorts last-event on the raw timestamp, not the rendered age', () => {
    // "3m ago" sorts alphabetically into nonsense. The scalar has to be
    // orderable, and it is also what the CSV export carries.
    const value = byId().lastEventAt.value!;
    expect(value({ lastEventAt: '2026-08-23T10:00:00.000Z' } as never)).toBe(
      '2026-08-23T10:00:00.000Z',
    );
  });

  it('keeps a stable table id, because it is a storage key', () => {
    // Persisted into `user_settings.dataTables`; deriving it from the heading
    // would silently drop a user's column preferences on a rename.
    expect(TABLE_ID).toBe('cockpit-runs');
  });
});

describe('formatCost', () => {
  it('renders an em dash for a runner that reports no cost', () => {
    // Null is NOT zero. VISION §6 makes cost reporting a declared capability,
    // so a runner that cannot report must not read as one that spent nothing.
    expect(formatCost(null)).toBe('—');
  });

  it('renders zero as zero', () => {
    expect(formatCost(0)).toBe('$0.0000');
  });

  it('renders four places, matching the column', () => {
    expect(formatCost(0.4231)).toBe('$0.4231');
  });
});

describe('formatSilence', () => {
  const now = new Date('2026-08-23T12:00:00.000Z');

  it('says "never" for a run that has never reported', () => {
    // The worst case the watchdog can see, and it must not render as an empty
    // cell that reads like a missing value.
    expect(formatSilence(null, now)).toBe('never');
  });

  it('renders an age for a run that has', () => {
    expect(formatSilence('2026-08-23T11:57:00.000Z', now)).toContain('ago');
  });
});
