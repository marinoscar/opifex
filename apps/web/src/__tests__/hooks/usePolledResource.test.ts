/**
 * `usePolledResource` — the hook every cockpit panel is built on.
 *
 * Epic #19. This is the hardest-tested file in the frontend, deliberately:
 * almost all of the data layer's branch coverage lives here, and every one of
 * the behaviours below is load-bearing for the dashboard's honesty contract or
 * for VISION §11's shared quota. A regression in any of them is silent — the
 * screen still renders, it just stops telling the truth or starts costing
 * money.
 *
 * Fake timers throughout, with `advanceTimersByTimeAsync` rather than the
 * synchronous form: the hook interleaves timers with promises, and the
 * synchronous advance would run the interval without ever letting the pending
 * fetch settle.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from '@testing-library/react';
import { renderHookWithProviders } from '../utils/hook-utils';
import {
  usePolledResource,
  MAX_POLL_BACKOFF_MS,
} from '../../hooks/usePolledResource';

const INTERVAL = 1000;

/**
 * Advance fake timers and flush the promise queue inside `act`.
 *
 * Testing Library's `waitFor` is deliberately NOT used anywhere in this file:
 * it polls on a real timer and only special-cases *jest's* fake clock, so
 * under `vi.useFakeTimers()` it simply hangs until the suite timeout. Every
 * wait here is therefore explicit, which is also more honest about what each
 * test asserts — "after exactly one interval", not "eventually".
 */
async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** A fetcher whose promise the test resolves or rejects by hand. */
function deferredFetcher() {
  let resolve!: (value: string[]) => void;
  let reject!: (error: Error) => void;
  const signals: AbortSignal[] = [];

  const fetcher = vi.fn((signal: AbortSignal) => {
    signals.push(signal);
    return new Promise<string[]>((res, rej) => {
      resolve = res;
      reject = rej;
    });
  });

  return {
    fetcher,
    signals,
    resolve: (value: string[]) => resolve(value),
    reject: (error: Error) => reject(error),
  };
}

