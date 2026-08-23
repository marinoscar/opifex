/**
 * The not-yet-wired registry — one grep-able answer to "what is not built yet".
 *
 * Epic #19. `apps/api` has no runs, queue, projects, cost or metrics module,
 * so every cockpit panel is fed by an endpoint that does not exist. That fact
 * is recorded HERE, once, as data — rather than as a `// TODO` in four hooks
 * and a hardcoded phase string in four components.
 *
 * Three things read this file, and between them they are the whole mechanism:
 *
 *  1. Each domain hook passes `available` straight into `usePolledResource`'s
 *     `enabled`. `enabled: false` issues ZERO requests — the unwired state is
 *     structural, not inferred from a 404 (see `hooks/usePolledResource.ts`).
 *  2. Each panel passes `phase` into `components/common/NotWiredState.tsx`, so
 *     the screen names the roadmap phase that will supply it. "Coming soon" is
 *     not a claim anyone can check; "Phase 4 — Execution" is.
 *  3. `path` documents the endpoint the frontend is waiting for, which is what
 *     makes this file readable as a request TO the API rather than as a note
 *     to ourselves.
 *
 * **Wiring an endpoint is a one-line flip here**, plus whatever the response
 * parsing needs in `services/api.ts`. That is the point of the indirection: no
 * panel, and no hook, contains a second copy of "does this exist yet".
 *
 * `phase` values are verbatim from VISION §12's roadmap. Do not paraphrase
 * them — the operator reading "Phase 3 — Liveness and escalation" on the
 * dashboard should be able to find that exact string in the vision document.
 */

/** One endpoint the cockpit wants, and its build status. */
export interface CockpitEndpoint {
  /** Path relative to the API base (`services/api.ts` prepends `/api`). */
  readonly path: string;
  /** Does this exist in `apps/api` today? Drives `enabled` on the poll. */
  readonly available: boolean;
  /** The VISION §12 roadmap phase that delivers it, verbatim. */
  readonly phase: string;
}

/** The cockpit resources, one per dashboard panel. */
export type CockpitResourceKey = 'metrics' | 'attention' | 'queue' | 'activity';

/**
 * The registry.
 *
 * Deliberately annotated `Record<CockpitResourceKey, CockpitEndpoint>` rather
 * than left to `as const`. With `as const` every `available` narrows to the
 * literal type `false`, and TypeScript then treats every "what if it is
 * available" branch — in the hooks, in `PanelCard`'s state mapping, in the
 * tests that flip one on — as statically dead code. The registry is a runtime
 * switch, so its type must stay `boolean`; the literal types would encode
 * today's answer into the compiler.
 */
export const COCKPIT_ENDPOINTS: Record<CockpitResourceKey, CockpitEndpoint> = {
  metrics: {
    path: '/metrics/summary',
    available: false,
    phase: 'Phase 3 — Liveness and escalation',
  },
  attention: {
    // LIVE as of #80. `needsAttention=true` means "has an escalation nobody
    // has acknowledged or resolved" — the control plane's verdict, ordered by
    // longest silence first.
    path: '/runs?needsAttention=true',
    available: true,
    phase: 'Phase 3 — Liveness and escalation',
  },
  queue: {
    // LIVE as of #80. `GET /api/queue` returns queued and held work orders in
    // the order the dispatch pass drains them, with the reason each is not
    // running yet already resolved server-side.
    path: '/queue',
    available: true,
    phase: 'Phase 4 — Execution',
  },
  activity: {
    path: '/events?limit=20',
    available: false,
    phase: 'Phase 2 — Reconciler, read-only',
  },
};

/**
 * How often a wired cockpit resource is re-fetched, in milliseconds.
 *
 * ONE interval for all four, on purpose. Tuning per-resource cadences before a
 * single endpoint exists would be guessing, and the guess would be wrong for a
 * more fundamental reason: **polling is not where this ends up.** VISION §10's
 * detection-latency target is measured in seconds, and no poll interval that
 * respects VISION §11's shared quota can hit seconds. The destination is an
 * event subscription (SSE or WebSocket), at which point this constant and the
 * timer in `usePolledResource` both disappear.
 *
 * 30s is chosen against that quota constraint rather than against a latency
 * one: automated runs and interactive use draw on the same limits, so an idle
 * dashboard left open on a second monitor must cost close to nothing. The poll
 * additionally pauses entirely while the tab is hidden.
 */
export const COCKPIT_POLL_INTERVAL_MS = 30_000;
