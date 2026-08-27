/**
 * Repository and project rows in the API's own serialisation (#404, #405,
 * #406).
 *
 * Written against `apps/api/src/repositories/dto/repository.dto.ts` and
 * `apps/api/src/projects/dto/project.dto.ts`, not against what the UI happens
 * to read. Two details are load-bearing and are the reason this file exists
 * rather than each test building its own object:
 *
 *  - **`retiredAt` and `retiredById` are present and null**, never absent. The
 *    fields are required-and-nullable on the wire. A fixture that omitted them
 *    would make `retiredAt !== null` true for `undefined`, and every card in
 *    every test would silently render as retired — a fixture bug that would
 *    look like a component bug.
 *  - **`budgetCeilingUsd` is a STRING or null.** The column is a Postgres
 *    `DECIMAL` and the API refuses to round it through a JS number, so a
 *    fixture using `50` would test a shape the API never sends.
 *
 * The ids are real v4 UUIDs because the API's own schemas are `z.uuid()`, and
 * a fixture id that zod would reject is a fixture that can never travel the
 * path being asserted.
 */

import type { RepositorySummary } from '../../types/cockpit';
import type { Project } from '../../types/projects';

export const REPOSITORY_ID = '11111111-1111-4111-8111-111111111111';
export const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
export const OTHER_PROJECT_ID = '33333333-3333-4333-8333-333333333333';

export function repositoryFixture(
  overrides: Partial<RepositorySummary> = {},
): RepositorySummary {
  return {
    id: REPOSITORY_ID,
    projectId: null,
    owner: 'acme',
    name: 'widgets',
    fullName: 'acme/widgets',
    defaultBranch: 'main',
    observeEnabled: false,
    dispatchEnabled: false,
    mirrorLabelsEnabled: false,
    specFeedbackEnabled: false,
    budgetCeilingUsd: null,
    wallClockTimeoutMinutes: null,
    pathConstraints: [],
    lastObservedAt: null,
    retiredAt: null,
    retiredById: null,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
    ...overrides,
  };
}

export function projectFixture(overrides: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID,
    slug: 'billing-platform',
    name: 'Billing Platform',
    description: 'Everything that takes money.',
    repositoryCount: 0,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
    ...overrides,
  };
}
