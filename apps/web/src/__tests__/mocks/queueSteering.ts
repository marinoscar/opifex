/**
 * `POST /queue/:id/hold` and `/release`, as the API really answers them.
 *
 * Built from `QueueSteerResult` — the same type `services/api.ts` declares —
 * and covered by `tsconfig.fixtures.json`, so a rename on the wire shape
 * breaks the build rather than leaving a green suite asserting against a
 * response nothing serves (#415, #417).
 *
 * The two fields that matter are the two `QueueSteeringService` deliberately
 * keeps apart:
 *
 *  - `labelWritten` — whether the label REACHED GitHub. False when
 *    `github.writesEnabled` is off, on an otherwise ordinary 200.
 *  - `reconciled` — always false. The label is the request; a later tick acts
 *    on it.
 *
 * `workOrderId` is the database row id and `identity` is the `wo_…` string the
 * queue renders. They differ on purpose: the endpoint takes either and answers
 * with both, and a test that made them equal would hide which one the UI keys
 * its selection on.
 */

import type { QueueSteerResult } from '../../services/api';

export const STEER_EFFECT =
  'The label is the request. It takes effect on the next reconciler tick.';

export function steerResultFixture(
  overrides: Partial<QueueSteerResult> = {},
): QueueSteerResult {
  return {
    workOrderId: 'cmg2k4l8p0001qwer0000abcd',
    identity: 'wo_opifex_401_b7c2d10_a1',
    label: 'factory:ready',
    labelWritten: true,
    reconciled: false,
    effect: STEER_EFFECT,
    ...overrides,
  };
}

/** The shape a deployment with `github.writesEnabled: false` answers with. */
export function suppressedSteerResultFixture(
  overrides: Partial<QueueSteerResult> = {},
): QueueSteerResult {
  return steerResultFixture({ labelWritten: false, ...overrides });
}
