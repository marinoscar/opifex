import { describe, it, expect } from 'vitest';
import { COCKPIT_ENDPOINTS, COCKPIT_POLL_INTERVAL_MS } from '../../config/cockpitApi';
import type { CockpitResourceKey } from '../../config/cockpitApi';

/**
 * The not-yet-wired registry.
 *
 * Small file, but the assertions below are the ones that keep it HONEST rather
 * than decorative — the whole mechanism only works if `available` really is
 * the single switch and `phase` really is a roadmap phase.
 */
describe('COCKPIT_ENDPOINTS', () => {
  const keys = Object.keys(COCKPIT_ENDPOINTS) as CockpitResourceKey[];

  it('covers exactly the four dashboard resources', () => {
    expect(keys.sort()).toEqual(['activity', 'attention', 'metrics', 'queue']);
  });

  /**
   * The honesty contract's precondition. If any of these is `true` while
   * `apps/api` still has no domain module, the dashboard starts polling a URL
   * that 404s and the panels report an ERROR where the truth is "not built".
   *
   * This is a deliberate speed bump: flipping one to `true` fails here, and
   * the fix is to update this test in the SAME pull request that adds the
   * endpoint — which is exactly the review conversation that should happen.
   */
  it('has every endpoint marked unavailable, because none of them exists yet', () => {
    for (const key of keys) {
      expect(COCKPIT_ENDPOINTS[key].available).toBe(false);
    }
  });

  it('names a real VISION §12 roadmap phase for every endpoint', () => {
    // Verbatim from VISION §12. Paraphrasing the phase on a dashboard tile
    // makes it unfindable in the document it came from.
    const roadmapPhases = [
      'Phase 0 — Conventions',
      'Phase 1 — Contracts',
      'Phase 2 — Reconciler, read-only',
      'Phase 3 — Liveness and escalation',
      'Phase 4 — Execution',
      'Phase 5 — Cockpit',
      'Phase 6 — Supervisor, observe-only',
      'Phase 7 — Earned autonomy',
      'Phase 8 — Second runner',
    ];

    for (const key of keys) {
      expect(roadmapPhases).toContain(COCKPIT_ENDPOINTS[key].phase);
    }
  });

  it('gives every endpoint an absolute, API-relative path', () => {
    for (const key of keys) {
      // Relative to the API base, which `services/api.ts` prepends. A path
      // carrying its own `/api` prefix would double it.
      expect(COCKPIT_ENDPOINTS[key].path.startsWith('/')).toBe(true);
      expect(COCKPIT_ENDPOINTS[key].path.startsWith('/api')).toBe(false);
    }
  });

  it('polls slowly enough to be free and often enough to be useful', () => {
    // Bounds rather than an exact value: the number is a judgement call about
    // VISION §11's shared quota, and pinning it exactly would make a tuning
    // change look like a behaviour change.
    expect(COCKPIT_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(10_000);
    expect(COCKPIT_POLL_INTERVAL_MS).toBeLessThanOrEqual(120_000);
  });
});
