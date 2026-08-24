import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { render, mockAdminUser, mockUser } from '../utils/test-utils';
import type { MockUser } from '../utils/test-utils';
import { server } from '../mocks/server';
import ApprovalDetailPage from '../../pages/ApprovalDetailPage';
import type { ActionClassEntry, ApprovalDetail } from '../../types/approvals';

/**
 * `/approvals/:id` — the one-tap surface (#98, epic #22).
 *
 * The assertions here are the ones VISION §8 turns on, and they are written as
 * PROPERTIES rather than as snapshots of copy: the four fields are present, a
 * parked approval has no countdown ELEMENT at all, an unknown cost never reads
 * as zero, and a refusal that recorded nothing says so. Every one of them is a
 * case where a plausible-looking screen would mislead the person deciding.
 */

const API = '*/api';
const APPROVAL_ID = '11111111-1111-4111-8111-111111111111';

const ELIGIBLE_CLASS: ActionClassEntry = {
  id: 're-dispatch',
  title: 'Re-dispatch after transient failure',
  definition:
    'Run the same work order again after a failure the supervisor believes was transient.',
  effect: 'A new run is dispatched against the same work order.',
  reversibility: 'reversible',
  autonomyEligible: true,
  hasProposer: true,
  spendsMoney: true,
};

const INELIGIBLE_CLASS: ActionClassEntry = {
  ...ELIGIBLE_CLASS,
  id: 'quarantine-decision',
  title: 'Quarantine decision',
  definition:
    'Decide whether a repeatedly failing work order stays quarantined.',
  effect: 'A quarantine is cleared or upheld.',
  reversibility: 'irreversible',
  autonomyEligible: false,
};

function approvalFixture(
  overrides: Partial<ApprovalDetail> = {},
): ApprovalDetail {
  return {
    id: APPROVAL_ID,
    actionClass: 're-dispatch',
    repositoryId: 'acme/api',
    proposalId: null,
    targetKind: 'work-order',
    targetRef: 'WO-42',
    summary: 'Re-dispatch work order WO-42 after a runner timeout.',
    reasoning:
      'The runner died 40 seconds in with no events; the same work order succeeded on its previous two attempts.',
    blastRadius:
      'One work order, one repository. A new branch and a new pull request if it succeeds.',
    effects: [
      { kind: 'dispatch', repository: 'acme/api', workOrder: 'WO-42' },
      { kind: 'spend', usd: 1.5 },
    ],
    estimatedCostUsd: 1.5,
    timeoutPolicy: 'auto_approve',
    timeoutAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    status: 'pending',
    decidedAt: null,
    decidedById: null,
    decidedVia: null,
    decisionNote: null,
    grantId: null,
    createdGrantId: null,
    escalationId: null,
    createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    actionClassEntry: ELIGIBLE_CLASS,
    ...overrides,
  };
}

function serveApproval(approval: ApprovalDetail) {
  server.use(
    http.get(`${API}/approvals/:id`, () =>
      HttpResponse.json({
        data: approval,
        meta: { timestamp: new Date().toISOString() },
      }),
    ),
  );
}

function renderDetail(user: MockUser = mockAdminUser) {
  return render(
    <Routes>
      <Route path="/approvals/:id" element={<ApprovalDetailPage />} />
    </Routes>,
    { wrapperOptions: { route: `/approvals/${APPROVAL_ID}`, user } },
  );
}

/** A contributor: may decide, may NOT mint a trust grant (`prisma/seed.ts`). */
const contributorUser: MockUser = {
  ...mockAdminUser,
  roles: [{ name: 'contributor' }],
  permissions: ['approvals:read', 'approvals:decide'],
};

