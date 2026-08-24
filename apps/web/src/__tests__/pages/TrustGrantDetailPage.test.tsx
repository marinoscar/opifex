import { describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { render, mockAdminUser, mockUser } from '../utils/test-utils';
import { server } from '../mocks/server';
import TrustGrantDetailPage from '../../pages/TrustGrantDetailPage';
import type { TrustGrantDetail } from '../../types/trust';

/**
 * `/trust/grants/:id` — one grant, in full (#101, epic #22).
 *
 * `useParams` is stubbed rather than the whole router being driven, following
 * `ApprovalDetailPage.test.tsx`: the page under test is the subject, not
 * react-router's matching.
 */

vi.mock('react-router-dom', async () => {
  const actual =
    await vi.importActual<typeof import('react-router-dom')>(
      'react-router-dom',
    );
  return { ...actual, useParams: () => ({ id: 'g-1' }) };
});

const API = '*/api';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function detailFixture(
  overrides: Partial<TrustGrantDetail> = {},
): TrustGrantDetail {
  return {
    id: 'g-1',
    actionClass: 're-dispatch',
    repositoryId: 'acme/api',
    expiresAt: new Date(Date.now() + 5 * DAY).toISOString(),
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
    note: 'Granted from an approval on 2026-08-20.',
    grantedById: 'admin-user-id',
    grantedFromProposalId: null,
    renewedFromId: null,
    createdAt: new Date(Date.now() - 2 * DAY).toISOString(),
    updatedAt: new Date(Date.now() - 2 * DAY).toISOString(),
    remainingBudgetUsd: 22,
    budgetHeadroomFraction: 0.88,
    msUntilExpiry: 5 * DAY,
    // NULL, not 0: nothing has run under this grant yet.
    failureRate: null,
    nearExpiry: false,
    nearBudget: false,
    actionClassEntry: {
      id: 're-dispatch',
      title: 'Re-dispatch after transient failure',
      definition:
        'Re-runs a work order whose runner died without reporting a result.',
      effect: 'A new run is dispatched for the same work order.',
      reversibility: 'reversible',
      autonomyEligible: true,
      hasProposer: true,
      spendsMoney: true,
    },
    renewedBy: [],
    ...overrides,
  };
}

function serveGrant(grant: TrustGrantDetail) {
  server.use(
    http.get(`${API}/trust/grants/:id`, () =>
      HttpResponse.json({
        data: grant,
        meta: { timestamp: new Date().toISOString() },
      }),
    ),
  );
}

describe('TrustGrantDetailPage', () => {
  beforeEach(() => {
    serveGrant(detailFixture());
  });

  describe('the four attributes', () => {
    it('shows scope, expiry, budget ceiling and auto-revoke together', async () => {
      // VISION §8's four, and #101's first acceptance criterion. None of them
      // costs a tap to reveal: a screen on which one is hidden is a screen on
      // which a grant looks bounded without anybody having checked the bound.
      render(<TrustGrantDetailPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await screen.findByRole('heading', {
        name: 'Re-dispatch after transient failure',
      });

      expect(screen.getByText('Scope')).toBeInTheDocument();
      expect(
        screen.getByText('Re-dispatch after transient failure in acme/api'),
      ).toBeInTheDocument();
      expect(screen.getByText('Expires in 5d')).toBeInTheDocument();
      expect(screen.getByText('$22.00 of $25.00 left')).toBeInTheDocument();
      expect(
        screen.getByText(
          /Revokes itself above 34% failures \(once 3 actions have run\), or if one action costs more than \$5\.00\./,
        ),
      ).toBeInTheDocument();
    });

    it('renders a null failure rate as "No data", NEVER as 0%', async () => {
      render(<TrustGrantDetailPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await screen.findByRole('heading', {
        name: 'Re-dispatch after transient failure',
      });

      expect(screen.getByTestId('failure-rate')).toHaveTextContent('No data');
      expect(screen.queryByText('0%')).not.toBeInTheDocument();
      expect(
        screen.getByText(/No actions have run under this grant yet/),
      ).toBeInTheDocument();
    });

    it('distinguishes a 0% failure rate from no data at all', async () => {
      // The other half of the same distinction: actions RAN and every one of
      // them succeeded. That is a real 0%, and it must not be suppressed.
      serveGrant(
        detailFixture({
          actionsAuthorized: 6,
          actionsFailed: 0,
          failureRate: 0,
        }),
      );
      render(<TrustGrantDetailPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await screen.findByRole('heading', {
        name: 'Re-dispatch after transient failure',
      });

      expect(screen.getByTestId('failure-rate')).toHaveTextContent('0%');
      expect(screen.queryByText('No data')).not.toBeInTheDocument();
    });

    it('renders a lapsed grant as lapsed, not as a countdown', async () => {
      serveGrant(
        detailFixture({
          status: 'expired',
          msUntilExpiry: -3 * HOUR,
          expiresAt: new Date(Date.now() - 3 * HOUR).toISOString(),
          endedAt: new Date(Date.now() - 3 * HOUR).toISOString(),
          endReason: 'expired',
          endDetail: 'The grant reached its expiry and was not renewed.',
        }),
      );
      render(<TrustGrantDetailPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(await screen.findByText('Lapsed 3h ago')).toBeInTheDocument();
      expect(screen.queryByText('Expires in 3h')).not.toBeInTheDocument();
      expect(screen.getByTestId('how-it-ended')).toHaveTextContent(
        'Reached its expiry',
      );
      expect(screen.getByTestId('how-it-ended')).toHaveTextContent(
        'The grant reached its expiry and was not renewed.',
      );
    });

    it('warns when the server says the grant is near its expiry', async () => {
      serveGrant(detailFixture({ msUntilExpiry: 4 * HOUR, nearExpiry: true }));
      render(<TrustGrantDetailPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(await screen.findByTestId('headroom-warning')).toHaveTextContent(
        'Expires in 4h',
      );
    });

    it('warns when the server says the grant is near its ceiling', async () => {
      serveGrant(
        detailFixture({
          spentUsd: 23,
          remainingBudgetUsd: 2,
          budgetHeadroomFraction: 0.08,
          nearBudget: true,
        }),
      );
      render(<TrustGrantDetailPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(await screen.findByTestId('headroom-warning')).toHaveTextContent(
        '$2.00 of $25.00 left',
      );
    });

    it('does not warn about headroom on a grant that has already ended', async () => {
      // An ended grant authorizes nothing, so "runs out of budget soon" over
      // it is noise on the one screen that must make live warnings obvious.
      serveGrant(
        detailFixture({
          status: 'revoked',
          nearExpiry: true,
          nearBudget: true,
          msUntilExpiry: 2 * HOUR,
          endReason: 'manual_revocation',
          endedAt: new Date().toISOString(),
        }),
      );
      render(<TrustGrantDetailPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await screen.findByTestId('how-it-ended');
      expect(screen.queryByTestId('headroom-warning')).not.toBeInTheDocument();
    });
  });

  describe('the class definition', () => {
    it('shows what the class actually does, not just its id', async () => {
      render(<TrustGrantDetailPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(
        await screen.findByText(
          'Re-runs a work order whose runner died without reporting a result.',
        ),
      ).toBeInTheDocument();
      expect(screen.getByText('reversible')).toBeInTheDocument();
      expect(screen.getByText('Autonomy-eligible')).toBeInTheDocument();
    });

    it('reports registry drift rather than hiding it', async () => {
      // A grant outlives edits to the taxonomy, so `actionClassEntry: null` on
      // a LIVE grant is a real case and worth seeing.
      serveGrant(detailFixture({ actionClassEntry: null }));
      render(<TrustGrantDetailPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await screen.findByRole('heading', { name: 're-dispatch' });
      // TWICE, deliberately: once as a banner over a LIVE grant ("the grant is
      // live regardless") and once where the definition would have been. They
      // answer different questions and neither substitutes for the other.
      expect(screen.getAllByText(/does not recognise/)).toHaveLength(2);
      expect(
        screen.getByText(/The grant is live regardless/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/there is no definition to show/),
      ).toBeInTheDocument();
    });

    it('flags a live grant whose class is no longer autonomy-eligible', async () => {
      serveGrant(
        detailFixture({
          actionClassEntry: {
            ...detailFixture().actionClassEntry!,
            autonomyEligible: false,
          },
        }),
      );
      render(<TrustGrantDetailPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(
        await screen.findByText(
          /could not be created today, and it is still authorizing work/,
        ),
      ).toBeInTheDocument();
    });
  });

  describe('the renewal chain', () => {
    it('says an expired grant with no renewal was revoked by silence', async () => {
      // The distinction the FORWARD edge exists for: an expired grant with a
      // renewal was kept alive, one without is "silence revokes" having
      // actually happened. The backward edge alone cannot tell them apart.
      serveGrant(
        detailFixture({
          status: 'expired',
          msUntilExpiry: -2 * DAY,
          endReason: 'expired',
          endedAt: new Date(Date.now() - 2 * DAY).toISOString(),
        }),
      );
      render(<TrustGrantDetailPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const chain = await screen.findByTestId('renewal-chain');
      expect(chain).toHaveTextContent('silence revoked it');
      expect(chain).toHaveTextContent('this is an original grant');
    });

    it('shows both directions when both exist', async () => {
      serveGrant(
        detailFixture({
          renewedFromId: '11111111-1111-4111-8111-111111111111',
          renewedBy: [
            {
              id: '22222222-2222-4222-8222-222222222222',
              status: 'active',
              expiresAt: new Date(Date.now() + 6 * DAY).toISOString(),
              createdAt: new Date(Date.now() - HOUR).toISOString(),
            },
          ],
        }),
      );
      render(<TrustGrantDetailPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const chain = await screen.findByTestId('renewal-chain');
      expect(
        within(chain).getByRole('link', {
          name: '11111111-1111-4111-8111-111111111111',
        }),
      ).toHaveAttribute(
        'href',
        '/trust/grants/11111111-1111-4111-8111-111111111111',
      );
      expect(
        within(chain).getByRole('link', {
          name: '22222222-2222-4222-8222-222222222222',
        }),
      ).toBeInTheDocument();
    });

    it('offers no renew control — the endpoint is not on this branch (#115)', async () => {
      render(<TrustGrantDetailPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await screen.findByTestId('renewal-chain');
      expect(
        screen.queryByRole('button', { name: /renew/i }),
      ).not.toBeInTheDocument();
    });
  });

  describe('revocation', () => {
    it('is available here, and calls the endpoint', async () => {
      const revoked = vi.fn();
      server.use(
        http.delete(`${API}/trust/grants/:id`, async ({ params, request }) => {
          revoked({
            id: params.id,
            body: await request.json().catch(() => null),
          });
          return HttpResponse.json({
            data: { ...detailFixture(), status: 'revoked' },
            meta: { timestamp: new Date().toISOString() },
          });
        }),
      );

      render(<TrustGrantDetailPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      fireEvent.click(
        await screen.findByRole('button', { name: 'Revoke this grant' }),
      );
      const dialog = await screen.findByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText(/Why \(optional\)/i), {
        target: { value: 'Superseded by a narrower grant.' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));

      await waitFor(() =>
        expect(revoked).toHaveBeenCalledWith({
          id: 'g-1',
          body: { note: 'Superseded by a narrower grant.' },
        }),
      );
      expect(
        await screen.findByText(/Revoked, and recorded as yours\./),
      ).toBeInTheDocument();
    });

    it('does nothing when the confirm dialog is cancelled', async () => {
      const revoked = vi.fn();
      server.use(
        http.delete(`${API}/trust/grants/:id`, () => {
          revoked();
          return HttpResponse.json({
            data: detailFixture(),
            meta: { timestamp: new Date().toISOString() },
          });
        }),
      );

      render(<TrustGrantDetailPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      fireEvent.click(
        await screen.findByRole('button', { name: 'Revoke this grant' }),
      );
      fireEvent.click(
        within(await screen.findByRole('dialog')).getByRole('button', {
          name: 'Cancel',
        }),
      );

      expect(revoked).not.toHaveBeenCalled();
    });

    it('disables it for a viewer, and names the permission', async () => {
      render(<TrustGrantDetailPage />, { wrapperOptions: { user: mockUser } });

      expect(
        await screen.findByRole('button', { name: 'Revoke this grant' }),
      ).toBeDisabled();
      expect(screen.getByText(/trust:revoke/)).toBeInTheDocument();
    });

    it('offers no revoke control on a grant that has already ended', async () => {
      serveGrant(
        detailFixture({
          status: 'revoked',
          endReason: 'manual_revocation',
          endedAt: new Date().toISOString(),
          endDetail: 'Revoked by a person. Note: misfiring on acme/api.',
          revokedById: 'admin-user-id',
        }),
      );
      render(<TrustGrantDetailPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await screen.findByTestId('how-it-ended');
      expect(
        screen.queryByRole('button', { name: 'Revoke this grant' }),
      ).not.toBeInTheDocument();
    });
  });
});
