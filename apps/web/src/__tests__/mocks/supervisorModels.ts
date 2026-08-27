/**
 * `GET /api/operator-settings/supervisor-models`, in the API's real shape
 * (#394, epic #391).
 *
 * Read against
 * `apps/api/src/settings/operator-settings/dto/supervisor-model-catalog.dto.ts`
 * and `supervisor/invocation/model-catalog.service.ts`, not invented:
 *
 *  - a failure is a **200** carrying a `status`, with `models: []` — never an
 *    error status, so nothing in the UI has to tell an HTTP failure apart from
 *    a finding;
 *  - the list arrives **pre-sorted** — admitted, then `version_unrecognised`,
 *    then `below_threshold` — and that order is what the component renders, so
 *    the fixture is written in it rather than in a tidier one;
 *  - `displayName` is null on OpenAI, which publishes none, and a real label
 *    on Anthropic;
 *  - `createdAt` is ISO-8601 on both, normalised by the API from Unix seconds
 *    on one of them;
 *  - `spendsTokens` is `false` and is a FIELD, so a test can flip it and
 *    assert the UI followed the response rather than a hard-coded sentence.
 */

import type {
  CatalogModel,
  SupervisorModelCatalog,
} from '../../types/supervisorModels';

/** The Anthropic catalogue, in the API's order. */
export const ANTHROPIC_MODELS: CatalogModel[] = [
  {
    id: 'claude-opus-4-6',
    displayName: 'Claude Opus 4.6',
    version: '4.6',
    admission: 'admitted',
    createdAt: '2026-02-19T00:00:00.000Z',
  },
  {
    id: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    version: '4.6',
    admission: 'admitted',
    createdAt: '2026-01-05T00:00:00.000Z',
  },
  {
    // The one the whole fail-open decision exists for: an id this build's
    // naming rule could not read, which is most likely a model NEWER than the
    // rule. It sits second in the API's order for exactly that reason.
    id: 'claude-daybreak-latest',
    displayName: 'Claude Daybreak',
    version: null,
    admission: 'version_unrecognised',
    createdAt: '2026-06-01T00:00:00.000Z',
  },
  {
    id: 'claude-sonnet-4-5',
    displayName: 'Claude Sonnet 4.5',
    version: '4.5',
    admission: 'below_threshold',
    createdAt: '2025-09-29T00:00:00.000Z',
  },
];

/** The OpenAI catalogue. No display names — the vendor publishes none. */
export const OPENAI_MODELS: CatalogModel[] = [
  {
    id: 'gpt-5.4',
    displayName: null,
    version: '5.4',
    admission: 'admitted',
    createdAt: '2026-02-19T00:00:00.000Z',
  },
  {
    id: 'o5-preview',
    displayName: null,
    version: null,
    admission: 'version_unrecognised',
    createdAt: '2026-05-02T00:00:00.000Z',
  },
  {
    id: 'gpt-4.1',
    displayName: null,
    version: '4.1',
    admission: 'below_threshold',
    createdAt: '2025-04-14T00:00:00.000Z',
  },
];

/** A successful Anthropic listing, with anything a test needs overridden. */
export function supervisorModelCatalogFixture(
  overrides: Partial<SupervisorModelCatalog> = {},
): SupervisorModelCatalog {
  return {
    provider: 'anthropic',
    status: 'ok',
    detail: 'Anthropic listed 4 models; 2 are at or above the 4.6 floor.',
    minimumVersion: '4.6',
    spendsTokens: false,
    models: ANTHROPIC_MODELS,
    checkedAt: '2026-08-27T10:00:00.000Z',
    ...overrides,
  };
}

/**
 * A failure, which on this endpoint is a 200 with an empty list.
 *
 * `detail` is the API's own sentence and is rendered verbatim beside this
 * build's remedy, so the fixture carries a realistic one rather than a
 * placeholder — a handler that echoed the request back would let the component
 * be written against a shape the API never produces.
 */
export function supervisorModelFailureFixture(
  status: SupervisorModelCatalog['status'],
  detail: string,
  overrides: Partial<SupervisorModelCatalog> = {},
): SupervisorModelCatalog {
  return supervisorModelCatalogFixture({
    status,
    detail,
    models: [],
    ...overrides,
  });
}
