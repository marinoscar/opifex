/**
 * A polled read-only resource: fetch on mount, re-fetch on an interval, and
 * never lie about what is on screen.
 *
 * Epic #19. Every cockpit panel is fed by this hook.
 *
 * ## Why this and not TanStack Query
 *
 * Four reasons, in descending order of how much they would change if
 * circumstances changed:
 *
 *  1. **Repo policy.** `.claude/agents/frontend-dev.md`: "State is React
 *     Context + custom hooks + `fetch` — there is no Redux and no react-query;
 *     do not introduce them." That alone settles it.
 *  2. **Zero endpoints exist.** A query cache's cost is paid up front —
 *     provider, keys, an invalidation model to learn — against a benefit that
 *     begins when there is data to cache. There is none.
 *  3. **Single operator** (VISION §11). The cross-component cache coherency
 *     TanStack solves is a multi-consumer, multi-tab, mutate-and-invalidate
 *     problem. This app has one person looking at one read-only dashboard.
 *  4. **Polling is not the destination.** VISION §10's detection-latency
 *     target is *seconds*; no interval that respects the shared quota reaches
 *     seconds. The real answer is SSE or a WebSocket push. A thin hook with
 *     one timer swaps for an event subscription in an afternoon; a query cache
 *     with its own invalidation model does not.
 *
 * ## The five behaviours that are load-bearing, and all tested
 *
 *  1. **`enabled: false` fires no request at all.** This is how "there is no
 *     endpoint yet" is expressed. `state: 'unwired'` is STRUCTURAL — it comes
 *     from `config/cockpitApi.ts`, not from catching a 404. Inferring it from
 *     a failed request would mean the app could not tell "not built" from
 *     "briefly down", which is the one distinction the dashboard exists to
 *     make honestly.
 *  2. **A failed poll never blanks existing data.** `error` is surfaced
 *     ALONGSIDE the stale `data`, and the header reads "stale since HH:MM".
 *     Clearing the screen on a transient network blip destroys the operator's
 *     context at exactly the moment they were reading it.
 *  3. **Pauses while the tab is hidden**, and resumes with an immediate
 *     refetch. Under VISION §11 automated runs and interactive use share one
 *     quota, so a dashboard polling on a background monitor spends real money.
 *     Resuming with an immediate fetch (rather than waiting out the interval)
 *     is what stops a returning operator from reading a five-minute-old screen
 *     as current.
 *  4. **Exponential backoff on consecutive failures** (x2, capped), reset on
 *     the first success. An API that is down does not get hammered every 30s
 *     by a tab nobody is looking at.
 *  5. **Single-flight.** A tick that lands while a request is in flight is
 *     SKIPPED, not queued — a slow endpoint must not accumulate a backlog of
 *     requests that then all resolve at once, oldest last. A manual
 *     `refresh()` is the one thing allowed to supersede an in-flight poll, and
 *     it aborts it rather than racing it.
 *
 * Every `setState` past an `await` is guarded with `useIsMounted()` — the
 * house rule from `useUsers.ts`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useIsMounted } from './useIsMounted';

/**
 * What a panel should draw.
 *
 * `empty` and `unwired` are separate states because they are opposite claims
 * about the world: "the watchdog looked and nothing needs attention" is good
 * news; "there is no watchdog" is an absence of news. They render through
 * `EmptyState` and `NotWiredState` respectively, and must never look alike.
 *
 * `error` is reported only when there is NOTHING to show. A failed poll that
 * still has stale data reports `ready` with `error` set — see behaviour 2
 * above; the caller decides how loudly to say "stale".
 */
export type ResourceState = 'unwired' | 'loading' | 'ready' | 'empty' | 'error';

