import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { render, mockAdminUser, mockUser } from '../utils/test-utils';
import { server } from '../mocks/server';
import {
  installLayoutStubs,
  setInitialContainerWidth,
} from '../../components/datatable/__tests__/testUtils/layoutStubs';
import TrustPage from '../../pages/TrustPage';
import type {
  ClassEvidence,
  PromotionLadder,
  PromotionState,
  TrustGrantListItem,
} from '../../types/trust';

/**
 * `/trust` — the grants list and the promotion ladder (#101, epic #22).
 *
 * Rendered at a phone-width CONTAINER so the DataTable resolves to its card
 * renderer, following `ApprovalsPage.test.tsx`: cards are one DOM node per row,
 * which makes a row assertion an assertion about ROWS rather than about a
 * virtualized grid's viewport. The layout stubs are the shared #253 recipe.
 *
 * Both tab panels stay mounted, so every query is scoped with `within(...)` to
 * the panel it belongs to. That is deliberate rather than incidental: a test
 * that found "No data" anywhere on the page could not tell the grants table
 * from the ladder.
 */

const API = '*/api';
const CARD_WIDTH = 400;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function grantFixture(
  overrides: Partial<TrustGrantListItem> = {},
): TrustGrantListItem {
  return {
    id: 'g-fresh',
    actionClass: 're-dispatch',
    actionClassTitle: 'Re-dispatch after transient failure',
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
    note: null,
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
    ...overrides,
  };
}

/** Active, healthy, and with NO actions yet — the `failureRate: null` case. */
const FRESH = grantFixture();

/** Active and inside the renewal-prompt window. `nearExpiry` is the SERVER's. */
const NEAR_EXPIRY = grantFixture({
  id: 'g-near-expiry',
  actionClass: 'issue-shaping',
  actionClassTitle: 'Issue shaping',
  msUntilExpiry: 4 * HOUR,
  expiresAt: new Date(Date.now() + 4 * HOUR).toISOString(),
  actionsAuthorized: 8,
  actionsFailed: 1,
  failureRate: 0.125,
  nearExpiry: true,
});

/** Active and nearly out of budget. `nearBudget` is likewise the server's. */
const NEAR_BUDGET = grantFixture({
  id: 'g-near-budget',
  actionClass: 'runner-restart',
  actionClassTitle: 'Runner restart',
  spentUsd: 23,
  remainingBudgetUsd: 2,
  budgetHeadroomFraction: 0.08,
  actionsAuthorized: 12,
  actionsFailed: 2,
  failureRate: 0.1667,
  nearBudget: true,
});

/**
 * ENDED, and lapsed three hours ago. `msUntilExpiry` is NEGATIVE — the whole
 * reason the API leaves it signed.
 */
const LAPSED = grantFixture({
  id: 'g-lapsed',
  actionClass: 'dependency-bump',
  actionClassTitle: 'Dependency bump',
  status: 'expired',
  msUntilExpiry: -3 * HOUR,
  expiresAt: new Date(Date.now() - 3 * HOUR).toISOString(),
  endedAt: new Date(Date.now() - 3 * HOUR).toISOString(),
  endReason: 'expired',
  endDetail: 'The grant reached its expiry and was not renewed.',
  actionsAuthorized: 4,
  actionsFailed: 1,
  failureRate: 0.25,
});

const ACTIVE_GRANTS = [FRESH, NEAR_EXPIRY, NEAR_BUDGET];
const ALL_GRANTS = [...ACTIVE_GRANTS, LAPSED];

function evidenceFixture(
  overrides: Partial<ClassEvidence> = {},
): ClassEvidence {
  return {
    actionClass: 're-dispatch',
    approved: 0,
    rejected: 0,
    sample: 0,
    // NULL, not 0. A 0% approval rate would claim humans refuse this class
    // every single time they see it.
    rate: null,
    recentApproved: 0,
    recentRejected: 0,
    recentSample: 0,
    recentRate: null,
    fromProposals: 0,
    fromApprovals: 0,
    ...overrides,
  };
}

