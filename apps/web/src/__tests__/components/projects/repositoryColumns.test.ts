import { describe, expect, it } from 'vitest';

import {
  formatCeiling,
  repositoryColumns,
  TABLE_ID,
} from '../../../components/projects/repositoryColumns';

/**
 * The column contract for `/projects` (#81).
 *
 * VISION §2 makes the cross-repository view the part GitHub does not offer, and
 * per-repository dispatch is how the observation week (#16) ends one repository
 * at a time rather than globally.
 */

describe('repositoryColumns', () => {
  const byId = () =>
    Object.fromEntries(
      repositoryColumns().map((column) => [column.id, column]),
    );

  it('declares NO column sortable, because the endpoint cannot sort', () => {
    // `GET /api/repositories` takes page, pageSize and two boolean filters —
    // no sort parameter at all. A sortable header it could not answer would
    // look live and do nothing.
    expect(repositoryColumns().every((column) => !column.sortable)).toBe(true);
  });

  it('declares filterable only on the two booleans the API honours', () => {
    const filterable = repositoryColumns()
      .filter((column) => column.filterable)
      .map((column) => column.id)
      .sort();

    expect(filterable).toEqual(['dispatchEnabled', 'observeEnabled']);
  });

  it('puts dispatch enablement at primary priority', () => {
    // #81 calls it operationally important: it must not be buried on a phone,
    // where `detail` columns are the first to go.
    expect(byId().dispatchEnabled.priority).toBe('primary');
  });

  it('states the dispatch-off case in words, not as a blank', () => {
    const value = byId().dispatchEnabled.value!;
    expect(value({ dispatchEnabled: false } as never)).toBe('Disabled');
    expect(value({ dispatchEnabled: true } as never)).toBe('Enabled');
  });

  it('sorts and exports last-observed on the raw timestamp', () => {
    // "3m ago" sorts alphabetically into nonsense; the scalar has to be
    // orderable and is also what the CSV export carries.
    const value = byId().lastObservedAt.value!;
    expect(value({ lastObservedAt: '2026-08-24T10:00:00.000Z' } as never)).toBe(
      '2026-08-24T10:00:00.000Z',
    );
  });

  it('keeps a stable table id, because it is a storage key', () => {
    expect(TABLE_ID).toBe('cockpit-repositories');
  });
});

describe('formatCeiling', () => {
  it('says "none" rather than showing a zero ceiling', () => {
    // No ceiling REFUSES dispatch rather than permitting it, so `$0` would be
    // both wrong and reassuring.
    expect(formatCeiling(null)).toBe('none');
  });

  it('keeps the API string verbatim rather than parsing it', () => {
    // The API serialises the ceiling as a STRING because a float "would round a
    // spend ceiling, which is the one field where that is least acceptable".
    // Parsing it here to format it would undo that in the last ten metres.
    expect(formatCeiling('12.50')).toBe('$12.50');
    expect(formatCeiling('0.0001')).toBe('$0.0001');
  });
});
