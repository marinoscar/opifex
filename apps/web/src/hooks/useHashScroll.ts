/**
 * Make `#fragment` URLs work.
 *
 * Issue #78, epic #19. `/settings#theme` was a dead link, and the cause was
 * two bugs stacked, neither of which is the one people assume:
 *
 *  1. **The anchor exists.** `components/settings/ThemeSettings.tsx` renders
 *     `<Card id="theme">` and always has. Adding an anchor was never the fix.
 *  2. **react-router v7 in declarative mode does no hash scrolling at all.**
 *     The browser only scrolls to a fragment on a real document load; a
 *     client-side navigation that changes `location.hash` is just a state
 *     update, and nothing in the router acts on it.
 *  3. **The target is not in the DOM at navigation time.** `UserSettingsPage`
 *     returns `<LoadingSpinner />` until settings resolve, so even a browser
 *     that did scroll would find nothing to scroll to. This is why the hook
 *     takes `ready` rather than firing on mount: it must run on the render
 *     where the content actually exists.
 *
 * Kept even though `QuickActions` — its only would-be caller before this
 * change — is deleted with the dashboard rewrite. `/settings#theme` is a
 * legitimate URL to bookmark, paste into a chat, or link from documentation,
 * and it should work regardless of who links to it.
 *
 * ## Accessibility, and why scrolling alone is not enough
 *
 * Moving the viewport moves the SIGHTED reader. It does nothing for keyboard
 * focus or for a screen reader's reading cursor, so without the `focus()` call
 * below a keyboard user following `#theme` lands looking at the theme card
 * with their next Tab still going to the top of the page. Focusing the target
 * is what makes the fragment mean the same thing for everyone — which is
 * exactly what a real document load would have done.
 *
 * `preventScroll: true` because the `scrollIntoView` above already positioned
 * it; letting focus scroll again would fight the smooth animation.
 */

import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

export function useHashScroll(ready: boolean): void {
  const { hash } = useLocation();

  useEffect(() => {
    // `ready` is the caller's promise that the anchor's content is mounted.
    // Firing before it is not "early", it is a guaranteed miss.
    if (!ready || !hash) return;

    // Fragments are percent-encoded in the address bar; `getElementById` wants
    // the decoded form. A malformed escape throws rather than returning the
    // input, so fall back to the raw text instead of taking the page down over
    // a bad URL.
    let id: string;
    try {
      id = decodeURIComponent(hash.slice(1));
    } catch {
      id = hash.slice(1);
    }
    if (!id) return;

    const target = document.getElementById(id);
    // A hash naming nothing is not an error worth reporting. Anchors get
    // renamed, and old links should degrade to "you are on the right page".
    if (!target) return;

    // Honoured explicitly rather than through a CSS `scroll-behavior`, because
    // the reduced-motion preference has to reach the imperative call. `?.` for
    // environments without `matchMedia`.
    const prefersReducedMotion =
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    // Optional-called: jsdom does not implement `scrollIntoView`, and a test
    // asserting the focus behaviour should not have to stub the scroll.
    target.scrollIntoView?.({
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
      block: 'start',
    });

    // The target is usually a Card or a section — not focusable by default, so
    // `focus()` would silently do nothing. `tabindex="-1"` makes it
    // PROGRAMMATICALLY focusable without adding it to the tab order, which is
    // the standard "skip link target" treatment. Applied here rather than
    // required of every anchor so that adding an anchor stays a one-attribute
    // change (`id="…"`) and cannot be half-done.
    if (!target.hasAttribute('tabindex')) {
      target.setAttribute('tabindex', '-1');
    }
    target.focus({ preventScroll: true });
  }, [hash, ready]);
}
