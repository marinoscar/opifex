import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import {
  approvalColumns,
  TABLE_ID,
} from '../../../components/approvals/approvalListColumns';
import { OPEN_APPROVAL_STATUSES } from '../../../types/approvals';
import type { Approval } from '../../../types/approvals';

/**
 * The column contract for `/approvals` (#98).
 *
 * Asserted without mounting the page, which is why the columns live in their
 * own module: this is the table's public shape, read by both renderers, the
 * CSV export and these tests.
 */

function approvalFixture(overrides: Partial<Approval> = {}): Approval {
  return {
    id: 'a1',
    actionClass: 're-dispatch',
    repositoryId: 'acme/api',
    proposalId: null,
    targetKind: null,
    targetRef: null,
    summary: 'Re-dispatch WO-1.',
    reasoning: 'Because.',
    blastRadius: 'One work order.',
    effects: [],
    estimatedCostUsd: null,
    timeoutPolicy: 'auto_approve',
    timeoutAt: '2099-01-01T00:00:00.000Z',
    status: 'pending',
    decidedAt: null,
    decidedById: null,
    decidedVia: null,
    decisionNote: null,
    grantId: null,
    createdGrantId: null,
    escalationId: null,
    createdAt: '2026-08-24T09:00:00.000Z',
    updatedAt: '2026-08-24T09:00:00.000Z',
    ...overrides,
  };
}

const byId = () =>
  Object.fromEntries(approvalColumns().map((column) => [column.id, column]));

describe('approvalColumns', () => {
  it('keeps a storage key that does not track the heading', () => {
    expect(TABLE_ID).toBe('approvals-queue');
  });

  it('declares NO sortable column, because the endpoint has no sort parameter', () => {
    // The queue is oldest first by contract. A sortable header could only
    // re-sort the page in the browser, which is a control that looks live and
    // quietly lies about the queue.
    expect(approvalColumns().filter((column) => column.sortable)).toEqual([]);
  });

  it('declares filterable ONLY on status, the closed set the API pins', () => {
    const filterable = approvalColumns()
      .filter((column) => column.filterable)
      .map((column) => column.id);

    expect(filterable).toEqual(['status']);
    expect(byId().status.enumValues?.map((option) => option.value)).toEqual([
      ...OPEN_APPROVAL_STATUSES,
    ]);
  });

  it('does not offer an actionClass filter it cannot enumerate honestly', () => {
    // The accepted values are the ADR-0011 registry ids, and no endpoint
    // exposes that registry to a browser. A hand-copied list here would be the
    // drift the registry exists to prevent, and a typo would answer 400.
    expect(byId().actionClass.filterable).toBeUndefined();
  });

  it('exports the scalar behind each cell, not the rendered node', () => {
    const approval = approvalFixture();

    expect(byId().summary.value!(approval)).toBe('Re-dispatch WO-1.');
    expect(byId().createdAt.value!(approval)).toBe('2026-08-24T09:00:00.000Z');
    // The CSV carries "Unknown" rather than an empty cell for a cost nobody
    // could estimate: an empty cell reads as zero in a spreadsheet.
    expect(byId().estimatedCostUsd.value!(approval)).toBe('Unknown');
    expect(byId().ifIgnored.value!(approval)).toBe('Proceeds on its own');
  });

  it('renders the detail columns rather than leaving them blank', () => {
    const approval = approvalFixture();

    render(<>{byId().estimatedCostUsd.render!(approval)}</>);
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('renders the words "No timer" instead of a countdown for a parked row', () => {
    const parked = approvalFixture({
      status: 'parked',
      timeoutPolicy: 'park_and_escalate',
      timeoutAt: null,
    });

    render(<>{byId().timeRemaining.render!(parked)}</>);

    expect(screen.getByText('No timer')).toBeInTheDocument();
    expect(screen.queryByTestId('approval-countdown')).not.toBeInTheDocument();
  });

  it('renders a countdown for a row that really has a deadline', () => {
    render(<>{byId().timeRemaining.render!(approvalFixture())}</>);

    expect(screen.getByTestId('approval-countdown')).toBeInTheDocument();
  });

  it('renders the waiting age, and an em dash for an unparseable one', () => {
    render(
      <>
        {byId().createdAt.render!(approvalFixture({ createdAt: 'nonsense' }))}
      </>,
    );

    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders the if-ignored short form per policy', () => {
    render(
      <>
        {byId().ifIgnored.render!(
          approvalFixture({
            timeoutPolicy: 'deny',
            timeoutAt: '2099-01-01T00:00:00.000Z',
          }),
        )}
      </>,
    );

    expect(
      screen.getByText('Refused; can be raised again'),
    ).toBeInTheDocument();
  });
});
