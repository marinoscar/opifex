/**
 * DataTable test suites — shared jsdom layout stub recipe.
 *
 * jsdom performs no real layout, so both the container-width hook
 * (`useContainerLayout.ts`) and MUI X's own row virtualizer would otherwise
 * measure a 0×0 viewport. This module is the "#253 recipe" (first written for
 * `ResponsiveDataTable.test.tsx`, extended in `DataTableExport.test.tsx` for
 * card-height measurement) as one reusable, documented module — issue #257's
 * shared conformance suite is built on it, and it is safe for any future
 * DataTable test file to import instead of re-deriving its own copy.
 *
 * `window.matchMedia` is pinned to a FIXED 1440px viewport, so every viewport
 * media query in the tree answers "desktop" — the only way a `mobile` layout
 * result can be trusted to have come from the CONTAINER measurement rather
 * than an accidental viewport match (the drawer case, issue #261).
 */

import { vi } from 'vitest';
import { act } from '@testing-library/react';

export const VIEWPORT_WIDTH = 1440;
export const VIEWPORT_HEIGHT = 900;
/** A card reports a card-sized height so a "measured placeholder" assertion
 * measures something real rather than the stubbed viewport. */
export const CARD_HEIGHT = 220;

/** Mutated by {@link setContainerWidth}; read by every stubbed geometry getter. */
export let containerWidth = 1400;

interface FakeObserver {
  targets: Set<Element>;
  fire: () => void;
}

const observers = new Set<FakeObserver>();

/**
 * Install the geometry + ResizeObserver + matchMedia stubs onto the shared
 * jsdom globals. Call once, in a `beforeAll`.
 */
export function installLayoutStubs(): void {
  for (const prop of ['clientWidth', 'offsetWidth', 'scrollWidth'] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get: () => containerWidth,
    });
  }
  for (const prop of ['clientHeight', 'offsetHeight', 'scrollHeight'] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get: () => VIEWPORT_HEIGHT,
    });
  }

  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(
    this: HTMLElement,
  ) {
    const isCard = this.getAttribute?.('data-testid') === 'datatable-card';
    const height = isCard ? CARD_HEIGHT : VIEWPORT_HEIGHT;
    return {
      width: containerWidth,
      height,
      top: 0,
      left: 0,
      right: containerWidth,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };

  class ControllableResizeObserver {
    private readonly entry: FakeObserver;

    constructor(callback: ResizeObserverCallback) {
      this.entry = {
        targets: new Set<Element>(),
        fire: () => {
          const entries = Array.from(this.entry.targets, (target) => ({
            target,
            contentRect: {
              width: containerWidth,
              height:
                target.getAttribute('data-testid') === 'datatable-card'
                  ? CARD_HEIGHT
                  : VIEWPORT_HEIGHT,
            },
          })) as unknown as ResizeObserverEntry[];
          if (entries.length > 0) callback(entries, this as unknown as ResizeObserver);
        },
      };
      observers.add(this.entry);
    }

    observe(target: Element) {
      this.entry.targets.add(target);
      this.entry.fire();
    }
    unobserve(target: Element) {
      this.entry.targets.delete(target);
    }
    disconnect() {
      this.entry.targets.clear();
      observers.delete(this.entry);
    }
  }

  globalThis.ResizeObserver = ControllableResizeObserver as unknown as typeof ResizeObserver;

  window.matchMedia = vi.fn().mockImplementation((query: string) => {
    const max = /max-width:\s*([\d.]+)px/.exec(query);
    const min = /min-width:\s*([\d.]+)px/.exec(query);
    let matches = true;
    if (max) matches = matches && VIEWPORT_WIDTH <= Number.parseFloat(max[1]);
    if (min) matches = matches && VIEWPORT_WIDTH >= Number.parseFloat(min[1]);
    return {
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
  }) as unknown as typeof window.matchMedia;
}

/** Reset the container to a desktop-sized default. Call in a `beforeEach`. */
export function resetContainerWidth(width = 1400): void {
  containerWidth = width;
}

/** Set the width used by the NEXT render (no resize observers fired). */
export function setInitialContainerWidth(width: number): void {
  containerWidth = width;
}

/** Resize the container and let every live observer report the new width. */
export function setContainerWidth(width: number): void {
  containerWidth = width;
  act(() => {
    observers.forEach((observer) => observer.fire());
  });
}