export interface UsePolledResourceOptions<T> {
  /**
   * Performs one read. MUST forward `signal` to `fetch`, or an aborted request
   * keeps running and a superseded response can still resolve.
   *
   * Held in a ref internally, so an inline arrow function is fine and does not
   * restart the timer on every render.
   */
  fetcher: (signal: AbortSignal) => Promise<T>;
  /** Base interval. Backoff multiplies this; it is never the ceiling. */
  intervalMs: number;
  /** `false` => zero requests, ever, and `state` stays `'unwired'`. */
  enabled: boolean;
  /**
   * Does a successful response contain nothing? Defaults to "an empty array
   * is empty" so list resources need not spell it out. Read during render, so
   * unlike `fetcher` it must stay pure.
   */
  isEmpty?: (data: T) => boolean;
}

export interface UsePolledResourceResult<T> {
  data: T | null;
  state: ResourceState;
  /** Non-null after a failure, INCLUDING when stale `data` is still present. */
  error: string | null;
  /** When `data` last came back successfully. Null until the first success. */
  lastUpdatedAt: Date | null;
  /** A request is in flight. True for the first load as well as for re-polls. */
  isRefreshing: boolean;
  /** Fetch now. Supersedes an in-flight poll. Resolves when the fetch settles. */
  refresh: () => Promise<void>;
}

/**
 * The backoff ceiling: five minutes.
 *
 * Long enough that a dead API is effectively left alone, short enough that a
 * cockpit left open recovers on its own within one coffee break rather than
 * needing a reload. Backoff also resets the moment the tab regains visibility,
 * because an operator who just came back is asking for fresh data explicitly.
 */
export const MAX_POLL_BACKOFF_MS = 5 * 60 * 1000;

/** `true` when the document is currently visible (or when there is no document). */
function isDocumentVisible(): boolean {
  return (
    typeof document === 'undefined' || document.visibilityState === 'visible'
  );
}

/** An aborted request is not a failure; it is a request we cancelled. */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** The default emptiness test: only an array can be empty without being absent. */
function defaultIsEmpty(data: unknown): boolean {
  return Array.isArray(data) && data.length === 0;
}