function stateFixture(overrides: Partial<PromotionState> = {}): PromotionState {
  return {
    actionClass: 're-dispatch',
    actionClassTitle: 'Re-dispatch after transient failure',
    rung: 'observe',
    eligible: true,
    changedAt: new Date(Date.now() - 7 * DAY).toISOString(),
    changeReason: null,
    changeDetail: null,
    evidence: null,
    currentEvidence: evidenceFixture(),
    requirement: 'Needs 10 more human decisions before a rate can be judged.',
    wouldChange: null,
    promotedAt: null,
    demotedAt: null,
    demotionCount: 0,
    ...overrides,
  };
}

/**
 * The sentence a test asserts VERBATIM. Written once, here, so the test cannot
 * accidentally assert a paraphrase of itself.
 */
const PROMOTED_REQUIREMENT =
  'Holding the promoted rung requires staying at or above 50% approval over at least 5 decisions in the last 14 days; it is currently at 92% over 26.';

const PROMOTED_STATE = stateFixture({
  actionClass: 'runner-restart',
  actionClassTitle: 'Runner restart',
  rung: 'promoted',
  changeReason: 'promoted_on_evidence',
  changeDetail: 'Promoted at 92% approval over 26 decisions.',
  currentEvidence: evidenceFixture({
    actionClass: 'runner-restart',
    approved: 24,
    rejected: 2,
    sample: 26,
    rate: 0.923,
    recentApproved: 9,
    recentRejected: 1,
    recentSample: 10,
    recentRate: 0.9,
    fromProposals: 6,
    fromApprovals: 20,
  }),
  requirement: PROMOTED_REQUIREMENT,
  promotedAt: new Date(Date.now() - 3 * DAY).toISOString(),
  // Promoting something for the FOURTH time is a different act from promoting
  // it once.
  demotionCount: 3,
});

const OBSERVE_STATE = stateFixture();

function ladderFixture(
  overrides: Partial<PromotionLadder> = {},
): PromotionLadder {
  return {
    // DEFAULTS OFF, which is why this is the fixture default too.
    enabled: false,
    readAt: new Date().toISOString(),
    thresholds: {
      minSample: 10,
      promotionRate: 0.9,
      demotionRate: 0.5,
      demotionMinSample: 5,
      regressionWindowDays: 14,
    },
    states: [OBSERVE_STATE, PROMOTED_STATE],
    ...overrides,
  };
}

/** Captures the query string every `GET /trust/grants` was called with. */
let grantQueries: string[] = [];

function serveGrants(pick: (url: URL) => TrustGrantListItem[]) {
  server.use(
    http.get(`${API}/trust/grants`, ({ request }) => {
      const url = new URL(request.url);
      grantQueries.push(url.search);
      return HttpResponse.json({
        data: pick(url),
        meta: { timestamp: new Date().toISOString() },
      });
    }),
  );
}

function serveLadder(ladder: PromotionLadder) {
  server.use(
    http.get(`${API}/promotion/states`, () =>
      HttpResponse.json({
        data: ladder,
        meta: { timestamp: new Date().toISOString() },
      }),
    ),
  );
}

function grantsPanel() {
  return within(screen.getByTestId('trust-panel-grants'));
}

function ladderPanel() {
  return within(screen.getByTestId('trust-panel-ladder'));
}