/** Drives `document.visibilityState`, which jsdom leaves read-only otherwise. */
function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('usePolledResource', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility('visible');
  });

  afterEach(() => {
    vi.useRealTimers();
    setVisibility('visible');
  });

  describe('enabled: false — the not-yet-wired contract', () => {
    /**
     * THE most important assertion in this file. "There is no endpoint yet" is
     * expressed structurally, by never issuing a request — not by catching a
     * 404 and inferring it. If this ever regresses, the dashboard starts
     * hammering four endpoints that do not exist and cannot distinguish
     * "not built" from "briefly down".
     */
    it('issues zero requests, ever', async () => {
      const fetcher = vi.fn().mockResolvedValue(['a']);

      const { result } = renderHookWithProviders(() =>
        usePolledResource<string[]>({ fetcher, intervalMs: INTERVAL, enabled: false }),
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(INTERVAL * 10);
      });

      expect(fetcher).not.toHaveBeenCalled();
      expect(result.current.state).toBe('unwired');
      expect(result.current.data).toBeNull();
      expect(result.current.lastUpdatedAt).toBeNull();
    });

    it('does not fetch even when refresh() is called explicitly', async () => {
      const fetcher = vi.fn().mockResolvedValue(['a']);

      const { result } = renderHookWithProviders(() =>
        usePolledResource<string[]>({ fetcher, intervalMs: INTERVAL, enabled: false }),
      );

      await act(async () => {
        await result.current.refresh();
      });

      expect(fetcher).not.toHaveBeenCalled();
      expect(result.current.state).toBe('unwired');
    });

    it('starts polling when enabled flips to true', async () => {
      const fetcher = vi.fn().mockResolvedValue(['a']);

      const { result, rerender } = renderHookWithProviders(
        ({ enabled }: { enabled: boolean }) =>
          usePolledResource<string[]>({ fetcher, intervalMs: INTERVAL, enabled }),
        { initialProps: { enabled: false } },
      );

      expect(fetcher).not.toHaveBeenCalled();

      await act(async () => {
        rerender({ enabled: true });
      });

      await flush();
      expect(result.current.state).toBe('ready');
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  describe('the state machine', () => {
    it('is loading before the first response and ready after it', async () => {
      const { fetcher, resolve } = deferredFetcher();

      const { result } = renderHookWithProviders(() =>
        usePolledResource<string[]>({ fetcher, intervalMs: INTERVAL, enabled: true }),
      );

      expect(result.current.state).toBe('loading');
      expect(result.current.isRefreshing).toBe(true);

      await act(async () => {
        resolve(['run-1']);
      });

      expect(result.current.state).toBe('ready');
      expect(result.current.data).toEqual(['run-1']);
      expect(result.current.isRefreshing).toBe(false);
      expect(result.current.lastUpdatedAt).toBeInstanceOf(Date);
    });

    it('reports empty for an empty array by default', async () => {
      const { fetcher, resolve } = deferredFetcher();

      const { result } = renderHookWithProviders(() =>
        usePolledResource<string[]>({ fetcher, intervalMs: INTERVAL, enabled: true }),
      );

      await act(async () => {
        resolve([]);
      });

      // Empty is a REAL finding, distinct from unwired. The panels render the
      // two through different components on purpose.
      expect(result.current.state).toBe('empty');
      expect(result.current.data).toEqual([]);
    });

    it('honours a custom isEmpty', async () => {
      const fetcher = vi.fn().mockResolvedValue({ items: [] });

      const { result } = renderHookWithProviders(() =>
        usePolledResource<{ items: string[] }>({
          fetcher,
          intervalMs: INTERVAL,
          enabled: true,
          isEmpty: (data) => data.items.length === 0,
        }),
      );

      await flush();
      expect(result.current.state).toBe('empty');
    });

    it('reports error only when there is nothing to show', async () => {
      const { fetcher, reject } = deferredFetcher();

      const { result } = renderHookWithProviders(() =>
        usePolledResource<string[]>({ fetcher, intervalMs: INTERVAL, enabled: true }),
      );

      await act(async () => {
        reject(new Error('boom'));
      });

      expect(result.current.state).toBe('error');
      expect(result.current.error).toBe('boom');
      expect(result.current.data).toBeNull();
    });
  });

  describe('interval polling', () => {
    it('re-fetches once per interval', async () => {
      const fetcher = vi.fn().mockResolvedValue(['a']);

      renderHookWithProviders(() =>
        usePolledResource<string[]>({ fetcher, intervalMs: INTERVAL, enabled: true }),
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(fetcher).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(INTERVAL);
      });
      expect(fetcher).toHaveBeenCalledTimes(2);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(INTERVAL * 2);
      });
      expect(fetcher).toHaveBeenCalledTimes(4);
    });

    /**
     * Single-flight. A slow endpoint must not accumulate a backlog of requests
     * that then all resolve at once, oldest last — which would show the
     * operator an older screen than the one they had a second ago.
     */
    it('skips a tick that lands while a request is still in flight', async () => {
      const { fetcher, resolve } = deferredFetcher();

      renderHookWithProviders(() =>
        usePolledResource<string[]>({ fetcher, intervalMs: INTERVAL, enabled: true }),
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(INTERVAL * 5);
      });

      // Five ticks passed and the first request never settled.
      expect(fetcher).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolve(['a']);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(INTERVAL);
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });

  describe('aborting', () => {
    it('aborts the in-flight request on unmount', async () => {
      const { fetcher, signals } = deferredFetcher();

      const { unmount } = renderHookWithProviders(() =>
        usePolledResource<string[]>({ fetcher, intervalMs: INTERVAL, enabled: true }),
      );

      expect(signals).toHaveLength(1);
      expect(signals[0].aborted).toBe(false);

      unmount();

      expect(signals[0].aborted).toBe(true);
    });

    it('lets a manual refresh supersede — and abort — an in-flight poll', async () => {
      const { fetcher, signals, resolve } = deferredFetcher();

      const { result } = renderHookWithProviders(() =>
        usePolledResource<string[]>({ fetcher, intervalMs: INTERVAL, enabled: true }),
      );

      await act(async () => {
        void result.current.refresh();
      });

      expect(fetcher).toHaveBeenCalledTimes(2);
      // The first request was cancelled rather than raced, so its response can
      // never land after the newer one and overwrite it.
      expect(signals[0].aborted).toBe(true);
      expect(signals[1].aborted).toBe(false);

      await act(async () => {
        resolve(['fresh']);
      });

      expect(result.current.data).toEqual(['fresh']);
    });

    it('does not write state from a superseded request', async () => {
      const responses: Array<(value: string[]) => void> = [];
      const fetcher = vi.fn(
        () => new Promise<string[]>((resolve) => responses.push(resolve)),
      );

      const { result } = renderHookWithProviders(() =>
        usePolledResource<string[]>({ fetcher, intervalMs: INTERVAL, enabled: true }),
      );

      await act(async () => {
        void result.current.refresh();
      });

      // Resolve the SUPERSEDED request last — the classic out-of-order landing.
      await act(async () => {
        responses[1](['second']);
        responses[0](['first']);
      });

      expect(result.current.data).toEqual(['second']);
    });
  });

  describe('visibility', () => {
    /**
     * VISION §11: automated runs and interactive use share one quota. A
     * dashboard polling on a background monitor spends real money for nobody.
     */
    it('pauses while the tab is hidden and resumes with an immediate refetch', async () => {
      const fetcher = vi.fn().mockResolvedValue(['a']);

      renderHookWithProviders(() =>
        usePolledResource<string[]>({ fetcher, intervalMs: INTERVAL, enabled: true }),
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(fetcher).toHaveBeenCalledTimes(1);

      await act(async () => {
        setVisibility('hidden');
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(INTERVAL * 5);
      });
      expect(fetcher).toHaveBeenCalledTimes(1);

      await act(async () => {
        setVisibility('visible');
      });

      // Immediately, not on the next tick: an operator coming back must not
      // read a five-minute-old screen as current.
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('aborts the in-flight request when the tab is hidden', async () => {
      const { fetcher, signals } = deferredFetcher();

      renderHookWithProviders(() =>
        usePolledResource<string[]>({ fetcher, intervalMs: INTERVAL, enabled: true }),
      );

      await act(async () => {
        setVisibility('hidden');
      });

      expect(signals[0].aborted).toBe(true);
    });
  });

  describe('error backoff', () => {
    it('doubles the interval on each consecutive failure and resets on success', async () => {
      const fetcher = vi
        .fn()
        .mockRejectedValueOnce(new Error('down'))
        .mockRejectedValueOnce(new Error('still down'))
        .mockResolvedValue(['back']);

      const { result } = renderHookWithProviders(() =>
        usePolledResource<string[]>({ fetcher, intervalMs: INTERVAL, enabled: true }),
      );

      await flush();
      expect(result.current.error).toBe('down');
      expect(fetcher).toHaveBeenCalledTimes(1);

      // One failure => the next attempt is at 2x the base interval, so the
      // base interval alone must NOT trigger one.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(INTERVAL);
      });
      expect(fetcher).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(INTERVAL);
      });
      expect(fetcher).toHaveBeenCalledTimes(2);

      // Two failures => 4x.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(INTERVAL * 3);
      });
      expect(fetcher).toHaveBeenCalledTimes(2);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(INTERVAL);
      });
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(result.current.error).toBeNull();

      // Success resets the backoff to the base interval.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(INTERVAL);
      });
      expect(fetcher).toHaveBeenCalledTimes(4);
    });

    it('caps the backoff', async () => {
      const fetcher = vi.fn().mockRejectedValue(new Error('down'));

      const { result } = renderHookWithProviders(() =>
        usePolledResource<string[]>({
          // A base interval large enough that two failures already exceed the
          // cap, so the assertion is about the cap and not about the maths.
          fetcher,
          intervalMs: MAX_POLL_BACKOFF_MS,
          enabled: true,
        }),
      );

      await flush();
      expect(result.current.error).toBe('down');

      await flush(MAX_POLL_BACKOFF_MS);
      // Without the cap this would have been scheduled at 2x and not fired.
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });

  describe('stale data', () => {
    /**
     * A failed poll must never blank the panel. Clearing the screen on a
     * transient blip destroys the operator's context at exactly the moment
     * they were reading it.
     */
    it('keeps the last good data across a failed poll and surfaces the error beside it', async () => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(['run-1', 'run-2'])
        .mockRejectedValue(new Error('network down'));

      const { result } = renderHookWithProviders(() =>
        usePolledResource<string[]>({ fetcher, intervalMs: INTERVAL, enabled: true }),
      );

      await flush();
      expect(result.current.state).toBe('ready');
      const firstUpdate = result.current.lastUpdatedAt;

      await flush(INTERVAL);

      expect(result.current.error).toBe('network down');
      expect(result.current.data).toEqual(['run-1', 'run-2']);
      // Still `ready`, not `error`: there IS something to show. The header
      // turns this pair into "stale since HH:MM".
      expect(result.current.state).toBe('ready');
      // And the timestamp is not advanced by a failure — it means "last known
      // good", not "last attempted".
      expect(result.current.lastUpdatedAt).toBe(firstUpdate);
    });

    it('reports a non-Error rejection with a generic message rather than crashing', async () => {
      const fetcher = vi.fn().mockRejectedValue('just a string');

      const { result } = renderHookWithProviders(() =>
        usePolledResource<string[]>({ fetcher, intervalMs: INTERVAL, enabled: true }),
      );

      await flush();
      expect(result.current.error).toBe('Failed to load');
    });
  });
});