export function usePolledResource<T>({
  fetcher,
  intervalMs,
  enabled,
  isEmpty,
}: UsePolledResourceOptions<T>): UsePolledResourceResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  /** Consecutive failures. Drives the backoff, and only the backoff. */
  const [failureCount, setFailureCount] = useState(0);
  const [isVisible, setIsVisible] = useState(isDocumentVisible);

  const isMounted = useIsMounted();

  // The "latest ref" pattern for the fetcher. Callers pass inline arrow
  // functions (`fetcher: (signal) => getRunQueue(signal)`), which are a new
  // identity every render; if the polling effect depended on them directly it
  // would tear down and rebuild the interval on every render — i.e. never
  // actually reach a tick. This effect is declared FIRST so it has already run
  // by the time the polling effect below reads either ref.
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  /** The controller of the request currently in flight, if any. */
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (options: { manual: boolean }): Promise<void> => {
      if (abortRef.current) {
        // Single-flight. A poll tick during an in-flight request is dropped
        // entirely rather than queued: queueing turns a slow endpoint into a
        // pile-up whose responses land out of order.
        if (!options.manual) return;
        // A manual refresh is the operator asking for data NOW, so it wins —
        // and it aborts rather than races, so the older response cannot land
        // after the newer one and overwrite it.
        abortRef.current.abort();
      }

      const controller = new AbortController();
      abortRef.current = controller;
      setIsRefreshing(true);

      try {
        const result = await fetcherRef.current(controller.signal);
        // Superseded while awaiting: its result is stale by definition.
        if (controller.signal.aborted || !isMounted()) return;
        setData(result);
        setError(null);
        setLastUpdatedAt(new Date());
        setFailureCount(0);
      } catch (err) {
        if (controller.signal.aborted || isAbortError(err) || !isMounted())
          return;
        // NOTE what is deliberately absent: no `setData(null)`. Stale data
        // plus a visible error beats a blank panel plus an error, every time.
        setError(err instanceof Error ? err.message : 'Failed to load');
        setFailureCount((count) => count + 1);
      } finally {
        // Only the CURRENT request may clear the in-flight slot. A superseded
        // request settles after its replacement started; without this guard it
        // would report the replacement as finished.
        if (abortRef.current === controller) {
          abortRef.current = null;
          if (isMounted()) setIsRefreshing(false);
        }
      }
    },
    [isMounted],
  );

  const refresh = useCallback(async () => {
    // Disabled means disabled: a refresh button cannot conjure an endpoint.
    // (The dashboard header hides the button rather than disabling it, so this
    // is a second line of defence, not the primary one.)
    if (!enabled) return;
    await run({ manual: true });
  }, [enabled, run]);

  // Visibility, as state rather than as a ref, because the polling effect
  // below has to re-run when it flips.
  useEffect(() => {
    const onVisibilityChange = () => setIsVisible(isDocumentVisible());
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () =>
      document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  /**
   * The current interval, backed off by consecutive failures.
   * `intervalMs * 2^failures`, capped. Zero failures = the base interval.
   */
  const delayMs = Math.min(intervalMs * 2 ** failureCount, MAX_POLL_BACKOFF_MS);

  /**
   * True once we have fetched for the current active session, where a session
   * is one unbroken stretch of `enabled && isVisible`.
   *
   * This is what separates "start polling" from "reschedule the timer". The
   * effect below re-runs whenever `delayMs` changes — which is exactly when a
   * request just FAILED — and firing the immediate fetch on that path would
   * retry instantly and defeat the backoff it was just given.
   */
  const sessionStartedRef = useRef(false);

  useEffect(() => {
    if (!enabled || !isVisible) {
      sessionStartedRef.current = false;
      // Going hidden or disabled cancels whatever is in flight; nothing on
      // screen is waiting for it.
      abortRef.current?.abort();
      abortRef.current = null;
      return;
    }

    if (!sessionStartedRef.current) {
      sessionStartedRef.current = true;
      // Immediate on mount AND on resume — see behaviour 3.
      void run({ manual: false });
    }

    if (delayMs <= 0) return;

    const timer = setInterval(() => {
      void run({ manual: false });
    }, delayMs);

    return () => clearInterval(timer);
  }, [enabled, isVisible, delayMs, run]);

  // Unmount is the one abort that cannot live in the effect above: that
  // effect's cleanup also runs on every reschedule, where aborting the
  // in-flight request would be wrong.
  //
  // Disarming the session guard here is what makes issue #169 impossible. The
  // guard's meaning is "a request for this session is outstanding or has
  // completed" — so the moment we abandon that request, it is neither, and the
  // guard is a lie. React StrictMode runs effects mount -> unmount -> mount on
  // the same instance in development: refs survive that simulated remount, the
  // abort does not, and without this line the second mount saw an armed guard,
  // declined to re-fire, and left every cockpit panel spinning until the first
  // 30-second tick. On a genuine unmount the reset costs nothing — the ref
  // dies with the component.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      abortRef.current = null;
      sessionStartedRef.current = false;
    },
    [],
  );

  return {
    data,
    state: deriveState({ enabled, data, error, isEmpty }),
    error,
    lastUpdatedAt,
    isRefreshing,
    refresh,
  };
}

/**
 * The state machine, extracted so it is exhaustively testable without a timer.
 *
 * Order matters and encodes the honesty rules:
 *  - `unwired` outranks everything: no endpoint means nothing else is true.
 *  - `error` is only reported with NO data — with data we are `ready` and
 *    stale, and `error` is still non-null for the caller to surface.
 *  - `loading` is the pre-first-response state and is the only state that may
 *    show a spinner. It is never re-entered by a re-poll, which is why a
 *    refresh does not flash the panel back to a spinner.
 */
function deriveState<T>({
  enabled,
  data,
  error,
  isEmpty,
}: {
  enabled: boolean;
  data: T | null;
  error: string | null;
  isEmpty?: (data: T) => boolean;
}): ResourceState {
  if (!enabled) return 'unwired';
  if (data === null) return error === null ? 'loading' : 'error';
  return (isEmpty ?? defaultIsEmpty)(data) ? 'empty' : 'ready';
}
