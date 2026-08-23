/**
 * Component tests — `StatusChip`.
 *
 * Epic #19. The suite exists to defend ONE rule, and it is a rule about code
 * rather than about pixels:
 *
 * > Every status carries icon + text label + color, always all three. Color is
 * > never the sole channel.
 *
 * The palette's colorblind safety is argued from that rule (see
 * `theme/tokens.ts`), so a variant that ever drops the label or the icon takes
 * the palette's justification with it. Hence the exhaustive pass over the
 * whole `RunStatus` union rather than a spot check: it is cheap, and a status
 * added later without an icon is exactly the regression that would otherwise
 * reach production looking fine.
 *
 * Rendered through MUI's `ThemeProvider` directly rather than through
 * `utils/test-utils`: this component's whole job is to resolve a token for the
 * CURRENT mode, and the shared wrapper mounts `ThemeContextProvider`, which
 * follows the system preference and cannot be pinned to dark from a test.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { ThemeProvider } from '@mui/material/styles';
import { StatusChip } from '../../../components/dashboard/StatusChip';
import { RUN_STATUS_DESCRIPTORS } from '../../../config/runStatus';
import { statusTokens } from '../../../theme/tokens';
import { lightTheme, darkTheme } from '../../../theme';
import { RUN_STATUSES } from '../../../types/cockpit';

const renderIn = (mode: 'light' | 'dark', ui: ReactElement) =>
  render(
    <ThemeProvider theme={mode === 'dark' ? darkTheme : lightTheme}>
      {ui}
    </ThemeProvider>,
  );

describe('StatusChip', () => {
  it.each([...RUN_STATUSES])(
    '%s: renders the label AND an icon, never colour alone',
    (status) => {
      const { container } = renderIn(
        'light',
        <StatusChip status={status} showTooltip={false} />,
      );

      const chip = container.querySelector('.MuiChip-root') as HTMLElement;
      expect(chip).not.toBeNull();
      expect(
        within(chip).getByText(RUN_STATUS_DESCRIPTORS[status].label),
      ).toBeInTheDocument();
      // MUI marks the icon slot with `.MuiChip-icon`. Its presence is the second
      // of the three channels; without it the chip is colour + text only, which
      // is not what the palette was justified on.
      expect(chip.querySelector('.MuiChip-icon')).not.toBeNull();
    },
  );

  it.each([...RUN_STATUSES])(
    '%s: exposes the status on a stable data attribute',
    (status) => {
      // Tests and future CSS hook on `data-status`, not on the label wording or
      // the colour — both of which are allowed to change.
      const { container } = renderIn(
        'light',
        <StatusChip status={status} showTooltip={false} />,
      );
      expect(
        container.querySelector(`[data-status="${status}"]`),
      ).not.toBeNull();
    },
  );

  it.each([...RUN_STATUSES])(
    '%s: paints from the light token in light mode',
    (status) => {
      const { container } = renderIn(
        'light',
        <StatusChip status={status} showTooltip={false} />,
      );
      const chip = container.querySelector('.MuiChip-root') as HTMLElement;
      const token = statusTokens.light[RUN_STATUS_DESCRIPTORS[status].token];
      const styles = getComputedStyle(chip);
      // jsdom normalises hex to `rgb()`, so compare through the computed style
      // rather than against the token string.
      expect(styles.color).toBe(hexToRgb(token.fg));
      expect(styles.backgroundColor).toBe(hexToRgb(token.surface));
      // The outline is the FULL foreground colour on purpose — it inherits the
      // same 4.5:1 floor as the label, so the chip's boundary can never be the
      // part that fails contrast while the text passes.
      expect(styles.borderColor).toBe(hexToRgb(token.fg));
    },
  );

  it.each([...RUN_STATUSES])(
    '%s: paints from the dark token in dark mode',
    (status) => {
      const { container } = renderIn(
        'dark',
        <StatusChip status={status} showTooltip={false} />,
      );
      const chip = container.querySelector('.MuiChip-root') as HTMLElement;
      const token = statusTokens.dark[RUN_STATUS_DESCRIPTORS[status].token];
      expect(getComputedStyle(chip).color).toBe(hexToRgb(token.fg));
    },
  );

  it('labels blocked and stalled differently — the distinction IS the point', () => {
    // VISION §9: `blocked` parks and auto-resumes, `stalled` must be killed.
    // Two states that look and read the same would undo the reason there are
    // two of them.
    const { unmount } = renderIn(
      'light',
      <StatusChip status="blocked" showTooltip={false} />,
    );
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    unmount();

    renderIn('light', <StatusChip status="stalled" showTooltip={false} />);
    expect(screen.getByText('Stalled')).toBeInTheDocument();
    expect(screen.queryByText('Blocked')).not.toBeInTheDocument();
  });

  it('keeps the label when the tooltip is suppressed', () => {
    // There is deliberately no prop that removes the label or the icon; the
    // only thing a caller may turn off is the hover explanation.
    renderIn('light', <StatusChip status="running" showTooltip={false} />);
    expect(screen.getByText('Running')).toBeInTheDocument();
  });
});

/** `#RRGGBB` -> the `rgb(r, g, b)` form jsdom reports from computed styles. */
function hexToRgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}
