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
 *    `github.writesEnabled` is off, on the same `202` as any other answer.
 *  - `reconciled` — always false. The label is the request; a later tick acts
 *    on it.
 *
 * `workOrderId` is the database row id and `identity` is the `wo_…` string the
 * queue renders. They differ on purpose: the endpoint takes either and answers
 * with both, and a test that made them equal would hide which one the UI keys
 * its selection on.
 */

import { HttpResponse } from 'msw';

import type { QueueSteerResult } from '../../services/api';

/**
 * The status both steer endpoints really answer with.
 *
 * `queue.controller.ts` puts `@HttpCode(HttpStatus.ACCEPTED)` on `hold` and on
 * `release`, and both `@ApiResponse` annotations say 202;
 * `TransformInterceptor` wraps the body and leaves the status alone. It is 202
 * rather than 200 for the reason the whole feature turns on: the label is a
 * REQUEST that a later reconciler tick acts on, so the work is accepted and
 * not done.
 *
 * Kept here rather than in each handler so no test can quietly go back to
 * MSW's 200 default — which is what a `HttpResponse.json(...)` with no status
 * sends, and which is a status this server never returns.
 */
export const STEER_ACCEPTED = 202;

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

/**
 * One steer endpoint's whole answer: the 202 and the envelope together.
 *
 * `TransformInterceptor` wraps every payload as `{ data }`, so the fixture
 * does too — a handler returning the bare result would be testing a shape the
 * API does not serve.
 */
export function steerResponse(overrides: Partial<QueueSteerResult> = {}) {
  return HttpResponse.json(
    { data: steerResultFixture(overrides) },
    { status: STEER_ACCEPTED },
  );
}
