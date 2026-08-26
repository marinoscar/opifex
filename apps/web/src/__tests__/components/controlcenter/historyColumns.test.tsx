import { describe, expect, it } from 'vitest';

import {
  historyColumns,
  TABLE_ID,
} from '../../../components/controlcenter/historyColumns';
import type { AuditEvent } from '../../../types/audit';

/**
 * The column contract for the History section (#351, epic #332).
 *
 * Asserted without mounting the section, which is why the columns live in
 * their own module: this is the table's public shape, read by both renderers
 * AND by the CSV export.
 *
 * **The export is the reason this file exists.** `DataTableColumn.value` is
 * the scalar written to a CSV, and it is a separate function from `render` —
 * so the DOM grep in `HistorySection.test.tsx` says nothing about it. A column
 * whose `value` returned `JSON.stringify(event.meta)` would draw a masked
 * screen and write a credential into a file in a downloads folder, and that
 * gap was found by breaking this exact line and watching every other test in
 * the suite still pass.
 */

const PLAINTEXT_TOKEN = 'ghp_Kx7Vd2Nq9Zb4Mr6Wt3Jc8Ly5Hs';
const PLAINTEXT_KEY = 'sk-ant-api03-0Vb7Qn4Xz2Lp9Rk1';

function auditEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: 'e1',
    action: 'operator_settings:set',
    targetType: 'operator_settings',
    targetId: 'dispatch.enabled',
    actorUserId: 'admin-user-id',
    actor: {
      id: 'admin-user-id',
      email: 'admin@example.com',
      displayName: 'Admin User',
    },
    meta: { key: 'dispatch.enabled', from: false, to: true },
    createdAt: '2026-08-26T10:00:00.000Z',
    ...overrides,
  };
}

/** Every column's export scalar for one row, as the CSV writer would take it. */
function exportedRow(event: AuditEvent): string {
  return historyColumns()
    .map((column) => String(column.value?.(event) ?? ''))
    .join(',');
}

describe('historyColumns', () => {
  it('has a stable table id, which is a storage key', () => {
    // `user_settings.dataTables[tableId]`. It must survive a rename of the
    // section or the route, so it is a constant rather than derived.
    expect(TABLE_ID).toBe('control-center-history');
  });

  it('declares nothing sortable, because the endpoint takes no sort', () => {
    // `GET /api/audit-events` orders by `createdAt desc` with an `id`
    // tiebreaker and accepts no `sort` parameter. A sortable header could only
    // re-order the rows already on screen — a control that looks live and
    // quietly lies.
    expect(historyColumns().some((column) => column.sortable)).toBe(false);
  });

  it('offers exactly one filter, and it is the one the endpoint honours', () => {
    const filterable = historyColumns().filter((column) => column.filterable);
    expect(filterable.map((column) => column.id)).toEqual(['targetType']);
    expect(filterable[0].filterType).toBe('enum');
  });

  it('exports a timestamp that can be parsed, not the words "3m ago"', () => {
    const [when] = historyColumns();
    expect(when.value?.(auditEvent())).toBe('2026-08-26T10:00:00.000Z');
  });

  it('exports the change as a readable before and after', () => {
    const change = historyColumns().find((column) => column.id === 'change');
    expect(change?.value?.(auditEvent())).toBe(
      'dispatch.enabled: false → true',
    );
  });

  it('exports no credential, even one the API should never have served', () => {
    // The CSV counterpart of the DOM grep. Both plaintexts here are worse than
    // anything the redacted endpoint can produce, precisely so the assertion
    // does not depend on the server having done its job.
    const rows = [
      auditEvent({
        targetId: 'github.token',
        meta: { key: 'github.token', from: null, to: PLAINTEXT_TOKEN },
      }),
      auditEvent({
        targetId: 'supervisor.model.apiKey',
        meta: {
          key: 'supervisor.model.apiKey',
          from: '********',
          to: '********9Rk1',
        },
      }),
      auditEvent({
        action: 'user:update',
        targetType: 'user',
        targetId: 'u1',
        meta: { apiKey: PLAINTEXT_KEY, displayName: 'Ada' },
      }),
    ];

    const csv = rows.map(exportedRow).join('\n');

    for (const forbidden of [
      PLAINTEXT_TOKEN,
      PLAINTEXT_KEY,
      'Ly5Hs',
      '9Rk1',
      '********',
    ]) {
      expect(csv, `export contains ${forbidden}`).not.toContain(forbidden);
    }

    // Still says what it can, so the export is worth having.
    expect(csv).toContain('github.token: secret set');
    expect(csv).toContain('displayName: Ada');
  });

  it('exports the three kinds of actor as three different words', () => {
    const actor = historyColumns().find((column) => column.id === 'actor');

    expect(actor?.value?.(auditEvent())).toBe('Admin User');
    expect(actor?.value?.(auditEvent({ actor: null }))).toBe('Deleted account');
    expect(actor?.value?.(auditEvent({ actor: null, actorUserId: null }))).toBe(
      'Opifex itself',
    );
  });
});
