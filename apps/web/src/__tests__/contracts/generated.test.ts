import { describe, expect, it } from 'vitest';

import {
  RUN_EVENT_SCHEMA_VERSION,
  RUN_EVENT_SOURCE,
  RUN_EVENT_TYPE,
  RUNNER_CAPABILITY_SCHEMA_VERSION,
  WORK_ORDER_SCHEMA_VERSION,
  type RunEvent,
  type RunnerCapabilityManifest,
  type WorkOrder,
} from '../../contracts/generated';

/**
 * #35's fourth acceptance criterion: "the frontend can consume the same types".
 *
 * The cockpit renders these objects — a run's event timeline, a fleet table of
 * capability manifests — so a shape it disagrees with the API about shows up as
 * a blank panel rather than an error. Asserting it here is what makes the claim
 * checkable: the generated files live in both apps, and if the web copy stopped
 * existing or stopped compiling, this fails rather than someone noticing later.
 *
 * The runtime constants are what the type alone cannot give: a union type
 * vanishes at compile time, and a filter control over the six event types needs
 * a real array to iterate.
 */
describe('the generated contracts, from the cockpit side', () => {
  it('exposes the six run-event types as an iterable value', () => {
    expect([...RUN_EVENT_TYPE]).toEqual([
      'run.started',
      'run.heartbeat',
      'run.progress',
      'run.blocked',
      'run.completed',
      'run.failed',
    ]);
  });

  it('exposes the three event sources, which the timeline has to distinguish', () => {
    // VISION §9: a synthesized event must never masquerade as a report. The UI
    // can only show that difference if the values are available to it.
    expect([...RUN_EVENT_SOURCE]).toEqual([
      'runner-reported',
      'git-derived',
      'control-plane-synthesized',
    ]);
  });

  it('carries each contract version', () => {
    for (const version of [
      RUN_EVENT_SCHEMA_VERSION,
      WORK_ORDER_SCHEMA_VERSION,
      RUNNER_CAPABILITY_SCHEMA_VERSION,
    ]) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('types an event the cockpit could have been handed', () => {
    // Compile-time is the real assertion here — this file would not build if
    // the generated shape and the one the cockpit expects had diverged.
    const event: RunEvent = {
      schemaVersion: RUN_EVENT_SCHEMA_VERSION,
      eventId: '018f2c31-7a4e-7c3b-9f21-4d5e6a7b8c9d',
      runId: '018f2c31-7a4e-7c3b-9f21-4d5e6a7b8c9e',
      workOrderId: 'wo_opifex_312_a3f91c2_a1',
      type: 'run.blocked',
      source: 'runner-reported',
      occurredAt: '2026-08-23T12:00:00.000Z',
      blocked: { reason: 'rate-limit' },
    };

    expect(event.blocked?.reason).toBe('rate-limit');
  });

  it('types a work order and a manifest', () => {
    const identity: WorkOrder['identity'] = 'wo_opifex_312_a3f91c2_a1';
    const fidelity: RunnerCapabilityManifest['streamingFidelity'] = 'full';

    expect(identity).toContain('wo_');
    expect(fidelity).toBe('full');
  });
});
