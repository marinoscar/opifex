import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen } from '@testing-library/react';
import { render, mockUser } from '../../utils/test-utils';
import { setViewportWidth } from '../../setup';
import { Layout } from '../../../components/common/Layout';

/**
 * Rewritten wholesale for issue #55. Most of what this file used to assert
 * described `sidebarOpen` state, an `onMenuClick` prop and a drawer close
 * handler — none of which exist any more, because the drawer they belonged to
 * is gone from every breakpoint.
 *
 * What replaces it is the invariant that actually matters and that nothing
 * else enforces: **exactly one navigation surface at every width.** The rail's
 * `up('sm')` gate and the bottom bar's `down('sm')` gate are hand-kept
 * complements, so a test is the only thing standing between a one-line
 * breakpoint edit and a band with two navs — or none.
 */

vi.mock('../../../components/navigation/AppBar', () => ({
  AppBar: vi.fn(() => <div data-testid="mock-appbar" />),
}));

vi.mock('../../../components/navigation/NavigationRail', () => ({
  NavigationRail: vi.fn(() => <div data-testid="mock-rail" />),
}));

vi.mock('../../../components/navigation/BottomNav', () => ({
  BottomNav: vi.fn(() => <div data-testid="mock-bottom-nav" />),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    Outlet: vi.fn(() => <div data-testid="outlet-content">Page Content</div>),
  };
});

import { AppBar } from '../../../components/navigation/AppBar';
import { Outlet } from 'react-router-dom';

/** Renders at `px`, driving the query-aware matchMedia mock. */
function renderAt(px: number) {
  setViewportWidth(px);
  return render(<Layout />);
}

/**
 * The emotion rules emitted for `element`, joined into one string.
 *
 * Needed because jsdom's getComputedStyle ignores `@media` blocks entirely, so
 * a responsive `sx` value cannot be read back off the element.
 */
function emittedRulesFor(element: Element): string {
  const emotionClass = [...element.classList].find((name) => name.startsWith('css-'));
  expect(emotionClass, 'element carries no emotion class').toBeDefined();

  return [...document.querySelectorAll('style')]
    .map((style) => style.textContent ?? '')
    .join('')
    .split('}}')
    .filter((block) => block.includes(`.${emotionClass}{`))
    .join('}}');
}

const PHONE = 375;
const TABLET = 800;
const DESKTOP = 1400;

describe('Layout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Exactly one navigation surface', () => {
    it.each([
      ['phone', PHONE, 'mock-bottom-nav', 'mock-rail'],
      ['tablet', TABLET, 'mock-rail', 'mock-bottom-nav'],
      ['desktop', DESKTOP, 'mock-rail', 'mock-bottom-nav'],
    ])('mounts one surface and only one at %s width', (_label, width, present, absent) => {
      renderAt(width);

      expect(screen.getByTestId(present)).toBeInTheDocument();
      expect(screen.queryByTestId(absent)).not.toBeInTheDocument();
    });

    it('never mounts both, and never mounts neither, across the sm boundary', async () => {
      // Walks the exact pixels either side of 600 — the seam where a drifted
      // gate would show up and nowhere else.
      renderAt(PHONE);

      for (const width of [375, 599, 600, 601, 900, 1200, 1400]) {
        await act(async () => setViewportWidth(width));

        const surfaces = [
          screen.queryByTestId('mock-rail'),
          screen.queryByTestId('mock-bottom-nav'),
        ].filter(Boolean);

        expect(surfaces, `${width}px should have exactly one navigation surface`).toHaveLength(1);
      }
    });

    it('swaps the bottom bar for the rail at exactly 600px', async () => {
      // 600 is Material 3's compact/medium boundary. At 599 a phone treatment;
      // at 600 a tablet in portrait gets the rail rather than a phone bar.
      renderAt(599);
      expect(screen.getByTestId('mock-bottom-nav')).toBeInTheDocument();

      await act(async () => setViewportWidth(600));
      expect(screen.getByTestId('mock-rail')).toBeInTheDocument();
      expect(screen.queryByTestId('mock-bottom-nav')).not.toBeInTheDocument();
    });
  });

  describe('Main content area', () => {
    it('renders the Outlet inside a <main> element', () => {
      renderAt(DESKTOP);

      const main = screen.getByTestId('outlet-content').closest('main');
      expect(main).toBeInTheDocument();
      expect(vi.mocked(Outlet)).toHaveBeenCalled();
    });

    it('sets minWidth: 0 on <main>', () => {
      // Load-bearing: a flex item's min-width defaults to `auto` (its
      // min-content width), so without this a wide descendant — a DataTable,
      // a long unbroken string — widens the whole shell past the viewport.
      renderAt(DESKTOP);

      const main = screen.getByTestId('outlet-content').closest('main')!;
      expect(getComputedStyle(main).minWidth).toBe('0px');
    });

    it('sets minWidth: 0 on the flex row that holds the rail and main', () => {
      renderAt(DESKTOP);

      const row = screen.getByTestId('outlet-content').closest('main')!.parentElement!;
      expect(getComputedStyle(row).display).toBe('flex');
      expect(getComputedStyle(row).minWidth).toBe('0px');
    });

    it('clears the fixed bottom bar below sm and drops that padding at sm', () => {
      // Asserted against the EMITTED RULES rather than getComputedStyle: jsdom
      // does not evaluate `@media` conditions, so a computed read would report
      // whichever rule happened to be last and silently pass either way. The
      // rules are also the thing the invariant is actually about — the `sm` in
      // this pb must be the same 600px `BottomNav` gates on, or the padding
      // outlives the bar it was clearing.
      renderAt(PHONE);

      const main = screen.getByTestId('outlet-content').closest('main')!;
      const rules = emittedRulesFor(main);

      // pb: 10 → 80px, which clears the fixed BottomNav's height.
      expect(rules).toMatch(/@media \(min-width:0px\)\{[^}]*padding-bottom:80px/);
      // pb: 3 → 24px at sm and up, matching the other three sides.
      expect(rules).toMatch(/@media \(min-width:600px\)\{[^}]*padding-bottom:24px/);
    });
  });

  describe('Shell', () => {
    it('renders the AppBar with no props at all', () => {
      // `onMenuClick` is gone from the interface, not merely unused — a
      // dangling optional handler is how a dead affordance survives a refactor.
      renderAt(DESKTOP);

      expect(screen.getByTestId('mock-appbar')).toBeInTheDocument();
      expect(vi.mocked(AppBar)).toHaveBeenCalledWith({}, undefined);
    });

    it('owns viewport height so pages do not have to', () => {
      const { container } = renderAt(DESKTOP);

      const shell = container.firstChild as HTMLElement;
      expect(getComputedStyle(shell).minHeight).toBe('100vh');
      expect(getComputedStyle(shell).flexDirection).toBe('column');
    });
  });

  describe('Integration', () => {
    it('renders for an authenticated user', () => {
      setViewportWidth(DESKTOP);
      render(<Layout />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(screen.getByTestId('mock-appbar')).toBeInTheDocument();
      expect(screen.getByTestId('outlet-content')).toBeInTheDocument();
    });

    it.each([['light'], ['dark']] as const)('renders with the %s theme', (theme) => {
      setViewportWidth(DESKTOP);
      render(<Layout />, { wrapperOptions: { theme } });

      expect(screen.getByTestId('mock-appbar')).toBeInTheDocument();
      expect(screen.getByTestId('outlet-content')).toBeInTheDocument();
    });
  });
});
