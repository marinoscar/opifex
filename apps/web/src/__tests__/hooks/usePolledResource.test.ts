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
    fetcherKey: [],
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
        usePolledResource<string[]>({
          fetcher,
          fetcherKey: [],
          intervalMs: INTERVAL,
          enabled: false,
        }),
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
        usePolledResource<string[]>({
          fetcher,
          fetcherKey: [],
          intervalMs: INTERVAL,
          enabled: false,
        }),
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
          usePolledResource<string[]>({
            fetcher,
            fetcherKey: [],
            intervalMs: INTERVAL,
            enabled,
          }),
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
        usePolledResource<string[]>({
          fetcher,
          fetcherKey: [],
          intervalMs: INTERVAL,
          enabled: true,
        }),
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
        usePolledResource<string[]>({
          fetcher,
          fetcherKey: [],
          intervalMs: INTERVAL,
          enabled: true,
        }),
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
          fetcherKey: [],
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
        usePolledResource<string[]>({
          fetcher,
          fetcherKey: [],
          intervalMs: INTERVAL,
          enabled: true,
        }),
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
        usePolledResource<string[]>({
          fetcher,
          fetcherKey: [],
          intervalMs: INTERVAL,
          enabled: true,
        }),
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
        usePolledResource<string[]>({
          fetcher,
          fetcherKey: [],
          intervalMs: INTERVAL,
          enabled: true,
        }),
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
        usePolledResource<string[]>({
          fetcher,
          fetcherKey: [],
          intervalMs: INTERVAL,
          enabled: true,
        }),
      );

      expect(signals).toHaveLength(1);
      expect(signals[0].aborted).toBe(false);

      unmount();

      expect(signals[0].aborted).toBe(true);
    });

    it('lets a manual refresh supersede — and abort — an in-flight poll', async () => {
      const { fetcher, signals, resolve } = deferredFetcher();

      const { result } = renderHookWithProviders(() =>
        usePolledResource<string[]>({
          fetcher,
          fetcherKey: [],
          intervalMs: INTERVAL,
          enabled: true,
        }),
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
        usePolledResource<string[]>({
          fetcher,
          fetcherKey: [],
          intervalMs: INTERVAL,
          enabled: true,
        }),
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
        usePolledResource<string[]>({
          fetcher,
          fetcherKey: [],
          intervalMs: INTERVAL,
          enabled: true,
        }),
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
        usePolledResource<string[]>({
          fetcher,
          fetcherKey: [],
          intervalMs: INTERVAL,
          enabled: true,
        }),
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
        usePolledResource<string[]>({
          fetcher,
          fetcherKey: [],
          intervalMs: INTERVAL,
          enabled: true,
        }),
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
          fetcherKey: [],
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
        usePolledResource<string[]>({
          fetcher,
          fetcherKey: [],
          intervalMs: INTERVAL,
          enabled: true,
        }),
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
        usePolledResource<string[]>({
          fetcher,
          fetcherKey: [],
          intervalMs: INTERVAL,
          enabled: true,
        }),
      );

      await flush();
      expect(result.current.error).toBe('Failed to load');
    });
  });
  /**
   * Issue #246. Every filter control in the cockpit is wired by rebuilding the
   * fetcher, and the fetcher lives in a ref — so for three merged features a
   * filter change issued no request, and the list updated up to 30 seconds
   * later with no apparent cause. That reads as an unreliable screen rather
   * than a broken one, which is the harder thing to report.
   *
   * The suite had 22 tests and not one of them changed the fetcher. These do.
   */
  describe('fetcherKey — a changed input re-reads now (#246)', () => {
    /**
     * The bug, stated as an assertion: no timer is advanced anywhere in this
     * test. If the refetch waits for a tick, this fails.
     */
    it('re-reads immediately when the key changes', async () => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(['pending-1'])
        .mockResolvedValue(['parked-1']);

      const { result, rerender } = renderHookWithProviders(
        ({ status }: { status: string }) =>
          usePolledResource<string[]>({
            fetcher,
            fetcherKey: [status],
            intervalMs: INTERVAL,
            enabled: true,
          }),
        { initialProps: { status: 'pending' } },
      );

      await flush();
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(result.current.data).toEqual(['pending-1']);

      await act(async () => {
        rerender({ status: 'parked' });
      });

      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(result.current.data).toEqual(['parked-1']);
    });

    /** The fetcher sees the NEW value, not the one the ref held at mount. */
    it('reads through the new fetcher, not the one held at mount', async () => {
      const read = vi.fn(async (status: string) => [status]);

      const { result, rerender } = renderHookWithProviders(
        ({ status }: { status: string }) =>
          usePolledResource<string[]>({
            // An inline arrow, which is a new identity every render — the
            // exact shape the ref exists to tolerate.
            fetcher: () => read(status),
            fetcherKey: [status],
            intervalMs: INTERVAL,
            enabled: true,
          }),
        { initialProps: { status: 'pending' } },
      );

      await flush();

      await act(async () => {
        rerender({ status: 'parked' });
      });

      expect(read).toHaveBeenLastCalledWith('parked');
      expect(result.current.data).toEqual(['parked']);
    });

    /**
     * The other half of the contract, and the reason identity comparison was
     * rejected: callers pass an inline array literal, so a fresh array with the
     * same contents must be a no-op. Otherwise every render is a request.
     */
    it('does not re-read when a re-render leaves the values unchanged', async () => {
      const read = vi.fn(async (status: string) => [status]);

      const { rerender } = renderHookWithProviders(
        ({ status }: { status: string }) =>
          usePolledResource<string[]>({
            fetcher: () => read(status),
            // A NEW array every render, with the same contents.
            fetcherKey: [status],
            intervalMs: INTERVAL,
            enabled: true,
          }),
        { initialProps: { status: 'pending' } },
      );

      await flush();
      expect(read).toHaveBeenCalledTimes(1);

      await act(async () => {
        rerender({ status: 'pending' });
        rerender({ status: 'pending' });
        rerender({ status: 'pending' });
      });

      expect(read).toHaveBeenCalledTimes(1);
    });

    /**
     * The race. An operator picking a second filter while the first is still
     * loading must not get the first filter's rows under the second filter's
     * heading — which is precisely what the issue describes seeing.
     */
    it('aborts the in-flight read so the old key cannot win the race', async () => {
      const resolvers: Array<(value: string[]) => void> = [];
      const signals: AbortSignal[] = [];
      const fetcher = vi.fn((signal: AbortSignal) => {
        signals.push(signal);
        return new Promise<string[]>((resolve) => resolvers.push(resolve));
      });

      const { result, rerender } = renderHookWithProviders(
        ({ status }: { status: string }) =>
          usePolledResource<string[]>({
            fetcher,
            fetcherKey: [status],
            intervalMs: INTERVAL,
            enabled: true,
          }),
        { initialProps: { status: 'pending' } },
      );

      // The first read is still in flight when the filter changes.
      expect(signals).toHaveLength(1);

      await act(async () => {
        rerender({ status: 'parked' });
      });

      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(signals[0].aborted).toBe(true);
      expect(signals[1].aborted).toBe(false);

      // Land them out of order, superseded LAST — the classic way a stale
      // response overwrites a fresh one.
      await act(async () => {
        resolvers[1](['parked-1']);
        resolvers[0](['pending-1']);
      });

      expect(result.current.data).toEqual(['parked-1']);
    });

    /**
     * Single-flight still applies to the poll: the key change supersedes, it
     * does not queue. A key change must not leave the timer disarmed either.
     */
    it('keeps polling on the same interval after a key change', async () => {
      const fetcher = vi.fn().mockResolvedValue(['a']);

      const { rerender } = renderHookWithProviders(
        ({ status }: { status: string }) =>
          usePolledResource<string[]>({
            fetcher,
            fetcherKey: [status],
            intervalMs: INTERVAL,
            enabled: true,
          }),
        { initialProps: { status: 'pending' } },
      );

      await flush();
      expect(fetcher).toHaveBeenCalledTimes(1);

      await act(async () => {
        rerender({ status: 'parked' });
      });
      expect(fetcher).toHaveBeenCalledTimes(2);

      await flush(INTERVAL);
      expect(fetcher).toHaveBeenCalledTimes(3);

      await flush(INTERVAL);
      expect(fetcher).toHaveBeenCalledTimes(4);
    });

    /**
     * `enabled: false` outranks everything, including this. A key change while
     * unwired must not conjure the request the whole `unwired` contract exists
     * to prevent.
     */
    it('issues nothing on a key change while disabled', async () => {
      const fetcher = vi.fn().mockResolvedValue(['a']);

      const { rerender } = renderHookWithProviders(
        ({ status }: { status: string }) =>
          usePolledResource<string[]>({
            fetcher,
            fetcherKey: [status],
            intervalMs: INTERVAL,
            enabled: false,
          }),
        { initialProps: { status: 'pending' } },
      );

      await act(async () => {
        rerender({ status: 'parked' });
      });

      expect(fetcher).not.toHaveBeenCalled();
    });

    /**
     * A key change on a hidden tab spends quota for nobody (VISION §11). It is
     * deferred to the resume, which already re-reads — and the resume must read
     * the NEW key, not the one that was current when the tab was hidden.
     */
    it('defers a key change made while hidden to the resume, once', async () => {
      const read = vi.fn(async (status: string) => [status]);

      const { result, rerender } = renderHookWithProviders(
        ({ status }: { status: string }) =>
          usePolledResource<string[]>({
            fetcher: () => read(status),
            fetcherKey: [status],
            intervalMs: INTERVAL,
            enabled: true,
          }),
        { initialProps: { status: 'pending' } },
      );

      await flush();
      expect(read).toHaveBeenCalledTimes(1);

      await act(async () => {
        setVisibility('hidden');
      });

      await act(async () => {
        rerender({ status: 'parked' });
      });
      expect(read).toHaveBeenCalledTimes(1);

      await act(async () => {
        setVisibility('visible');
      });
      await flush();

      // One read, not two: the resume's immediate fetch IS the key change's.
      expect(read).toHaveBeenCalledTimes(2);
      expect(read).toHaveBeenLastCalledWith('parked');
      expect(result.current.data).toEqual(['parked']);
    });

    /**
     * The same collision on the other axis: a key that changes in the same
     * commit as `enabled` flipping true. Single-flight is what makes this one
     * request rather than an immediate abort-and-reissue.
     */
    it('does not double-fire when the key changes as enabled flips true', async () => {
      const read = vi.fn(async (status: string) => [status]);

      const { rerender } = renderHookWithProviders(
        ({ status, enabled }: { status: string; enabled: boolean }) =>
          usePolledResource<string[]>({
            fetcher: () => read(status),
            fetcherKey: [status],
            intervalMs: INTERVAL,
            enabled,
          }),
        { initialProps: { status: 'pending', enabled: false } },
      );

      await act(async () => {
        rerender({ status: 'parked', enabled: true });
      });
      await flush();

      expect(read).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenLastCalledWith('parked');
    });
  });

  /**
   * Issue #169. The cockpit's first screen was blank for a full poll interval
   * on every load, in a real browser, while the API served every request in
   * ~50 ms. 1,770 web tests passed throughout, because none of them mounted
   * the hook the way React actually mounts it in development.
   *
   * React StrictMode runs effects mount -> unmount -> mount on the SAME
   * component instance. Refs survive that simulated remount; the abort does
   * not. So the first mount armed `sessionStartedRef` and fired a request, the
   * simulated unmount aborted it, and the second mount found the ref already
   * armed and declined to re-fire. Nothing was in flight, and nothing would be
   * until `setInterval` ticked.
   *
   * The rule these tests encode: the guard tracks whether a request is
   * OUTSTANDING OR COMPLETED, never merely whether one was once started. Any
   * path that abandons the request must disarm the guard so a remount re-arms.
   */
  describe('StrictMode remount (#169)', () => {
    /** Mount under StrictMode, exactly as `main.tsx` does in development. */
    function renderStrict<T>(
      options: Parameters<typeof usePolledResource<T>>[0],
    ) {
      return renderHookWithProviders(() => usePolledResource<T>(options), {
        reactStrictMode: true,
      });
    }

    it('has a live request in flight after the double-invoke', async () => {
      const { fetcher, signals } = deferredFetcher();

      renderStrict<string[]>({
        fetcher,
        fetcherKey: [],
        intervalMs: INTERVAL,
        enabled: true,
      });

      // The assertion that fails without the fix: not "a request was made"
      // (one was, and it was killed), but "a request is ALIVE". Every signal
      // aborted means the panel is waiting on nothing.
      expect(signals.length).toBeGreaterThan(0);
      expect(signals.some((signal) => !signal.aborted)).toBe(true);
      expect(fetcher).toHaveBeenCalled();
    });

    it('renders data without waiting for the first poll tick', async () => {
      const fetcher = vi.fn().mockResolvedValue(['run-1']);

      const { result } = renderStrict<string[]>({
        fetcher,
        fetcherKey: [],
        intervalMs: INTERVAL,
        enabled: true,
      });

      // Zero timer advance. This is the user-visible bug: 30 seconds of
      // spinners on the primary screen, which reads as "the factory is quiet"
      // rather than "the dashboard has not answered yet".
      await flush();

      expect(result.current.state).toBe('ready');
      expect(result.current.data).toEqual(['run-1']);
    });

    it('still fires exactly one request per session, not one per invoke', async () => {
      const fetcher = vi.fn().mockResolvedValue(['run-1']);

      renderStrict<string[]>({
        fetcher,
        fetcherKey: [],
        intervalMs: INTERVAL,
        enabled: true,
      });
      await flush();

      // Re-arming must not turn into re-fetching. The first mount's request is
      // aborted before it settles, so the replacement is the only one that
      // counts -- two calls, one of them dead, and no third from the poll
      // timer we have not advanced to.
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('does not double-fire on a reschedule, which is what the guard is for', async () => {
      // A failure changes `delayMs`, which re-runs the polling effect. That
      // path must NOT re-fire immediately, or backoff would be defeated the
      // instant it was applied -- which is the entire reason
      // `sessionStartedRef` exists. Re-arming it on abandonment must not cost
      // us that.
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(['run-1']) // the aborted mount-1 request
        .mockResolvedValueOnce(['run-1']) // its mount-2 replacement
        .mockRejectedValue(new Error('down'));

      const { result } = renderStrict<string[]>({
        fetcher,
        fetcherKey: [],
        intervalMs: INTERVAL,
        enabled: true,
      });
      await flush();

      expect(result.current.state).toBe('ready');
      const afterMount = fetcher.mock.calls.length;

      // One tick: the failure that bumps failureCount and so changes delayMs.
      await flush(INTERVAL);
      expect(fetcher).toHaveBeenCalledTimes(afterMount + 1);
      expect(result.current.error).toBe('down');

      // The reschedule itself buys no request at all...
      await flush();
      expect(fetcher).toHaveBeenCalledTimes(afterMount + 1);

      // ...and the next one waits out the DOUBLED interval, not the base one.
      await flush(INTERVAL);
      expect(fetcher).toHaveBeenCalledTimes(afterMount + 1);

      await flush(INTERVAL);
      expect(fetcher).toHaveBeenCalledTimes(afterMount + 2);
    });
  });
});
