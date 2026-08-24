import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, within } from '@testing-library/react';

import { render, mockAdminUser, mockUser } from '../utils/test-utils';
import { server } from '../mocks/server';
import {
  installLayoutStubs,
  setInitialContainerWidth,
} from '../../components/datatable/__tests__/testUtils/layoutStubs';
import ApprovalsPage from '../../pages/ApprovalsPage';
import type { ApprovalListItem } from '../../types/approvals';

/**
 * `/approvals` — the triage view (#98, epic #22).
 *
 * Rendered at a phone-width CONTAINER so the DataTable resolves to its card
 * renderer: cards are one DOM node per row, which makes the ordering assertion
 * below an assertion about ROWS rather than about a virtualized grid's
 * viewport. The layout stubs are the shared #253 recipe; jsdom performs no
 * layout, so without them the container measures 0.
 */

const API = '*/api';
const CARD_WIDTH = 400;

function approvalFixture(
  overrides: Partial<ApprovalListItem> = {},
): ApprovalListItem {
  return {
    id: 'a1',
    actionClass: 're-dispatch',
    actionClassTitle: 'Re-dispatch after transient failure',
    repositoryId: 'acme/api',
    proposalId: null,
    targetKind: 'work-order',
    targetRef: 'WO-1',
    summary: 'Re-dispatch WO-1.',
    reasoning: 'The runner died with no events.',
    blastRadius: 'One work order.',
    effects: [{ kind: 'dispatch', repository: 'acme/api', workOrder: 'WO-1' }],
    estimatedCostUsd: 1,
    timeoutPolicy: 'auto_approve',
    timeoutAt: new Date(Date.now() + 3_600_000).toISOString(),
    status: 'pending',
    decidedAt: null,
    decidedById: null,
    decidedVia: null,
    decisionNote: null,
    grantId: null,
    createdGrantId: null,
    escalationId: null,
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    ...overrides,
  };
}

/**
 * Three open approvals in the order the API returns them: OLDEST FIRST.
 *
 * Deliberately NOT in newest-first order, so a page that re-sorted by
 * `createdAt` descending — the reflex for a list of things that arrived —
 * would visibly reverse it.
 */
const QUEUE: ApprovalListItem[] = [
  approvalFixture({
    id: 'oldest',
    summary: 'Oldest: re-dispatch WO-1.',
    createdAt: new Date(Date.now() - 6 * 3_600_000).toISOString(),
  }),
  approvalFixture({
    id: 'middle',
    summary: 'Middle: shape issue #17.',
    actionClass: 'issue-shaping',
    actionClassTitle: 'Issue shaping',
    createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  }),
  approvalFixture({
    id: 'newest',
    summary: 'Newest: clear the quarantine on WO-9.',
    actionClass: 'quarantine-decision',
    actionClassTitle: 'Quarantine decision',
    status: 'parked',
    timeoutPolicy: 'park_and_escalate',
    timeoutAt: null,
    createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  }),
];

function serveQueue(queue: ApprovalListItem[]) {
  server.use(
    http.get(`${API}/approvals`, () =>
      HttpResponse.json({
        data: queue,
        meta: { timestamp: new Date().toISOString() },
      }),
    ),
  );
}

