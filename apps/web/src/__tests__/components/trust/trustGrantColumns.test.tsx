import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import {
  trustGrantColumns,
  TABLE_ID,
} from '../../../components/trust/trustGrantColumns';
import { TRUST_GRANT_STATUSES } from '../../../types/trust';
import type { TrustGrantListItem } from '../../../types/trust';

/**
 * The column contract for `/trust` (#101).
 *
 * Asserted without mounting the page, which is why the columns live in their
 * own module: this is the table's public shape, read by both renderers, the
 * CSV export and these tests.
 *
 * The `value` extractors get their own assertions because they are where a
 * silent wrongness lives — an export that printed `0%` in the failure-rate
 * column while the cell on screen said "No data" would be the same lie, only
 * harder to notice.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function grantFixture(
  overrides: Partial<TrustGrantListItem> = {},
): TrustGrantListItem {
  return {
    id: 'g-1',
    actionClass: 're-dispatch',
    actionClassTitle: 'Re-dispatch after transient failure',
    repositoryId: 'acme/api',
    expiresAt: '2099-01-01T00:00:00.000Z',
    budgetCeilingUsd: 25,
    spentUsd: 3,
    actionsAuthorized: 0,
    actionsFailed: 0,
    maxFailureRate: 0.34,
    maxCostPerActionUsd: 5,
    minActionsBeforeAutoRevoke: 3,
    status: 'active',
    endedAt: null,
    endReason: null,
    endDetail: null,
    revokedById: null,
    note: null,
    grantedById: 'u-1',
    grantedFromProposalId: null,
    renewedFromId: null,
    createdAt: '2026-08-22T09:00:00.000Z',
    updatedAt: '2026-08-22T09:00:00.000Z',
    remainingBudgetUsd: 22,
    budgetHeadroomFraction: 0.88,
    msUntilExpiry: 5 * DAY,
    failureRate: null,
    nearExpiry: false,
    nearBudget: false,
    ...overrides,
  };
}

const byId = () =>
  Object.fromEntries(trustGrantColumns().map((column) => [column.id, column]));

describe('trustGrantColumns', () => {
  it('keeps a storage key that does not track the heading', () => {
    expect(TABLE_ID).toBe('trust-grants');
  });

  it('declares NO sortable column, because the endpoint has no sort parameter', () => {
    // The list is newest first by contract. A sortable header could only
    // re-sort the page in the browser, which is a control that looks live and
    // quietly lies.
    for (const column of trustGrantColumns()) {
      expect(column.sortable, `${column.id} claims to be sortable`).toBeFalsy();
    }
  });

  it('offers `status` as the only filter, over exactly the API’s enum', () => {
    const columns = byId();

    expect(columns.status.filterable).toEqual(['is']);
    expect(columns.status.filterType).toBe('enum');
    expect(columns.status.enumValues?.map((option) => option.value)).toEqual([
      ...TRUST_GRANT_STATUSES,
    ]);

    // `actionClass` is NOT filterable: its accepted values are the ADR-0011
    // registry ids, no endpoint exposes that registry to a browser, and a
    // hand-copied list here is exactly the drift the registry prevents.
    for (const column of trustGrantColumns()) {
      if (column.id === 'status') continue;
      expect(
        column.filterable,
        `${column.id} claims to be filterable`,
      ).toBeFalsy();
    }
  });

  it('carries all four VISION §8 attributes as columns', () => {
    const columns = byId();

    // Scope is `actionClass` + `repositoryId`, rendered in one cell.
    expect(columns.actionClass).toBeDefined();
    expect(columns.expiry).toBeDefined();
    expect(columns.budget).toBeDefined();
    expect(columns.autoRevoke).toBeDefined();
  });

  it('exports a null failure rate as "No data", not as 0%', () => {
    const columns = byId();

    expect(columns.failureRate.value?.(grantFixture())).toBe('No data');
    expect(columns.failureRate.value?.(grantFixture({ failureRate: 0 }))).toBe(
      '0%',
    );
  });

  it('exports a lapsed expiry as lapsed', () => {
    const columns = byId();

    expect(
      columns.expiry.value?.(grantFixture({ msUntilExpiry: -2 * HOUR })),
    ).toBe('Lapsed 2h ago');
  });

  it('names the sample floor in the auto-revoke export', () => {
    const columns = byId();

    expect(columns.autoRevoke.value?.(grantFixture())).toContain(
      'once 3 actions have run',
    );
  });

  it('leaves the end reason blank on a live grant and names it on an ended one', () => {
    const columns = byId();

    expect(columns.endReason.value?.(grantFixture())).toBe('');
    expect(
      columns.endReason.value?.(
        grantFixture({
          status: 'suspended',
          endReason: 'failure_rate_exceeded',
        }),
      ),
    ).toBe('Failure rate crossed its ceiling');
    // Never invented. A row that ended with no recorded reason says so.
    expect(columns.endReason.value?.(grantFixture({ status: 'expired' }))).toBe(
      'No recorded reason',
    );
  });

  it('falls back to the raw id when the registry had no title', () => {
    const columns = byId();

    expect(
      columns.actionClass.value?.(grantFixture({ actionClassTitle: null })),
    ).toBe('re-dispatch');
  });

  describe('rendered cells', () => {
    it('links the scope cell to the grant, and keeps the repository', () => {
      const columns = byId();
      render(<>{columns.actionClass.render?.(grantFixture())}</>);

      expect(
        screen.getByRole('link', {
          name: 'Re-dispatch after transient failure',
        }),
      ).toHaveAttribute('href', '/trust/grants/g-1');
      expect(screen.getByText('acme/api')).toBeInTheDocument();
    });

    it('draws nothing in the end-reason cell of a live grant', () => {
      const columns = byId();
      expect(columns.endReason.render?.(grantFixture())).toBeNull();
    });

    it('shows the end detail alongside the reason on an ended grant', () => {
      const columns = byId();
      render(
        <>
          {columns.endReason.render?.(
            grantFixture({
              status: 'suspended',
              endReason: 'failure_rate_exceeded',
              endDetail: 'Failure rate 62% over 8 actions.',
            }),
          )}
        </>,
      );

      expect(
        screen.getByText('Failure rate crossed its ceiling'),
      ).toBeInTheDocument();
      expect(
        screen.getByText('Failure rate 62% over 8 actions.'),
      ).toBeInTheDocument();
    });

    it('counts failures only when there are some', () => {
      const columns = byId();
      const { unmount } = render(
        <>{columns.usage.render?.(grantFixture({ actionsAuthorized: 4 }))}</>,
      );
      expect(screen.getByText('4 authorized')).toBeInTheDocument();
      unmount();

      render(
        <>
          {columns.usage.render?.(
            grantFixture({ actionsAuthorized: 4, actionsFailed: 1 }),
          )}
        </>,
      );
      expect(screen.getByText('4 authorized · 1 failed')).toBeInTheDocument();
    });

    it('renders the failure-rate cell muted when there is no data', () => {
      const columns = byId();
      render(<>{columns.failureRate.render?.(grantFixture())}</>);

      expect(screen.getByText('No data')).toBeInTheDocument();
      expect(screen.queryByText('0%')).not.toBeInTheDocument();
    });

    it('renders the "granted" cell relative to now', () => {
      const columns = byId();
      render(<>{columns.createdAt.render?.(grantFixture())}</>);

      // A relative age rather than a timestamp, matching every other data
      // surface in the app.
      expect(screen.getByText(/ago$/)).toBeInTheDocument();
    });
  });
});