describe('TrustPage', () => {
  beforeAll(() => {
    installLayoutStubs();
  });

  beforeEach(() => {
    setInitialContainerWidth(CARD_WIDTH);
    grantQueries = [];
    // The API's own default: active grants only unless `includeEnded=true`.
    serveGrants((url) =>
      url.searchParams.get('includeEnded') === 'true'
        ? ALL_GRANTS
        : ACTIVE_GRANTS,
    );
    serveLadder(ladderFixture());
  });

  // -------------------------------------------------------------------------
  // The grants list
  // -------------------------------------------------------------------------

  describe('the grants list', () => {
    it('names every active grant by its class and its repository', async () => {
      render(<TrustPage />, { wrapperOptions: { user: mockAdminUser } });

      const panel = grantsPanel();
      await panel.findByText('Re-dispatch after transient failure');

      // Scope is BOTH halves — a class without its repository is not a scope.
      expect(panel.getAllByText('acme/api').length).toBeGreaterThan(0);
      expect(panel.getByText('Issue shaping')).toBeInTheDocument();
      expect(panel.getByText('Runner restart')).toBeInTheDocument();
    });

    it('renders a null failure rate as "No data", NEVER as 0%', async () => {
      // The whole point of #101's null handling. `failureRate: null` means no
      // actions have run; `0` would mean actions ran and all of them
      // succeeded. An operator reading one as the other draws the opposite
      // conclusion about whether the grant is safe to leave standing.
      render(<TrustPage />, { wrapperOptions: { user: mockAdminUser } });

      const panel = grantsPanel();
      await panel.findByText('Re-dispatch after transient failure');

      expect(panel.getByText('No data')).toBeInTheDocument();
      expect(panel.queryByText('0%')).not.toBeInTheDocument();
      expect(panel.queryByText('0.0%')).not.toBeInTheDocument();
    });

    it('renders a lapsed grant as LAPSED, not as a countdown', async () => {
      // `msUntilExpiry` is signed and goes negative once a grant has lapsed.
      // Formatting it with `Math.abs` — the reflex — would print "Expires in
      // 3h" over a grant that stopped authorizing three hours ago.
      render(<TrustPage />, { wrapperOptions: { user: mockAdminUser } });

      await grantsPanel().findByText('Re-dispatch after transient failure');
      fireEvent.click(screen.getByLabelText('Show ended grants'));

      const lapsed = await grantsPanel().findByText('Lapsed 3h ago');
      expect(lapsed).toBeInTheDocument();
      expect(
        grantsPanel().queryByText('Expires in 3h'),
      ).not.toBeInTheDocument();
    });

    it('marks the near-expiry and near-budget grants, and says how many', async () => {
      // Both flags come from the SERVER (`nearExpiry`, `nearBudget`) and are
      // never recomputed here. #101's second criterion is that these are
      // obvious at a glance, so they get an icon AND a banner AND a weight —
      // colour is never the only channel.
      render(<TrustPage />, { wrapperOptions: { user: mockAdminUser } });

      const panel = grantsPanel();
      await panel.findByText('Re-dispatch after transient failure');

      expect(panel.getByTestId('attention-banner')).toHaveTextContent(
        '2 active grants are near their expiry or their budget ceiling.',
      );
      expect(panel.getByTitle('Near expiry')).toBeInTheDocument();
      expect(panel.getByTitle('Near its budget ceiling')).toBeInTheDocument();
      expect(panel.getByText('Expires in 4h')).toBeInTheDocument();
      expect(panel.getByText('$2.00 of $25.00 left')).toBeInTheDocument();
    });

    it('does not mark a healthy grant', async () => {
      serveGrants(() => [FRESH]);
      render(<TrustPage />, { wrapperOptions: { user: mockAdminUser } });

      const panel = grantsPanel();
      await panel.findByText('Re-dispatch after transient failure');

      expect(panel.queryByTestId('attention-banner')).not.toBeInTheDocument();
      expect(panel.queryByTitle('Near expiry')).not.toBeInTheDocument();
    });

    it('toggles ended grants in and out, and asks the API for them', async () => {
      // #101's last criterion: revoked and expired grants remain auditable.
      // The default read is "what may run unattended right now", so they are
      // off until asked for — and the toggle has to reach the API, because the
      // server never sent the ended rows to be filtered client-side.
      render(<TrustPage />, { wrapperOptions: { user: mockAdminUser } });

      await grantsPanel().findByText('Re-dispatch after transient failure');
      expect(
        grantsPanel().queryByText('Dependency bump'),
      ).not.toBeInTheDocument();
      expect(
        grantQueries.every((query) => !query.includes('includeEnded')),
      ).toBe(true);

      fireEvent.click(screen.getByLabelText('Show ended grants'));
      await grantsPanel().findByText('Dependency bump');
      expect(
        grantQueries.some((query) => query.includes('includeEnded=true')),
      ).toBe(true);

      fireEvent.click(screen.getByLabelText('Show ended grants'));
      await waitFor(() =>
        expect(
          grantsPanel().queryByText('Dependency bump'),
        ).not.toBeInTheDocument(),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Revocation
  // -------------------------------------------------------------------------

  describe('revocation', () => {
    it('offers it to somebody holding trust:revoke, and calls the endpoint', async () => {
      const revoked = vi.fn();
      server.use(
        http.delete(`${API}/trust/grants/:id`, async ({ params, request }) => {
          revoked({
            id: params.id,
            body: await request.json().catch(() => null),
          });
          return HttpResponse.json({
            data: { ...FRESH, status: 'revoked' },
            meta: { timestamp: new Date().toISOString() },
          });
        }),
      );

      render(<TrustPage />, { wrapperOptions: { user: mockAdminUser } });
      await grantsPanel().findByText('Re-dispatch after transient failure');

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Row actions for Re-dispatch after transient failure',
        }),
      );
      fireEvent.click(screen.getByRole('menuitem', { name: 'Revoke' }));

      // A CONFIRM step, not a flow: one dialog, one button.
      const dialog = await screen.findByRole('dialog');
      expect(
        within(dialog).getByText(/no undo and no grace period/i),
      ).toBeInTheDocument();

      fireEvent.change(within(dialog).getByLabelText(/Why \(optional\)/i), {
        target: { value: 'Misfiring on the acme/api runner.' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));

      await waitFor(() =>
        expect(revoked).toHaveBeenCalledWith({
          id: 'g-fresh',
          body: { note: 'Misfiring on the acme/api runner.' },
        }),
      );
      expect(
        await screen.findByText(/Revoked, and recorded as yours\./),
      ).toBeInTheDocument();
    });

    it('sends no body at all when the operator writes no note', async () => {
      // The API's schema defaults to `{}` precisely so revoking without
      // explaining yourself is not a 400: the safe direction must never be
      // harder than granting.
      const revoked = vi.fn();
      server.use(
        http.delete(`${API}/trust/grants/:id`, async ({ request }) => {
          revoked(await request.text());
          return HttpResponse.json({
            data: { ...FRESH, status: 'revoked' },
            meta: { timestamp: new Date().toISOString() },
          });
        }),
      );

      render(<TrustPage />, { wrapperOptions: { user: mockAdminUser } });
      await grantsPanel().findByText('Re-dispatch after transient failure');

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Row actions for Re-dispatch after transient failure',
        }),
      );
      fireEvent.click(screen.getByRole('menuitem', { name: 'Revoke' }));
      fireEvent.click(
        within(await screen.findByRole('dialog')).getByRole('button', {
          name: 'Revoke',
        }),
      );

      await waitFor(() => expect(revoked).toHaveBeenCalledWith(''));
    });

    it('says "nothing was changed" when the grant had already ended', async () => {
      // A 409 is not a failure to apologise for — the grant authorizes
      // nothing, which is what the operator wanted — and the ORIGINAL end
      // reason is preserved deliberately.
      server.use(
        http.delete(`${API}/trust/grants/:id`, () =>
          HttpResponse.json(
            {
              statusCode: 409,
              code: 'CONFLICT',
              message: 'Trust grant g-fresh is already suspended.',
              details: { reason: 'already-ended', status: 'suspended' },
              timestamp: new Date().toISOString(),
              path: '/api/trust/grants/g-fresh',
            },
            { status: 409 },
          ),
        ),
      );

      render(<TrustPage />, { wrapperOptions: { user: mockAdminUser } });
      await grantsPanel().findByText('Re-dispatch after transient failure');

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Row actions for Re-dispatch after transient failure',
        }),
      );
      fireEvent.click(screen.getByRole('menuitem', { name: 'Revoke' }));
      fireEvent.click(
        within(await screen.findByRole('dialog')).getByRole('button', {
          name: 'Revoke',
        }),
      );

      expect(
        await screen.findByText(/It had already ended\. Nothing was changed\./),
      ).toBeInTheDocument();
    });

    it('withholds it from a viewer, and says which permission is missing', async () => {
      // The seeded viewer holds `trust:read` and NOT `trust:revoke`. The
      // action is DISABLED rather than absent: a row whose control silently
      // vanishes teaches nothing about why.
      render(<TrustPage />, { wrapperOptions: { user: mockUser } });
      await grantsPanel().findByText('Re-dispatch after transient failure');

      expect(screen.getAllByText(/trust:revoke/).length).toBeGreaterThan(0);

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Row actions for Re-dispatch after transient failure',
        }),
      );
      expect(screen.getByRole('menuitem', { name: 'Revoke' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });

    it('cannot revoke a grant that has already ended', async () => {
      render(<TrustPage />, { wrapperOptions: { user: mockAdminUser } });
      await grantsPanel().findByText('Re-dispatch after transient failure');
      fireEvent.click(screen.getByLabelText('Show ended grants'));
      await grantsPanel().findByText('Dependency bump');

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Row actions for Dependency bump',
        }),
      );
      expect(screen.getByRole('menuitem', { name: 'Revoke' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });
  });

  // -------------------------------------------------------------------------
  // The promotion ladder
  // -------------------------------------------------------------------------

  describe('the promotion ladder', () => {
    it('states prominently that the ladder is switched off', async () => {
      // It defaults off, so this is the COMMON case. A screen showing rungs
      // without saying so reads as a set of live conclusions when in fact
      // nothing has moved and nothing will.
      render(<TrustPage />, { wrapperOptions: { user: mockAdminUser } });
      fireEvent.click(screen.getByRole('tab', { name: 'Promotion ladder' }));

      const banner = await screen.findByTestId('ladder-disabled');
      expect(banner).toHaveTextContent('The promotion ladder is switched off.');
      expect(banner).toHaveTextContent(/Existing trust grants are unaffected/i);
      expect(
        ladderPanel().queryByTestId('ladder-enabled'),
      ).not.toBeInTheDocument();
    });

    it('says the ladder is on when it is', async () => {
      serveLadder(ladderFixture({ enabled: true }));
      render(<TrustPage />, { wrapperOptions: { user: mockAdminUser } });
      fireEvent.click(screen.getByRole('tab', { name: 'Promotion ladder' }));

      expect(await screen.findByTestId('ladder-enabled')).toHaveTextContent(
        'The promotion ladder is on.',
      );
      expect(
        ladderPanel().queryByTestId('ladder-disabled'),
      ).not.toBeInTheDocument();
    });

    it('renders `requirement` VERBATIM, character for character', async () => {
      // The API deliberately returns the policy layer's own sentence so this
      // app does not become a second implementation of the thresholds. It is
      // never parsed, never recomputed and never appended to.
      render(<TrustPage />, { wrapperOptions: { user: mockAdminUser } });
      fireEvent.click(screen.getByRole('tab', { name: 'Promotion ladder' }));

      await ladderPanel().findByText('Runner restart');
      const promoted = ladderPanel()
        .getAllByTestId('promotion-state')
        .find(
          (card) => card.getAttribute('data-action-class') === 'runner-restart',
        );
      expect(promoted).toBeDefined();

      const requirement = within(promoted!).getByTestId(
        'promotion-requirement',
      );
      expect(requirement).toHaveTextContent(PROMOTED_REQUIREMENT);
      // `textContent` exactly, not merely containing it: an appended "— 2 more
      // needed" would still satisfy `toHaveTextContent`.
      expect(requirement.textContent).toBe(PROMOTED_REQUIREMENT);
    });

    it('renders a null approval rate as no-evidence, NEVER as 0%', async () => {
      serveLadder(ladderFixture({ states: [OBSERVE_STATE] }));
      render(<TrustPage />, { wrapperOptions: { user: mockAdminUser } });
      fireEvent.click(screen.getByRole('tab', { name: 'Promotion ladder' }));

      await ladderPanel().findByText('Re-dispatch after transient failure');
      const card = ladderPanel().getByTestId('promotion-state');

      expect(within(card).getByTestId('approval-rate')).toHaveTextContent(
        'No evidence yet',
      );
      expect(within(card).getByTestId('sample-size')).toHaveTextContent(
        '0 decisions',
      );
      expect(within(card).queryByText('0%')).not.toBeInTheDocument();
    });

    it('shows the demotion count only when it is non-zero', async () => {
      render(<TrustPage />, { wrapperOptions: { user: mockAdminUser } });
      fireEvent.click(screen.getByRole('tab', { name: 'Promotion ladder' }));

      await ladderPanel().findByText('Runner restart');
      const cards = ladderPanel().getAllByTestId('promotion-state');
      const promoted = cards.find(
        (card) => card.getAttribute('data-action-class') === 'runner-restart',
      )!;
      const observe = cards.find(
        (card) => card.getAttribute('data-action-class') === 're-dispatch',
      )!;

      expect(within(promoted).getByTestId('demotion-count')).toHaveTextContent(
        'Demoted 3 times',
      );
      expect(
        within(observe).queryByTestId('demotion-count'),
      ).not.toBeInTheDocument();
    });

    it('says a forecast will not be acted on while the ladder is off', async () => {
      serveLadder(
        ladderFixture({
          states: [stateFixture({ rung: 'measure', wouldChange: 'promote' })],
        }),
      );
      render(<TrustPage />, { wrapperOptions: { user: mockAdminUser } });
      fireEvent.click(screen.getByRole('tab', { name: 'Promotion ladder' }));

      expect(await screen.findByTestId('would-change')).toHaveTextContent(
        'but it is switched off, so nothing will',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Manual demotion
  // -------------------------------------------------------------------------

  describe('manual demotion', () => {
    async function openLadderAndDemote() {
      fireEvent.click(screen.getByRole('tab', { name: 'Promotion ladder' }));
      await ladderPanel().findByText('Runner restart');
      fireEvent.click(
        ladderPanel().getByRole('button', { name: 'Demote this class' }),
      );
      fireEvent.click(
        within(await screen.findByRole('dialog')).getByRole('button', {
          name: 'Demote',
        }),
      );
    }

    it('tells the operator when the rung may be restored by the ladder', async () => {
      // TRUE is the COMMON case and the known limitation #101 names: the
      // suspension is durable, the rung is not. An operator not told this
      // would reasonably conclude the button did nothing.
      server.use(
        http.post(`${API}/promotion/states/:actionClass/demote`, () =>
          HttpResponse.json({
            data: {
              state: { ...PROMOTED_STATE, rung: 'measure' },
              grantsSuspended: 2,
              notified: true,
              rungMayBeRestoredByLadder: true,
            },
            meta: { timestamp: new Date().toISOString() },
          }),
        ),
      );

      render(<TrustPage />, { wrapperOptions: { user: mockAdminUser } });
      await openLadderAndDemote();

      const outcome = await screen.findByTestId('demotion-outcome');
      expect(outcome).toHaveTextContent('2 trust grants suspended.');
      expect(
        within(outcome).getByTestId('rung-may-be-restored'),
      ).toHaveTextContent(/next hourly evaluation is likely to put it back/i);
    });

    it('does not claim the rung may come back when the API says it will not', async () => {
      server.use(
        http.post(`${API}/promotion/states/:actionClass/demote`, () =>
          HttpResponse.json({
            data: {
              state: { ...PROMOTED_STATE, rung: 'measure' },
              grantsSuspended: 1,
              notified: true,
              rungMayBeRestoredByLadder: false,
            },
            meta: { timestamp: new Date().toISOString() },
          }),
        ),
      );

      render(<TrustPage />, { wrapperOptions: { user: mockAdminUser } });
      await openLadderAndDemote();

      const outcome = await screen.findByTestId('demotion-outcome');
      expect(outcome).toHaveTextContent('1 trust grant suspended.');
      expect(
        within(outcome).queryByTestId('rung-may-be-restored'),
      ).not.toBeInTheDocument();
    });

    it('reports a failed notification without pretending the demotion failed', async () => {
      server.use(
        http.post(`${API}/promotion/states/:actionClass/demote`, () =>
          HttpResponse.json({
            data: {
              state: { ...PROMOTED_STATE, rung: 'measure' },
              grantsSuspended: 1,
              notified: false,
              rungMayBeRestoredByLadder: false,
            },
            meta: { timestamp: new Date().toISOString() },
          }),
        ),
      );

      render(<TrustPage />, { wrapperOptions: { user: mockAdminUser } });
      await openLadderAndDemote();

      expect(await screen.findByTestId('demotion-outcome')).toHaveTextContent(
        /No notification was delivered/i,
      );
    });

    it('disables demotion for a viewer, and names the permission', async () => {
      render(<TrustPage />, { wrapperOptions: { user: mockUser } });
      fireEvent.click(screen.getByRole('tab', { name: 'Promotion ladder' }));
      await ladderPanel().findByText('Runner restart');

      expect(
        ladderPanel().getByRole('button', { name: 'Demote this class' }),
      ).toBeDisabled();
      expect(ladderPanel().getAllByText(/trust:revoke/).length).toBeGreaterThan(
        0,
      );
    });

    it('offers no demote control on a class that is not promoted', async () => {
      serveLadder(ladderFixture({ states: [OBSERVE_STATE] }));
      render(<TrustPage />, { wrapperOptions: { user: mockAdminUser } });
      fireEvent.click(screen.getByRole('tab', { name: 'Promotion ladder' }));

      await ladderPanel().findByText('Re-dispatch after transient failure');
      expect(
        ladderPanel().queryByRole('button', { name: 'Demote this class' }),
      ).not.toBeInTheDocument();
    });
  });
});
