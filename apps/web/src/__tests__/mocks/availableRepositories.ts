/**
 * `GET /api/repositories/available`, in the API's real shape (#401).
 *
 * Read against `apps/api/src/repositories/dto/available-repository.dto.ts` and
 * `available-repositories.service.ts`, not invented:
 *
 *  - a failure is a **200** carrying a `status`, with `repositories: []` — so
 *    nothing in the UI has to tell an HTTP failure apart from a finding;
 *  - the list arrives **pre-sorted** — addable, then already registered, then
 *    archived, most recently pushed first within each group — and that order
 *    is what the component renders, so the fixture is written in it rather
 *    than in a tidier one;
 *  - `repositoryId` is a uuid on a `registered` row and null everywhere else,
 *    which is what lets the picker link to an existing registration;
 *  - `total` counts the search matches and `reachable` counts what the token
 *    sees BEFORE the search, so the two are separate numbers here as well;
 *  - `detail` is the service's own sentence, redacted the way the API redacts
 *    it — a handler that echoed the request back would let the component be
 *    written against a shape the API never produces.
 */

import type {
  AvailableRepositories,
  AvailableRepository,
  AvailableRepositoryStatus,
} from '../../types/repositories';

/** The uuid the registered row points at. Matches `registeredRepository()`. */
export const REGISTERED_ID = '11111111-2222-4333-8444-555555555555';

export function availableRepository(
  overrides: Partial<AvailableRepository> = {},
): AvailableRepository {
  const owner = overrides.owner ?? 'acme';
  const name = overrides.name ?? 'widgets';

  return {
    description: 'The widget service.',
    defaultBranch: 'main',
    private: false,
    archived: false,
    pushedAt: '2026-08-20T09:00:00.000Z',
    admission: 'available',
    repositoryId: null,
    ...overrides,
    owner,
    name,
    // Derived from the two above rather than spread in: a test that overrides
    // `name` means the full name too, and the API never disagrees with itself
    // about which repository a row is.
    fullName: overrides.fullName ?? `${owner}/${name}`,
  };
}

/**
 * The three admissions, in the API's order.
 *
 * `gadgets` is addable, `sprockets` is already registered, `legacy` is
 * archived. Written in that order so a test asserting the rendered order is
 * asserting that nothing re-sorted the API's answer.
 */
export const THREE_ADMISSIONS: AvailableRepository[] = [
  availableRepository({
    name: 'gadgets',
    description: 'Addable right now.',
    pushedAt: '2026-08-22T09:00:00.000Z',
  }),
  availableRepository({
    name: 'sprockets',
    description: 'Opifex already watches this one.',
    admission: 'registered',
    repositoryId: REGISTERED_ID,
    pushedAt: '2026-08-21T09:00:00.000Z',
  }),
  availableRepository({
    name: 'legacy',
    description: 'Frozen on GitHub.',
    archived: true,
    admission: 'archived',
    pushedAt: '2024-01-04T09:00:00.000Z',
  }),
];

/** A successful listing, with anything a test needs overridden. */
export function availableRepositoriesFixture(
  overrides: Partial<AvailableRepositories> = {},
): AvailableRepositories {
  const repositories = overrides.repositories ?? THREE_ADMISSIONS;

  return {
    status: 'ok',
    detail:
      "The credential reaches 3 repositories — that is the token's scope, " +
      'not everything the account owns. 1 can be registered. 1 already ' +
      'registered and 1 archived are listed marked rather than hidden.',
    repositories,
    page: 1,
    pageSize: 25,
    total: repositories.length,
    totalPages: Math.max(1, Math.ceil(repositories.length / 25)),
    reachable: repositories.length,
    search: null,
    truncated: false,
    checkedAt: '2026-08-27T10:00:00.000Z',
    ...overrides,
  };
}

/**
 * A failure, which on this endpoint is a 200 with an empty list.
 *
 * `detail` is the API's own sentence and is rendered verbatim beside this
 * build's remedy, so the fixture carries a realistic one rather than a
 * placeholder.
 */
export function availableRepositoriesFailure(
  status: AvailableRepositoryStatus,
  detail: string,
): AvailableRepositories {
  return availableRepositoriesFixture({
    status,
    detail,
    repositories: [],
    total: 0,
    totalPages: 0,
    reachable: 0,
  });
}

/**
 * A valid credential scoped to nothing — `status: 'ok'`, `reachable: 0`.
 *
 * The one case that is a SUCCESS and looks like a failure. ADR-0001 chose a
 * fine-grained token that grants access one repository at a time, so this is
 * the scope showing rather than a fault, and the `detail` here is the
 * service's own wording for it.
 */
export function emptyScopeFixture(): AvailableRepositories {
  return availableRepositoriesFixture({
    status: 'ok',
    detail:
      'GitHub accepted the credential and it reaches no repositories at ' +
      'all. The token works; its scope covers nothing. Opifex uses a ' +
      'fine-grained personal access token (ADR-0001), which grants access ' +
      "one repository at a time — so add repositories to the token's " +
      'Repository access and list again.',
    repositories: [],
    total: 0,
    totalPages: 0,
    reachable: 0,
  });
}
