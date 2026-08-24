import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import { ApprovalStatusChip } from '../../../components/approvals/ApprovalStatusChip';
import {
  APPROVAL_STATUS_DESCRIPTORS,
  isOpenApproval,
} from '../../../config/approvalStatus';
import { statusTokens } from '../../../theme/tokens';
import type { ApprovalStatus } from '../../../types/approvals';

const ALL_STATUSES = Object.keys(
  APPROVAL_STATUS_DESCRIPTORS,
) as ApprovalStatus[];

describe('ApprovalStatusChip', () => {
  it('renders icon AND text label for every status — colour is never the only channel', () => {
    for (const status of ALL_STATUSES) {
      const descriptor = APPROVAL_STATUS_DESCRIPTORS[status];
      const { unmount } = render(<ApprovalStatusChip status={status} />);

      const chip = document.querySelector(`[data-approval-status="${status}"]`);
      expect(chip, status).not.toBeNull();
      expect(screen.getByText(descriptor.label)).toBeInTheDocument();
      // The icon, as an SVG inside the chip. The rule this component exists to
      // enforce is icon + label + colour, always all three.
      expect(chip!.querySelector('svg'), status).not.toBeNull();

      unmount();
    }
  });

  it('gives every status a label distinct from every other', () => {
    // The reason the icon+label rule works at all: two statuses that share a
    // colour token (auto_denied and superseded do) must still be readable
    // apart without colour.
    const labels = ALL_STATUSES.map(
      (status) => APPROVAL_STATUS_DESCRIPTORS[status].label,
    );
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('paints from the shared status palette rather than a local hex', () => {
    for (const status of ALL_STATUSES) {
      const token = APPROVAL_STATUS_DESCRIPTORS[status].token;
      // No new hues: every approval status reuses one of the six run-status
      // tokens the palette already budgets for and asserts contrast on.
      expect(statusTokens.light[token]).toBeDefined();
      expect(statusTokens.dark[token]).toBeDefined();
    }
  });

  it('treats exactly pending and parked as still open', () => {
    // `parked` is NOT a resolution — it is `pending` with no timer — which is
    // why both are open and everything else is not.
    expect(ALL_STATUSES.filter(isOpenApproval)).toEqual(['pending', 'parked']);
  });
});