describe('ApprovalsPage', () => {
  beforeAll(() => {
    installLayoutStubs();
  });

  beforeEach(() => {
    setInitialContainerWidth(CARD_WIDTH);
    serveQueue(QUEUE);
  });

  it('keeps the server order — oldest first, never re-sorted', async () => {
    render(<ApprovalsPage />, { wrapperOptions: { user: mockAdminUser } });

    await screen.findByText('Oldest: re-dispatch WO-1.');
    const cards = screen.getAllByTestId('datatable-card');

    expect(cards).toHaveLength(3);
    // The oldest open approval is the one that has been ignored longest, which
    // is the single fact this queue exists to surface. Sorting it any other
    // way buries it.
    expect(within(cards[0]).getByText(/^Oldest:/)).toBeInTheDocument();
    expect(within(cards[1]).getByText(/^Middle:/)).toBeInTheDocument();
    expect(within(cards[2]).getByText(/^Newest:/)).toBeInTheDocument();
  });

  it('offers no sortable control, because the endpoint has no sort parameter', async () => {
    render(<ApprovalsPage />, { wrapperOptions: { user: mockAdminUser } });

    await screen.findByText('Oldest: re-dispatch WO-1.');

    // The card renderer draws a sort control only when some column declares
    // itself sortable. A header that re-sorted the PAGE would look live and
    // quietly lie about the queue.
    expect(screen.queryByTestId('datatable-card-sort')).not.toBeInTheDocument();
  });

  it('shows what happens if each row is ignored, in its short form', async () => {
    render(<ApprovalsPage />, { wrapperOptions: { user: mockAdminUser } });

    await screen.findByText('Oldest: re-dispatch WO-1.');

    expect(screen.getAllByText('Proceeds on its own')).toHaveLength(2);
    expect(screen.getByText('Nothing happens — no timer')).toBeInTheDocument();
  });

  it('renders no countdown at all on a parked row', async () => {
    render(<ApprovalsPage />, { wrapperOptions: { user: mockAdminUser } });

    await screen.findByText('Newest: clear the quarantine on WO-9.');
    const parked = screen
      .getAllByTestId('datatable-card')
      .find((card) => within(card).queryByText(/^Newest:/) !== null)!;

    // Two timed rows have countdowns; the parked row has NONE — not an em
    // dash, not a disabled timer. It says "No timer" in words instead.
    expect(screen.getAllByTestId('approval-countdown')).toHaveLength(2);
    expect(
      within(parked).queryByTestId('approval-countdown'),
    ).not.toBeInTheDocument();
    expect(within(parked).getByText('No timer')).toBeInTheDocument();
  });

  it('links each row to its own one-tap screen, named by the class TITLE', async () => {
    // The title is joined by the API (`actionClassTitle`), not by a taxonomy
    // this app keeps: a second copy here is the drift ADR-0011 exists to
    // prevent, which is why the queue used to show bare ids.
    render(<ApprovalsPage />, { wrapperOptions: { user: mockAdminUser } });

    expect(
      await screen.findByRole('link', { name: 'Issue shaping' }),
    ).toHaveAttribute('href', '/approvals/middle');
  });

  it('falls back to the class id when the server sent no title', async () => {
    // A null title means the REGISTRY did not recognise the class, and the API
    // sends null rather than dressing the id up as a title so that drift stays
    // visible. Not a defensive case: an unknown class parks (ADR-0014). The
    // row still has to render, and it renders the id rather than an empty link.
    serveQueue([
      approvalFixture({
        id: 'drifted',
        actionClass: 'invented-class',
        actionClassTitle: null,
        summary: 'Something the registry has never heard of.',
        status: 'parked',
        timeoutPolicy: 'park_and_escalate',
        timeoutAt: null,
      }),
    ]);

    render(<ApprovalsPage />, { wrapperOptions: { user: mockAdminUser } });

    expect(
      await screen.findByRole('link', { name: 'invented-class' }),
    ).toHaveAttribute('href', '/approvals/drifted');
  });

  it('tells a viewer they may read the queue but not answer it', async () => {
    // A seeded viewer holds `approvals:read` and NOT `approvals:decide`: they
    // may see what is waiting and answer nothing.
    render(<ApprovalsPage />, { wrapperOptions: { user: mockUser } });

    expect(await screen.findByText(/but not answer it/i)).toBeInTheDocument();
  });

  it('says nothing is waiting rather than showing a spinner forever', async () => {
    serveQueue([]);

    render(<ApprovalsPage />, { wrapperOptions: { user: mockAdminUser } });

    expect(
      await screen.findByText(/nothing is waiting on you/i),
    ).toBeInTheDocument();
  });

  it('surfaces a failed load instead of an empty table', async () => {
    server.use(
      http.get(`${API}/approvals`, () =>
        HttpResponse.json(
          {
            statusCode: 500,
            code: 'INTERNAL_SERVER_ERROR',
            message: 'The approval queue could not be read',
            timestamp: new Date().toISOString(),
            path: '/api/approvals',
          },
          { status: 500 },
        ),
      ),
    );

    render(<ApprovalsPage />, { wrapperOptions: { user: mockAdminUser } });

    expect(
      await screen.findByText('The approval queue could not be read'),
    ).toBeInTheDocument();
  });
});