describe('ApprovalDetailPage', () => {
  beforeEach(() => {
    serveApproval(approvalFixture());
  });

  describe('VISION §8: enough context to decide', () => {
    it('renders what, why, blast radius and what happens if ignored', async () => {
      renderDetail();

      // WHAT
      expect(
        await screen.findByText(
          'Re-dispatch work order WO-42 after a runner timeout.',
        ),
      ).toBeInTheDocument();
      // WHY
      expect(
        screen.getByText(/the runner died 40 seconds in/i),
      ).toBeInTheDocument();
      // BLAST RADIUS
      expect(
        screen.getByText(/one work order, one repository/i),
      ).toBeInTheDocument();
      // WHAT HAPPENS IF IGNORED
      expect(screen.getByText(/proceeds on its own/i)).toBeInTheDocument();

      // And the labels themselves, because the operator has to know which is
      // which without reading all four.
      expect(screen.getByText('What')).toBeInTheDocument();
      expect(screen.getByText('Why')).toBeInTheDocument();
      expect(screen.getByText('Blast radius')).toBeInTheDocument();
      expect(screen.getByText('What happens if ignored')).toBeInTheDocument();
    });

    it('shows the class title from the registry rather than the raw id', async () => {
      renderDetail();

      expect(
        await screen.findByRole('heading', {
          name: 'Re-dispatch after transient failure',
        }),
      ).toBeInTheDocument();
    });

    it('counts down when there really is a deadline', async () => {
      renderDetail();

      // The control for the assertion below: the countdown element exists when
      // the policy has a timer, so its ABSENCE for a parked approval is
      // meaningful rather than an artefact of the test setup.
      expect(
        await screen.findByTestId('approval-countdown'),
      ).toBeInTheDocument();
    });

    it('renders NO countdown for a parked approval and says there is no timer', async () => {
      serveApproval(
        approvalFixture({
          status: 'parked',
          timeoutPolicy: 'park_and_escalate',
          // Null EXACTLY here, and the null is the never-auto-approve
          // guarantee expressed as data.
          timeoutAt: null,
        }),
      );

      renderDetail();

      expect(
        await screen.findByText(/nothing happens until you answer/i),
      ).toBeInTheDocument();
      expect(screen.getByText(/there is no timer/i)).toBeInTheDocument();

      // The ABSENCE of the element, not merely the presence of the words. A
      // countdown slot rendering "—" still reads as a deadline whose value is
      // merely unknown, and an operator who believes a deadline exists will
      // let it lapse expecting something to happen. Nothing will.
      expect(
        screen.queryByTestId('approval-countdown'),
      ).not.toBeInTheDocument();
    });
  });

  describe('The facts below the fold', () => {
    it('renders an unknown estimated cost as "Unknown", never as $0.00', async () => {
      serveApproval(approvalFixture({ estimatedCostUsd: null }));

      renderDetail();

      expect(await screen.findByText('Unknown')).toBeInTheDocument();
      // Unknown and zero are different, and this one decides whether a budget
      // check can even run.
      expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
    });

    it('renders a real zero as $0.00, which is the opposite claim', async () => {
      serveApproval(approvalFixture({ estimatedCostUsd: 0 }));

      renderDetail();

      expect(await screen.findByText('$0.00')).toBeInTheDocument();
    });

    it('lists the declared effects and the class definition', async () => {
      renderDetail();

      expect(await screen.findByText('dispatch')).toBeInTheDocument();
      expect(screen.getByText(/workOrder: WO-42/)).toBeInTheDocument();
      expect(
        screen.getByText(/run the same work order again after a failure/i),
      ).toBeInTheDocument();
      expect(screen.getByText('work-order: WO-42')).toBeInTheDocument();
    });

    it('names the registry drift when the class is unrecognised', async () => {
      serveApproval(
        approvalFixture({
          status: 'parked',
          timeoutPolicy: 'park_and_escalate',
          timeoutAt: null,
          actionClass: 'invented-class',
          actionClassEntry: null,
        }),
      );

      renderDetail();

      // The alert's own sentence, not merely the words "does not recognise" —
      // the disabled "always approve" hint says something similar for a
      // different reason, and a test that cannot tell them apart is not
      // testing the drift case.
      expect(
        await screen.findByText(/unrecognised class is parked/i),
      ).toBeInTheDocument();
      // Falls back to the raw id as the heading rather than to "unknown
      // action": the id is the single most useful thing to show here.
      expect(
        screen.getByRole('heading', { name: 'invented-class' }),
      ).toBeInTheDocument();
    });
  });

  describe('The three actions', () => {
    it('offers all three to an admin holding trust:grant', async () => {
      renderDetail();

      expect(
        await screen.findByRole('button', { name: 'Approve' }),
      ).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled();
      expect(
        screen.getByRole('button', { name: 'Always approve this class' }),
      ).toBeEnabled();
    });

    it('does not offer "Always approve this class" for an ineligible class', async () => {
      serveApproval(
        approvalFixture({
          actionClass: 'quarantine-decision',
          actionClassEntry: INELIGIBLE_CLASS,
          timeoutPolicy: 'park_and_escalate',
          timeoutAt: null,
          status: 'parked',
        }),
      );

      renderDetail();

      const always = await screen.findByRole('button', {
        name: 'Always approve this class',
      });
      // The class can NEVER receive a grant, so the button cannot do what it
      // says. It stays visible with the reason attached rather than vanishing,
      // because "this class can never run unattended" is a fact about the
      // action being judged.
      expect(always).toBeDisabled();
      expect(screen.getByText(/can never run unattended/i)).toBeInTheDocument();
      // The single decision is still available.
      expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    });

    it('does not offer it to someone without trust:grant, and says why', async () => {
      renderDetail(contributorUser);

      const always = await screen.findByRole('button', {
        name: 'Always approve this class',
      });
      expect(always).toBeDisabled();
      expect(screen.getByText(/trust:grant/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    });

    it('offers a viewer no buttons at all and names the permission', async () => {
      renderDetail(mockUser);

      expect(await screen.findByText(/deciding needs/i)).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Approve' }),
      ).not.toBeInTheDocument();
    });

    it('sends the decision the operator tapped', async () => {
      const bodies: unknown[] = [];
      server.use(
        http.post(`${API}/approvals/:id/decide`, async ({ request }) => {
          bodies.push(await request.json());
          return HttpResponse.json({
            data: {
              approval: { ...approvalFixture(), status: 'approved' },
              createdGrantId: 'grant-1',
              grantSkippedReason: null,
              decidedAfterTimeout: false,
            },
            meta: { timestamp: new Date().toISOString() },
          });
        }),
      );

      const user = userEvent.setup();
      renderDetail();
      await user.click(
        await screen.findByRole('button', {
          name: 'Always approve this class',
        }),
      );

      await waitFor(() => expect(bodies).toHaveLength(1));
      expect(bodies[0]).toEqual({
        decision: 'approve',
        alwaysApproveThisClass: true,
      });
      expect(await screen.findByText(/recorded as yours/i)).toBeInTheDocument();
    });
  });

  describe('What happened to the decision', () => {
    it('says NOTHING WAS RECORDED on a trust-grant-required refusal', async () => {
      server.use(
        http.post(`${API}/approvals/:id/decide`, () =>
          HttpResponse.json(
            {
              statusCode: 403,
              code: 'FORBIDDEN',
              message:
                'Your decision on approval was NOT applied. "Always approve this class" mints a trust grant, which requires the "trust:grant" permission (admin). Nothing was recorded: the request is still open.',
              details: {
                reason: 'trust-grant-required',
                requiredPermission: 'trust:grant',
                decisionApplied: false,
              },
              timestamp: new Date().toISOString(),
              path: `/api/approvals/${APPROVAL_ID}/decide`,
            },
            { status: 403 },
          ),
        ),
      );

      const user = userEvent.setup();
      renderDetail();
      await user.click(
        await screen.findByRole('button', {
          name: 'Always approve this class',
        }),
      );

      // The operator tapped one button meaning "approve this AND stop asking
      // me". The whole request was refused, and they must not walk away
      // believing the approval went through.
      // The headline specifically. The API's own message says it too, and
      // both are shown — but the one the operator reads first is the title.
      expect(
        await screen.findByText(
          'Nothing was recorded. This approval is still open.',
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/nothing was recorded: the request is still open/i),
      ).toBeInTheDocument();
      // And the approval is still answerable without the flag.
      expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    });

    it('names WHICH conflict a 409 was', async () => {
      server.use(
        http.post(`${API}/approvals/:id/decide`, () =>
          HttpResponse.json(
            {
              statusCode: 409,
              code: 'CONFLICT',
              message:
                'Approval was already approved by another user at 2026-08-24T10:00:00.000Z. The first verdict stands.',
              details: {
                reason: 'already-decided-by-human',
                status: 'approved',
                decidedVia: 'human',
                decidedAt: '2026-08-24T10:00:00.000Z',
                decidedById: 'someone-else',
              },
              timestamp: new Date().toISOString(),
              path: `/api/approvals/${APPROVAL_ID}/decide`,
            },
            { status: 409 },
          ),
        ),
      );

      const user = userEvent.setup();
      renderDetail();
      await user.click(await screen.findByRole('button', { name: 'Approve' }));

      // A bare "conflict" cannot distinguish "somebody else answered this"
      // from "the clock answered it while you were typing", and those call for
      // completely different things from the operator.
      expect(
        await screen.findByText(/somebody else answered this first/i),
      ).toBeInTheDocument();
      expect(screen.getByText(/the first verdict stands/i)).toBeInTheDocument();
    });

    it('distinguishes a timeout conflict from another person and offers the next step', async () => {
      server.use(
        http.post(`${API}/approvals/:id/decide`, () =>
          HttpResponse.json(
            {
              statusCode: 409,
              code: 'CONFLICT',
              message:
                'Approval timed out and was auto-denied by its recorded policy.',
              details: { reason: 'already-timed-out' },
              timestamp: new Date().toISOString(),
              path: `/api/approvals/${APPROVAL_ID}/decide`,
            },
            { status: 409 },
          ),
        ),
      );

      const user = userEvent.setup();
      renderDetail();
      await user.click(await screen.findByRole('button', { name: 'Deny' }));

      expect(
        await screen.findByText(
          /the clock answered it while you were deciding/i,
        ),
      ).toBeInTheDocument();
      expect(screen.getByText(/can be raised again/i)).toBeInTheDocument();
    });

    it('surfaces grantSkippedReason when the flag produced no grant', async () => {
      server.use(
        http.post(`${API}/approvals/:id/decide`, () =>
          HttpResponse.json({
            data: {
              approval: { ...approvalFixture(), status: 'approved' },
              createdGrantId: null,
              grantSkippedReason:
                'No grant was created: this action class is not eligible for autonomy.',
              decidedAfterTimeout: false,
            },
            meta: { timestamp: new Date().toISOString() },
          }),
        ),
      );

      const user = userEvent.setup();
      renderDetail();
      await user.click(
        await screen.findByRole('button', {
          name: 'Always approve this class',
        }),
      );

      // A flag that quietly does nothing is how somebody comes to believe they
      // hold trust they do not.
      expect(
        await screen.findByText(/no trust grant was created/i),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/not eligible for autonomy/i),
      ).toBeInTheDocument();
    });

    it('says so when the verdict landed after the window had lapsed', async () => {
      server.use(
        http.post(`${API}/approvals/:id/decide`, () =>
          HttpResponse.json({
            data: {
              approval: { ...approvalFixture(), status: 'approved' },
              createdGrantId: null,
              grantSkippedReason: null,
              decidedAfterTimeout: true,
            },
            meta: { timestamp: new Date().toISOString() },
          }),
        ),
      );

      const user = userEvent.setup();
      renderDetail();
      await user.click(await screen.findByRole('button', { name: 'Approve' }));

      expect(
        await screen.findByText(/window had already closed/i),
      ).toBeInTheDocument();
    });
  });

  describe('An approval that is already resolved', () => {
    it('offers no buttons and says who resolved it', async () => {
      serveApproval(
        approvalFixture({
          status: 'auto_denied',
          decidedVia: 'timeout',
          decidedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        }),
      );

      renderDetail();

      expect(
        await screen.findByText(/nothing left to decide/i),
      ).toBeInTheDocument();
      expect(screen.getByText(/with nobody looking/i)).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Approve' }),
      ).not.toBeInTheDocument();
    });
  });

  describe('When the approval cannot be loaded', () => {
    it('shows the error rather than an empty screen', async () => {
      server.use(
        http.get(`${API}/approvals/:id`, () =>
          HttpResponse.json(
            {
              statusCode: 404,
              code: 'NOT_FOUND',
              message: 'Approval request not found',
              timestamp: new Date().toISOString(),
              path: `/api/approvals/${APPROVAL_ID}`,
            },
            { status: 404 },
          ),
        ),
      );

      renderDetail();

      const alert = await screen.findByRole('alert');
      expect(within(alert).getByText(/not found/i)).toBeInTheDocument();
    });
  });
});
