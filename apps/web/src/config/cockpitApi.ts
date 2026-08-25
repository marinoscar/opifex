/**
 * The cockpit endpoint registry — one grep-able answer to "what is wired".
 *
 * Epic #19. **All four are now wired**: `apps/api` serves `/metrics/summary`,
 * `/runs`, `/queue` and `/events` (#163, #164, #165, #168), so every entry
 * below is `available: true` and no cockpit panel renders an unwired state.
 *
 * When this file was written none of those endpoints existed, and that fact was
 * recorded HERE, once, as data — rather than as a `// TODO` in four hooks and a
 * hardcoded phase string in four components. The registry outlives that state
 * on purpose: it is where the NEXT unbuilt resource declares itself, and while
 * everything is wired it is the one place a reader can confirm that in a line.
 *
 * Three things read this file, and between them they are the whole mechanism:
 *
 *  1. Each domain hook passes `available` straight into `usePolledResource`'s
 *     `enabled`. `enabled: false` issues ZERO requests — the unwired state is
 *     structural, not inferred from a 404 (see `hooks/usePolledResource.ts`).
 *     With all four `true` every panel polls; the switch is held open rather
 *     than removed, and the hook suites still exercise both sides of it.
 *  2. Each panel passes `phase` into `components/common/NotWiredState.tsx`, so
 *     the screen names the roadmap phase that will supply it. "Coming soon" is
 *     not a claim anyone can check; "Phase 4 — Execution" is. Nothing reaches
 *     that component from the running app today, because no entry is `false`.
 *  3. `path` documents the endpoint each panel reads. It was written as a
 *     request TO the API rather than as a note to ourselves, and the request
 *     was answered; it now has to stay in step with the paths in
 *     `services/api.ts`, which are the executable half of the same statement.
 *
 * **Wiring an endpoint is a one-line flip here**, plus whatever the response
 * parsing needs in `services/api.ts`. That was the point of the indirection and
 * it held: the four flipped one line at a time, and no panel and no hook ever
 * grew a second copy of "does this exist yet".
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
    // LIVE as of #80. Two of the six are computed and four return null —
    // "not measured", never zero. The tile renders null as an em dash, so an
    // unbuilt metric still shows its name and its meaning.
    path: '/metrics/summary',
    available: true,
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
    // LIVE as of #80 — the last of the four. The normalized event floor
    // across every run, newest first.
    path: '/events?pageSize=20',
    available: true,
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
