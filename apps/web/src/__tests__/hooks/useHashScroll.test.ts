/**
 * `useHashScroll` — makes `/settings#theme` mean something.
 *
 * The bug this fixes was two bugs stacked: react-router v7 in declarative mode
 * does no hash scrolling at all, and `UserSettingsPage` returns a spinner until
 * settings resolve, so the anchor is not in the DOM at navigation time. The
 * anchor itself always existed. `ready` is what addresses the second half, and
 * the first two tests below are about exactly that ordering.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHookWithProviders } from '../utils/hook-utils';
import { useHashScroll } from '../../hooks/useHashScroll';

/** Puts a real anchor in the document for the hook to find. */
function mountTarget(
  id: string,
  attributes: Record<string, string> = {},
): HTMLElement {
  const element = document.createElement('div');
  element.id = id;
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  document.body.appendChild(element);
  return element;
}

const scrollIntoView = vi.fn();
const originalMatchMedia = window.matchMedia;

describe('useHashScroll', () => {
  beforeEach(() => {
    // jsdom does not implement `scrollIntoView`; the hook optional-calls it so
    // it degrades, but the assertions need something to observe.
    Element.prototype.scrollIntoView = scrollIntoView;
    scrollIntoView.mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    window.matchMedia = originalMatchMedia;
  });

  it('does nothing while the page is not ready', () => {
    const target = mountTarget('theme');

    renderHookWithProviders(() => useHashScroll(false), {
      wrapperOptions: { route: '/settings#theme' },
    });

    // The whole reason the hook takes `ready`: firing before the content
    // mounts is not "early", it is a guaranteed miss.
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(target);
  });

  it('scrolls to and focuses the target once ready', () => {
    const target = mountTarget('theme');

    renderHookWithProviders(() => useHashScroll(true), {
      wrapperOptions: { route: '/settings#theme' },
    });

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    // Focus, not just scroll. Moving the viewport moves the sighted reader and
    // nobody else; without this a keyboard user following the link lands with
    // their next Tab still at the top of the page.
    expect(document.activeElement).toBe(target);
  });

  it('makes a non-focusable target programmatically focusable without adding it to the tab order', () => {
    const target = mountTarget('theme');

    renderHookWithProviders(() => useHashScroll(true), {
      wrapperOptions: { route: '/settings#theme' },
    });

    expect(target.getAttribute('tabindex')).toBe('-1');
  });

  it('leaves an existing tabindex alone', () => {
    const target = mountTarget('theme', { tabindex: '0' });

    renderHookWithProviders(() => useHashScroll(true), {
      wrapperOptions: { route: '/settings#theme' },
    });

    expect(target.getAttribute('tabindex')).toBe('0');
  });

  it('does nothing when there is no hash', () => {
    mountTarget('theme');

    renderHookWithProviders(() => useHashScroll(true), {
      wrapperOptions: { route: '/settings' },
    });

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('degrades quietly when the hash names nothing', () => {
    // Anchors get renamed and old links should degrade to "you are on the
    // right page", not to a crash.
    expect(() =>
      renderHookWithProviders(() => useHashScroll(true), {
        wrapperOptions: { route: '/settings#does-not-exist' },
      }),
    ).not.toThrow();

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('decodes a percent-encoded fragment', () => {
    const target = mountTarget('personal access tokens');

    renderHookWithProviders(() => useHashScroll(true), {
      wrapperOptions: { route: '/settings#personal%20access%20tokens' },
    });

    expect(document.activeElement).toBe(target);
  });

  it('falls back to the raw fragment when it cannot be decoded', () => {
    const target = mountTarget('100%');

    renderHookWithProviders(() => useHashScroll(true), {
      wrapperOptions: { route: '/settings#100%' },
    });

    expect(document.activeElement).toBe(target);
  });

  describe('reduced motion', () => {
    it('animates by default', () => {
      mountTarget('theme');

      renderHookWithProviders(() => useHashScroll(true), {
        wrapperOptions: { route: '/settings#theme' },
      });

      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: 'smooth',
        block: 'start',
      });
    });

    it('jumps when the user has asked for reduced motion', () => {
      // The preference has to reach the IMPERATIVE call; a CSS
      // `scroll-behavior` rule would not cover `scrollIntoView`.
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
        onchange: null,
      })) as unknown as typeof window.matchMedia;

      mountTarget('theme');

      renderHookWithProviders(() => useHashScroll(true), {
        wrapperOptions: { route: '/settings#theme' },
      });

      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: 'auto',
        block: 'start',
      });
    });
  });
});
